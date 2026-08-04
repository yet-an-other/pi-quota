/**
 * Provider status core: routes supported providers to their adapters and
 * renders lifecycle-owned quota state. Scheduling and state live in the quota
 * lifecycle module; provider-specific endpoint behavior stays in adapters.
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
import type { QuotaSnapshot, UnavailableReason } from "./quota-contract.ts";
import { renderQuotaStatus } from "./quota-render.ts";

export const PROVIDER_STATUS_ID = "pi-quota";

/** Minimal resolved-auth shape needed from Pi's provider auth registry. */
export interface ResolvedProviderAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly baseUrl?: string;
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
  nowSeconds(): number;
  /** Available footer width in columns; undefined means unbounded. */
  readonly width?: number;
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

export function clearProviderStatus(host: ProviderStatusHost): void {
  if (host.mode === "tui") host.ui.setStatus(PROVIDER_STATUS_ID, undefined);
}

export function renderProviderStatus(
  host: ProviderStatusHost,
  snapshot: QuotaSnapshot,
  deps: Pick<ProviderStatusDeps, "nowSeconds" | "width">,
  stale: boolean,
): void {
  if (host.mode !== "tui") return;

  const rendered = renderQuotaStatus(snapshot, {
    nowSeconds: deps.nowSeconds(),
    width: deps.width,
    stale,
  });
  if (rendered === undefined) {
    clearProviderStatus(host);
    return;
  }

  const glyphColor =
    rendered.tone === "stale" ? "warning" : rendered.tone === "muted" ? "muted" : "accent";
  const textColor = rendered.tone === "stale" ? "muted" : "dim";
  const glyph = host.theme.fg(glyphColor, rendered.glyph);
  host.ui.setStatus(PROVIDER_STATUS_ID, `${glyph} ${host.theme.fg(textColor, rendered.text)}`);
}
