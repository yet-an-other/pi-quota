/**
 * Global Z.AI provider adapter.
 *
 * The first-party monitor endpoint and payload are undocumented. The adapter
 * therefore exposes validated values only as quota telemetry with explicitly
 * unknown semantics; it never derives quota windows, remaining capacity, or
 * reset times.
 */

import {
  asFiniteNumber,
  isRecord,
  type ProviderAdapterDeps,
  type QuotaSnapshot,
  type QuotaSourceMeta,
  type QuotaTelemetry,
  type ResolvedProviderAuth,
  type UnavailableReason,
} from "../quota-contract.ts";

export const ZAI_PROVIDER = "zai";

const ZAI_ORIGIN = "https://api.z.ai";
const USAGE_URL = `${ZAI_ORIGIN}/api/monitor/usage/quota/limit`;
const DETAIL_URL = "https://z.ai/manage-apikey/subscription";

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

function validatedPercentage(value: unknown): number | undefined {
  const percentage = asFiniteNumber(value);
  return percentage !== undefined && percentage >= 0 && percentage <= 100
    ? percentage
    : undefined;
}

function validatedCounter(value: unknown): number | undefined {
  const counter = asFiniteNumber(value);
  return counter !== undefined && counter >= 0 ? counter : undefined;
}

function parseTelemetry(value: unknown): QuotaTelemetry | undefined {
  if (!isRecord(value)) return undefined;

  const type = value["type"];
  if (type !== "TOKENS_LIMIT" && type !== "TIME_LIMIT") return undefined;

  const percent = validatedPercentage(value["percentage"]);
  const currentValue = validatedCounter(value["currentValue"]);
  const usage = validatedCounter(value["usage"]);
  const counters = {
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(usage === undefined ? {} : { usage }),
  };
  if (percent === undefined && Object.keys(counters).length === 0) return undefined;

  const tokenTelemetry = type === "TOKENS_LIMIT";
  return {
    id: tokenTelemetry ? "zai-tokens-limit" : "zai-time-limit",
    providerLabel: tokenTelemetry ? "Z.AI token telemetry" : "Z.AI time telemetry",
    ...(percent === undefined ? {} : { percent }),
    ...(Object.keys(counters).length === 0 ? {} : { counters }),
    semantics: "unknown",
  };
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string | null>> | undefined): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) => name.toLowerCase() === "authorization" && typeof value === "string" && value.trim() !== "",
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
  const source = zaiQuotaSource(deps.nowSeconds());
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
  // Pi's built-in global provider resolves a raw API key. An authorization
  // header leaves the monitor endpoint's undocumented auth convention
  // ambiguous, so never guess or cycle credential formats.
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

  if (response.status === 401 || response.status === 403) return unavailable("ambiguous");
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

  const limits = body["data"]["limits"];
  const knownTypes = limits.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const type = entry["type"];
    return type === "TOKENS_LIMIT" || type === "TIME_LIMIT" ? [type] : [];
  });
  if (new Set(knownTypes).size !== knownTypes.length) return unavailable("ambiguous");

  const telemetry = limits.map(parseTelemetry).filter((item) => item !== undefined);
  if (telemetry.length === 0) return unavailable("schema-drift");

  return { status: "degraded", provider: ZAI_PROVIDER, telemetry, source };
}
