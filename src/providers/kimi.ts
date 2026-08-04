/**
 * Kimi For Coding provider adapter.
 *
 * Resolves Pi's `kimi-coding` credential at fetch time and performs one
 * read-only usages request. The source is first-party but experimental:
 * parse defensively, drop invalid windows, and return sanitized unavailable
 * quota snapshots rather than inventing zero.
 */

import {
  asFiniteNumber,
  isRecord,
  type ProviderAdapterDeps,
  type QuotaSnapshot,
  type QuotaSourceMeta,
  type QuotaWindow,
  type ResolvedProviderAuth,
  type UnavailableReason,
} from "../quota-contract.ts";
import { formatWindowDuration } from "../quota-time.ts";

export const KIMI_PROVIDER = "kimi-coding";

const KIMI_ORIGIN = "https://api.kimi.com";
const USAGE_URL = `${KIMI_ORIGIN}/coding/v1/usages`;
const DETAIL_URL = "https://www.kimi.com/code";
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function kimiQuotaSource(fetchedAtSeconds: number): QuotaSourceMeta {
  return {
    kind: "experimental",
    detailUrl: DETAIL_URL,
    fetchedAtSeconds,
  };
}

export function unavailableKimiQuotaSnapshot(
  reason: UnavailableReason,
  fetchedAtSeconds: number,
): QuotaSnapshot {
  return {
    status: "unavailable",
    provider: KIMI_PROVIDER,
    reason,
    source: kimiQuotaSource(fetchedAtSeconds),
  };
}

function nonnegativeDecimal(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function remainingPercent(detail: Record<string, unknown>): number | undefined {
  const limit = nonnegativeDecimal(detail["limit"]);
  if (limit === undefined || limit === 0n) return undefined;

  const providerRemaining = nonnegativeDecimal(detail["remaining"]);
  const used = nonnegativeDecimal(detail["used"]);
  if (providerRemaining === undefined && used === undefined) return undefined;

  const candidate = providerRemaining ?? limit - used!;
  const clamped = candidate < 0n ? 0n : candidate > limit ? limit : candidate;
  // Convert exact integer counters to percentage basis points before Number.
  return Number((clamped * 10_000n + limit / 2n) / limit) / 100;
}

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : undefined;
}

function parseDetail(
  id: string,
  label: string,
  durationSeconds: number,
  value: unknown,
): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = remainingPercent(value);
  if (percent === undefined) return undefined;
  const resetAtSeconds = resetTimestamp(value["resetTime"]);

  return {
    id,
    label,
    remainingPercent: percent,
    durationSeconds,
    ...(resetAtSeconds === undefined ? {} : { resetAtSeconds }),
  };
}

function durationSeconds(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const duration = asFiniteNumber(value["duration"]);
  if (duration === undefined || !Number.isSafeInteger(duration) || duration <= 0) return undefined;

  const multipliers: Readonly<Record<string, number>> = {
    TIME_UNIT_SECOND: 1,
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_HOUR: 3600,
    TIME_UNIT_DAY: 86400,
    TIME_UNIT_WEEK: WEEK_SECONDS,
  };
  const unit = value["timeUnit"];
  if (typeof unit !== "string") return undefined;
  const multiplier = multipliers[unit];
  if (multiplier === undefined) return undefined;

  const seconds = duration * multiplier;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function authorizationHeader(auth: ResolvedProviderAuth): string | undefined {
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (name.toLowerCase() === "authorization" && typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return auth.apiKey ? `Bearer ${auth.apiKey}` : undefined;
}

export async function fetchKimiQuotaSnapshot(deps: ProviderAdapterDeps): Promise<QuotaSnapshot> {
  const nowSeconds = deps.nowSeconds();
  const source = kimiQuotaSource(nowSeconds);
  const unavailable = (reason: UnavailableReason) =>
    unavailableKimiQuotaSnapshot(reason, nowSeconds);

  let auth: ResolvedProviderAuth | undefined;
  try {
    auth = await deps.resolveAuth();
  } catch {
    return unavailable("auth-unavailable");
  }
  if (auth === undefined) return unavailable("auth-unavailable");
  const authorization = authorizationHeader(auth);
  if (authorization === undefined) return unavailable("auth-unavailable");
  if (!auth.baseUrl) return unavailable("unsupported");

  let origin: string;
  try {
    origin = new URL(auth.baseUrl).origin;
  } catch {
    return unavailable("unsupported");
  }
  if (origin !== KIMI_ORIGIN) return unavailable("unsupported");

  let response: Response;
  try {
    response = await deps.fetchFn(USAGE_URL, {
      method: "GET",
      headers: { Authorization: authorization, Accept: "application/json" },
      signal: deps.signal,
    });
  } catch {
    return unavailable("transient");
  }

  if (response.status === 401) return unavailable("auth-required");
  if (response.status === 403) return unavailable("ambiguous");
  if (response.status === 404) return unavailable("unsupported");
  if (!response.ok) return unavailable("transient");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailable("schema-drift");
  }
  if (!isRecord(body)) return unavailable("schema-drift");

  const windows: QuotaWindow[] = [];
  const weekly = parseDetail("kimi-weekly", "7d", WEEK_SECONDS, body["usage"]);
  if (weekly !== undefined) windows.push(weekly);

  const limits = body["limits"];
  if (Array.isArray(limits)) {
    const seenDurations = new Set<number>();
    limits.forEach((entry) => {
      if (!isRecord(entry)) return;
      const seconds = durationSeconds(entry["window"]);
      if (seconds === undefined || seconds >= WEEK_SECONDS || seenDurations.has(seconds)) return;
      const quotaWindow = parseDetail(
        `kimi-limit-${seconds}`,
        formatWindowDuration(seconds),
        seconds,
        entry["detail"],
      );
      if (quotaWindow !== undefined) {
        seenDurations.add(seconds);
        windows.push(quotaWindow);
      }
    });
  }

  if (windows.length === 0) return unavailable("schema-drift");
  return { status: "available", provider: KIMI_PROVIDER, windows, source };
}
