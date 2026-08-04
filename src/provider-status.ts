/**
 * Provider status dispatch: routes supported providers to their adapters.
 * Owns the narrow structural seam over the Pi host shared by the lifecycle
 * and the status presenter. Scheduling and state live in the quota lifecycle
 * module; provider-specific endpoint behavior stays in adapters; host
 * presentation lives in the status presenter.
 */

import {
  CODEX_PROVIDER,
  fetchCodexQuotaSnapshot,
  unavailableCodexQuotaSnapshot,
} from "./providers/codex.ts";
import {
  fetchKimiQuotaSnapshot,
  KIMI_PROVIDER,
  unavailableKimiQuotaSnapshot,
} from "./providers/kimi.ts";
import {
  fetchZaiQuotaSnapshot,
  unavailableZaiQuotaSnapshot,
  ZAI_PROVIDER,
} from "./providers/zai.ts";
import type {
  QuotaSnapshot,
  ResolvedProviderAuth,
  UnavailableReason,
} from "./quota-contract.ts";
import type { NowSeconds } from "./quota-time.ts";

/** Narrow structural seam over the Pi host so tests can mock it. */
export interface ProviderStatusHost {
  readonly mode: string;
  readonly provider: string | undefined;
  /** Effective base URL of the active model, supplied by Pi. */
  readonly providerBaseUrl: string | undefined;
  readonly ui: {
    setStatus(id: string, text: string | undefined): void;
  };
  readonly theme: {
    fg(color: string, text: string): string;
  };
  resolveAuth(provider: string): Promise<ResolvedProviderAuth | undefined>;
}

export interface ProviderStatusDeps {
  readonly fetchFn: typeof fetch;
  readonly nowSeconds: NowSeconds;
}

export function isSupportedProvider(provider: string | undefined): provider is string {
  return provider === CODEX_PROVIDER || provider === KIMI_PROVIDER || provider === ZAI_PROVIDER;
}

export function unavailableProviderQuotaSnapshot(
  provider: string,
  reason: UnavailableReason,
  fetchedAtSeconds: number,
): QuotaSnapshot | undefined {
  return provider === CODEX_PROVIDER
    ? unavailableCodexQuotaSnapshot(reason, fetchedAtSeconds)
    : provider === KIMI_PROVIDER
      ? unavailableKimiQuotaSnapshot(reason, fetchedAtSeconds)
      : provider === ZAI_PROVIDER
        ? unavailableZaiQuotaSnapshot(reason, fetchedAtSeconds)
        : undefined;
}

export async function fetchProviderQuotaSnapshot(
  host: ProviderStatusHost,
  deps: ProviderStatusDeps,
  signal: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
  const provider = host.provider;
  if (!isSupportedProvider(provider)) return undefined;

  const resolveAuth = async () => {
    const auth = await host.resolveAuth(provider);
    return auth === undefined
      ? undefined
      : { ...auth, baseUrl: auth.baseUrl ?? host.providerBaseUrl };
  };
  const adapterDeps = {
    resolveAuth,
    fetchFn: deps.fetchFn,
    nowSeconds: deps.nowSeconds,
    signal,
  };

  return provider === CODEX_PROVIDER
    ? fetchCodexQuotaSnapshot(adapterDeps)
    : provider === KIMI_PROVIDER
      ? fetchKimiQuotaSnapshot(adapterDeps)
      : fetchZaiQuotaSnapshot({ ...adapterDeps, providerBaseUrl: host.providerBaseUrl });
}
