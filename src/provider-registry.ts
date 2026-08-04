/**
 * Provider registry and dispatch: the single ordered list of supported
 * provider adapters, and the routing of the active provider to its adapter.
 *
 * Each adapter contributes one descriptor — id, display label, fetch
 * behavior, and unavailable-snapshot behavior — behind a shared dependencies
 * shape. Everything that enumerates providers derives from this list, so
 * adding a provider means registering one descriptor here. This module also
 * owns the narrow structural seam over the Pi host shared by the lifecycle
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
  ProviderAdapterDeps,
  QuotaSnapshot,
  ResolvedProviderAuth,
  UnavailableReason,
} from "./quota-contract.ts";
import type { NowSeconds } from "./quota-time.ts";

/** A provider's quota behavior behind one descriptor. */
export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  fetch(deps: ProviderAdapterDeps): Promise<QuotaSnapshot>;
  unavailable(reason: UnavailableReason, fetchedAtSeconds: number): QuotaSnapshot;
}

/** Stable display order for the integrations supported by pi-quota. */
export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  {
    id: CODEX_PROVIDER,
    label: "OpenAI Codex",
    fetch: fetchCodexQuotaSnapshot,
    unavailable: unavailableCodexQuotaSnapshot,
  },
  {
    id: KIMI_PROVIDER,
    label: "Kimi For Coding",
    fetch: fetchKimiQuotaSnapshot,
    unavailable: unavailableKimiQuotaSnapshot,
  },
  {
    id: ZAI_PROVIDER,
    label: "Z.AI",
    fetch: fetchZaiQuotaSnapshot,
    unavailable: unavailableZaiQuotaSnapshot,
  },
];

const adaptersById = new Map(PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter]));

/** Looks up the adapter for a provider id; undefined when unsupported. */
export function providerAdapter(id: string | undefined): ProviderAdapter | undefined {
  return id === undefined ? undefined : adaptersById.get(id);
}

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
  return providerAdapter(provider) !== undefined;
}

export function unavailableProviderQuotaSnapshot(
  provider: string,
  reason: UnavailableReason,
  fetchedAtSeconds: number,
): QuotaSnapshot | undefined {
  return providerAdapter(provider)?.unavailable(reason, fetchedAtSeconds);
}

export async function fetchProviderQuotaSnapshot(
  host: ProviderStatusHost,
  deps: ProviderStatusDeps,
  signal: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
  const adapter = providerAdapter(host.provider);
  if (adapter === undefined) return undefined;

  const resolveAuth = async () => {
    const auth = await host.resolveAuth(adapter.id);
    return auth === undefined
      ? undefined
      : { ...auth, baseUrl: auth.baseUrl ?? host.providerBaseUrl };
  };
  return adapter.fetch({
    providerBaseUrl: host.providerBaseUrl,
    resolveAuth,
    fetchFn: deps.fetchFn,
    nowSeconds: deps.nowSeconds,
    signal,
  });
}
