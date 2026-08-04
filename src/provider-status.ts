/**
 * Provider status core: decides what the footer shows for the active provider.
 *
 * Supported providers render their quota snapshot through the icon-only
 * footer status; unsupported providers show the temporary provider-name
 * placeholder that later quota slices replace; absent providers render
 * nothing. Non-TUI modes degrade silently without footer side effects.
 */

import { CODEX_PROVIDER, fetchCodexQuotaSnapshot } from "./providers/codex.ts";
import { renderQuotaStatus } from "./quota-render.ts";

export const PROVIDER_STATUS_ID = "pi-quota";

/** Minimal resolved-auth shape needed from Pi's provider auth registry. */
export interface ResolvedProviderAuth {
  readonly apiKey?: string;
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

  if (provider !== CODEX_PROVIDER) {
    // Temporary placeholder until the provider's quota slice lands.
    host.ui.setStatus(PROVIDER_STATUS_ID, provider);
    return;
  }

  const snapshot = await fetchCodexQuotaSnapshot({
    resolveAuth: async () => {
      const auth = await host.resolveAuth(provider);
      return auth === undefined
        ? undefined
        : { ...auth, baseUrl: auth.baseUrl ?? host.providerBaseUrl };
    },
    fetchFn: deps.fetchFn,
    nowSeconds: deps.nowSeconds,
  });
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
