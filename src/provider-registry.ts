/**
 * Provider registry and dispatch: the single ordered list of supported
 * provider adapters, and the routing of the active provider to its adapter.
 *
 * Each adapter contributes one descriptor — id, display label, fetch
 * behavior, and unavailable-snapshot behavior — behind a shared dependencies
 * shape. Everything that enumerates providers derives from this list, so
 * adding a provider means registering one descriptor here. The Pi host seam
 * itself lives in the quota-host module; this module consumes it for fetch
 * dispatch. Scheduling and state live in the quota lifecycle module;
 * provider-specific endpoint behavior stays in adapters; host presentation
 * lives in the status presenter.
 */

import { CODEX_PROVIDER, CODEX_SOURCE, fetchCodexQuotaSnapshot } from "./providers/codex.ts";
import { fetchKimiQuotaSnapshot, KIMI_PROVIDER, KIMI_SOURCE } from "./providers/kimi.ts";
import { fetchZaiQuotaSnapshot, ZAI_PROVIDER, ZAI_SOURCE } from "./providers/zai.ts";
import {
  unavailableSnapshot,
  type ProviderAdapterDeps,
  type QuotaSourceClassification,
  type QuotaSnapshot,
  type UnavailableReason,
} from "./quota-contract.ts";
import type { NowSeconds } from "./quota-time.ts";
import type { QuotaHost } from "./quota-host.ts";

/** A provider's quota behavior behind one descriptor. */
export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  /** Static source identity used to build this provider's quota source meta and unavailable snapshots. */
  readonly source: QuotaSourceClassification;
  fetch(deps: ProviderAdapterDeps): Promise<QuotaSnapshot>;
}

/** Stable display order for the integrations supported by pi-quota. */
export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  {
    id: CODEX_PROVIDER,
    label: "OpenAI Codex",
    source: CODEX_SOURCE,
    fetch: fetchCodexQuotaSnapshot,
  },
  {
    id: KIMI_PROVIDER,
    label: "Kimi For Coding",
    source: KIMI_SOURCE,
    fetch: fetchKimiQuotaSnapshot,
  },
  {
    id: ZAI_PROVIDER,
    label: "Z.AI",
    source: ZAI_SOURCE,
    fetch: fetchZaiQuotaSnapshot,
  },
];

const adaptersById = new Map(PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter]));

/** Looks up the adapter for a provider id; undefined when unsupported. */
export function providerAdapter(id: string | undefined): ProviderAdapter | undefined {
  return id === undefined ? undefined : adaptersById.get(id);
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
  const adapter = providerAdapter(provider);
  return adapter === undefined
    ? undefined
    : unavailableSnapshot(adapter.id, adapter.source, reason, fetchedAtSeconds);
}

export async function fetchProviderQuotaSnapshot(
  host: QuotaHost,
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
