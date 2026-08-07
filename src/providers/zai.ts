/**
 * Global Z.AI provider adapter.
 *
 * Resolves Pi's `zai` credential at fetch time and performs one read-only
 * request against Z.AI's first-party monitor endpoint. The endpoint is
 * undocumented and internally owned — it is absent from Z.AI's public API
 * reference and is reached via the official Z.AI coding plugin — so the source
 * stays first-party-private and the payload may change without notice. Parsing
 * is tolerant: invalid values are dropped and missing values remain unknown,
 * never zero.
 *
 * Field semantics are validated against first-party code and live response
 * samples: `percentage` is the used percent, `usage` is the window capacity,
 * `currentValue` is the used amount, and `nextResetTime` is Unix epoch
 * milliseconds. Window-duration codes are only partly verified, so
 * `durationSeconds` is derived solely for the first-party-confirmed codes.
 */

import {
  asFiniteNumber,
  clampRemainingPercent,
  isRecord,
  type ProviderAdapterDeps,
  type QuotaSnapshot,
  type QuotaSourceMeta,
  type QuotaWindow,
  type ResolvedProviderAuth,
  type UnavailableReason,
} from "../quota-contract.ts";
import { formatWindowDuration } from "../quota-time.ts";

export const ZAI_PROVIDER = "zai";

const ZAI_ORIGIN = "https://api.z.ai";
const USAGE_URL = `${ZAI_ORIGIN}/api/monitor/usage/quota/limit`;
const DETAIL_URL = "https://z.ai/manage-apikey/subscription";

/** Plausible-reset horizon: comfortably covers monthly windows, rejects garbage. */
const RESET_HORIZON_SECONDS = 60 * 24 * 60 * 60;

/**
 * Window-duration codes mapped to per-unit second counts. `unit` 3 is an hour
 * and `unit` 5 is a month (30-day approximation), both confirmed by the
 * official Z.AI coding plugin's labels. `unit` 6 is a week, confirmed against
 * a live account (a number-1 window whose reset lands ~7 days out). Other
 * codes contribute no `durationSeconds` and fall back to a type-based label.
 */
const UNIT_SECONDS: Readonly<Record<number, number>> = {
  3: 3600,
  5: 30 * 86400,
  6: 7 * 86400,
};

function zaiQuotaSource(fetchedAtSeconds: number): QuotaSourceMeta {
  return {
    kind: "first-party-private",
    detailUrl: DETAIL_URL,
    fetchedAtSeconds,
  };
}

export function unavailableZaiQuotaSnapshot(
  reason: UnavailableReason,
  fetchedAtSeconds: number,
): QuotaSnapshot {
  return {
    status: "unavailable",
    provider: ZAI_PROVIDER,
    reason,
    source: zaiQuotaSource(fetchedAtSeconds),
  };
}

/**
 * Stable window identifier keyed on the distinguishing fields, with the
 * reset time as a tie-breaker so two windows that share type/unit/number but
 * reset at different times are kept apart rather than collapsed.
 */
function windowId(type: string, entry: Record<string, unknown>): string {
  const unit = asFiniteNumber(entry["unit"]);
  const count = asFiniteNumber(entry["number"]);
  const resetMs = asFiniteNumber(entry["nextResetTime"]);
  return `zai-${type}-${unit ?? "?"}-${count ?? "?"}-${resetMs ?? "?"}`;
}

/**
 * Derives remaining percent from `percentage` (the used percent). Falls back to
 * `currentValue` / `usage` when `percentage` is absent and `usage` is positive.
 */
function deriveRemainingPercent(entry: Record<string, unknown>): number | undefined {
  const usedPercent = asFiniteNumber(entry["percentage"]);
  if (usedPercent !== undefined) return clampRemainingPercent(usedPercent);

  const usage = asFiniteNumber(entry["usage"]);
  const currentValue = asFiniteNumber(entry["currentValue"]);
  if (
    usage === undefined ||
    usage <= 0 ||
    currentValue === undefined ||
    currentValue < 0
  ) {
    return undefined;
  }
  return clampRemainingPercent((currentValue / usage) * 100);
}

/** Derives reset seconds from `nextResetTime` only when it is a plausible future. */
function deriveResetAtSeconds(
  entry: Record<string, unknown>,
  nowSeconds: number,
): number | undefined {
  const milliseconds = asFiniteNumber(entry["nextResetTime"]);
  if (milliseconds === undefined) return undefined;
  const seconds = milliseconds / 1000;
  if (!Number.isFinite(seconds) || seconds <= nowSeconds) return undefined;
  if (seconds > nowSeconds + RESET_HORIZON_SECONDS) return undefined;
  return seconds;
}

/** Derives duration seconds for first-party-confirmed `unit` codes only. */
function deriveDurationSeconds(entry: Record<string, unknown>): number | undefined {
  const unit = asFiniteNumber(entry["unit"]);
  const count = asFiniteNumber(entry["number"]);
  if (
    unit === undefined ||
    count === undefined ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    return undefined;
  }
  const perUnit = UNIT_SECONDS[unit];
  if (perUnit === undefined) return undefined;
  const seconds = perUnit * count;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

const TYPE_FALLBACK_LABELS: Readonly<Record<string, string>> = {
  CREDIT_LIMIT: "credits",
  TOKENS_LIMIT: "tokens",
  TIME_LIMIT: "tools",
};

/** Label for a window whose duration code is unknown, derived from its type. */
function typeFallbackLabel(type: string): string {
  return TYPE_FALLBACK_LABELS[type] ?? type.toLowerCase().replace("_limit", "");
}

function parseWindow(entry: unknown, nowSeconds: number): QuotaWindow | undefined {
  if (!isRecord(entry)) return undefined;
  const type = entry["type"];
  // The type string only labels the window; any type with derivable quota
  // values is accepted. Accounts report CREDIT_LIMIT, TOKENS_LIMIT, TIME_LIMIT,
  // and more, so an unrecognized type must never suppress the footer.
  if (typeof type !== "string" || type === "") return undefined;

  const remainingPercent = deriveRemainingPercent(entry);
  if (remainingPercent === undefined) return undefined;

  const durationSeconds = deriveDurationSeconds(entry);
  const resetAtSeconds = deriveResetAtSeconds(entry, nowSeconds);
  const label =
    durationSeconds !== undefined
      ? formatWindowDuration(durationSeconds)
      : typeFallbackLabel(type);

  return {
    id: windowId(type, entry),
    label,
    remainingPercent,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(resetAtSeconds === undefined ? {} : { resetAtSeconds }),
  };
}

function hasAuthorizationHeader(
  headers: Readonly<Record<string, string | null>> | undefined,
): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === "authorization" &&
      typeof value === "string" &&
      value.trim() !== "",
  );
}

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export async function fetchZaiQuotaSnapshot(deps: ProviderAdapterDeps): Promise<QuotaSnapshot> {
  const nowSeconds = deps.nowSeconds();
  const source = zaiQuotaSource(nowSeconds);
  const unavailable = (reason: UnavailableReason) =>
    unavailableZaiQuotaSnapshot(reason, source.fetchedAtSeconds);

  if (originOf(deps.providerBaseUrl) !== ZAI_ORIGIN) return unavailable("unsupported");

  let auth: ResolvedProviderAuth | undefined;
  try {
    auth = await deps.resolveAuth();
  } catch {
    return unavailable("auth-unavailable");
  }
  if (auth === undefined) return unavailable("auth-unavailable");
  // The monitor endpoint takes the raw token verbatim with no Bearer prefix,
  // matching the official Z.AI coding plugin; Pi's built-in global provider
  // resolves exactly such a raw API key. A pre-attached Authorization header
  // would be in an unknown format that need not match the monitor convention,
  // so refuse it rather than guessing or cycling credential formats.
  if (hasAuthorizationHeader(auth.headers)) return unavailable("ambiguous");
  if (typeof auth.apiKey !== "string" || auth.apiKey.trim() === "") {
    return unavailable("auth-unavailable");
  }
  if (auth.baseUrl !== undefined && originOf(auth.baseUrl) !== ZAI_ORIGIN) {
    return unavailable("unsupported");
  }

  let response: Response;
  try {
    response = await deps.fetchFn(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: auth.apiKey,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: deps.signal,
    });
  } catch {
    return unavailable("transient");
  }

  if (response.status === 401 || response.status === 403) return unavailable("auth-required");
  if (response.status === 404) return unavailable("unsupported");
  if (!response.ok) return unavailable("transient");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailable("schema-drift");
  }
  if (!isRecord(body) || !isRecord(body["data"]) || !Array.isArray(body["data"]["limits"])) {
    return unavailable("schema-drift");
  }

  const windows: QuotaWindow[] = [];
  const seenIds = new Set<string>();
  body["data"]["limits"].forEach((entry) => {
    const quotaWindow = parseWindow(entry, nowSeconds);
    if (quotaWindow === undefined) return;
    if (seenIds.has(quotaWindow.id)) return; // dedupe identical windows
    seenIds.add(quotaWindow.id);
    windows.push(quotaWindow);
  });
  if (windows.length === 0) return unavailable("schema-drift");

  return { status: "available", provider: ZAI_PROVIDER, windows, source };
}
