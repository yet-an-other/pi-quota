/**
 * Provider status core: decides what the footer shows for the active provider.
 *
 * Supported providers render their quota snapshot through the icon-only
 * footer status. Unsupported or absent providers render nothing. Non-TUI
 * modes degrade silently without footer side effects.
 */

import { CODEX_PROVIDER, fetchCodexQuotaSnapshot } from "./providers/codex.ts";
import { fetchKimiQuotaSnapshot, KIMI_PROVIDER } from "./providers/kimi.ts";
import { fetchZaiQuotaSnapshot, ZAI_PROVIDER } from "./providers/zai.ts";
import { renderQuotaStatus } from "./quota-render.ts";

export const PROVIDER_STATUS_ID = "pi-quota";

const DEFAULT_TIMEOUT_MS = 8000;

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
  /** Provider quota request deadline owned by the core. */
  readonly timeoutMs?: number;
  /** Available footer width in columns; undefined means unbounded. */
  readonly width?: number;
}

export async function refreshProviderStatus(
  host: ProviderStatusHost,
  deps: ProviderStatusDeps,
): Promise<void> {
  if (host.mode !== "tui") return;

  const provider = host.provider;
  if (provider === undefined) {
    host.ui.setStatus(PROVIDER_STATUS_ID, undefined);
    return;
  }

  if (provider !== CODEX_PROVIDER && provider !== KIMI_PROVIDER && provider !== ZAI_PROVIDER) {
    host.ui.setStatus(PROVIDER_STATUS_ID, undefined);
    return;
  }

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
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  const snapshot =
    provider === CODEX_PROVIDER
      ? await fetchCodexQuotaSnapshot(adapterDeps)
      : provider === KIMI_PROVIDER
        ? await fetchKimiQuotaSnapshot(adapterDeps)
        : await fetchZaiQuotaSnapshot({ ...adapterDeps, providerBaseUrl: host.providerBaseUrl });
  const rendered = renderQuotaStatus(snapshot, {
    nowSeconds: deps.nowSeconds(),
    width: deps.width,
  });

  if (rendered === undefined) {
    host.ui.setStatus(PROVIDER_STATUS_ID, undefined);
    return;
  }

  const glyph = host.theme.fg(rendered.tone === "muted" ? "muted" : "accent", rendered.glyph);
  host.ui.setStatus(PROVIDER_STATUS_ID, `${glyph} ${host.theme.fg("dim", rendered.text)}`);
}
