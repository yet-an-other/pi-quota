/**
 * OpenAI Codex provider adapter.
 *
 * Resolves Pi's `openai-codex` OAuth credential at fetch time, derives the
 * ChatGPT account identifier locally from the token, and sends the credential
 * only to the verified built-in ChatGPT backend origin. Credentials are never
 * stored, logged, or rendered.
 *
 * The usage endpoint is first-party but undocumented: parsing is tolerant,
 * invalid windows are dropped, and missing values remain unknown. Expected
 * operational failures return an unavailable quota snapshot with a sanitized
 * reason; throws are reserved for programmer defects.
 */

import { Buffer } from "node:buffer";
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

export const CODEX_PROVIDER = "openai-codex";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const USAGE_URL = `${CHATGPT_ORIGIN}/backend-api/wham/usage`;
const DETAIL_URL = "https://chatgpt.com/codex/settings/usage";

function codexQuotaSource(fetchedAtSeconds: number): QuotaSourceMeta {
  return {
    kind: "first-party-private",
    detailUrl: DETAIL_URL,
    fetchedAtSeconds,
  };
}

export function unavailableCodexQuotaSnapshot(
  reason: UnavailableReason,
  fetchedAtSeconds: number,
): QuotaSnapshot {
  return {
    status: "unavailable",
    provider: CODEX_PROVIDER,
    reason,
    source: codexQuotaSource(fetchedAtSeconds),
  };
}

/** Derives the ChatGPT account identifier locally from the OAuth token. */
export function deriveChatGptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(payload)) return undefined;
    const claims = payload["https://api.openai.com/auth"];
    if (!isRecord(claims)) return undefined;
    const accountId = claims["chatgpt_account_id"];
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function parseWindow(
  key: "primary" | "secondary",
  value: unknown,
  nowSeconds: number,
  blocked: boolean | undefined,
): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;

  const usedPercent = asFiniteNumber(value["used_percent"]);
  if (usedPercent === undefined) return undefined;

  const duration = asFiniteNumber(value["limit_window_seconds"]);
  const durationSeconds = duration !== undefined && duration > 0 ? duration : undefined;

  const resetAt = asFiniteNumber(value["reset_at"]);
  const resetAfter = asFiniteNumber(value["reset_after_seconds"]);
  const resetAtSeconds =
    resetAt !== undefined && resetAt > 0
      ? resetAt
      : resetAfter !== undefined && resetAfter >= 0
        ? nowSeconds + resetAfter
        : undefined;

  return {
    id: `codex-${key}`,
    // Label from the provider-reported duration; otherwise the payload bucket
    // key — never an invented duration.
    label: durationSeconds !== undefined ? formatWindowDuration(durationSeconds) : key,
    remainingPercent: clampRemainingPercent(usedPercent),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(resetAtSeconds !== undefined ? { resetAtSeconds } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  };
}

export async function fetchCodexQuotaSnapshot(deps: ProviderAdapterDeps): Promise<QuotaSnapshot> {
  const nowSeconds = deps.nowSeconds();
  const source = codexQuotaSource(nowSeconds);
  const unavailable = (reason: UnavailableReason) =>
    unavailableCodexQuotaSnapshot(reason, nowSeconds);

  let auth: ResolvedProviderAuth | undefined;
  try {
    auth = await deps.resolveAuth();
  } catch {
    return unavailable("auth-unavailable");
  }
  if (!auth?.apiKey) return unavailable("auth-unavailable");
  if (!auth.baseUrl) return unavailable("unsupported");

  let origin: string;
  try {
    origin = new URL(auth.baseUrl).origin;
  } catch {
    return unavailable("unsupported");
  }
  if (origin !== CHATGPT_ORIGIN) return unavailable("unsupported");

  const accountId = deriveChatGptAccountId(auth.apiKey);
  if (accountId === undefined) return unavailable("auth-unavailable");

  let response: Response;
  try {
    response = await deps.fetchFn(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        "ChatGPT-Account-ID": accountId,
      },
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
  if (!isRecord(body) || !isRecord(body["rate_limit"])) return unavailable("schema-drift");

  const rateLimit = body["rate_limit"];
  const limitReached = rateLimit["limit_reached"];
  const blocked = typeof limitReached === "boolean" ? limitReached : undefined;

  const windows = [
    parseWindow("primary", rateLimit["primary_window"], nowSeconds, blocked),
    parseWindow("secondary", rateLimit["secondary_window"], nowSeconds, blocked),
  ].filter((quotaWindow) => quotaWindow !== undefined);

  if (windows.length === 0) return unavailable("schema-drift");

  return { status: "available", provider: CODEX_PROVIDER, windows, source };
}
