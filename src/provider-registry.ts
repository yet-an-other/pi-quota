/**
 * Provider registry: the single ordered list of supported provider adapters.
 *
 * Each adapter contributes one descriptor — id, display label, fetch
 * behavior, and unavailable-snapshot behavior — behind a shared dependencies
 * shape. Everything that enumerates providers derives from this list, so
 * adding a provider means registering one descriptor here.
 *
 * Expand phase: the dispatch chains in provider-status and the
 * supported-providers list still serve callers until the contract step
 * switches them to this registry and deletes them.
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
  UnavailableReason,
} from "./quota-contract.ts";

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
