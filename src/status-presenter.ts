/**
 * Quota footer presenter: maps rendered quota status onto the Pi host's
 * theme and status UI. Rendering policy (glyph, text, tone) lives in the
 * quota renderer; the host seam lives in provider dispatch; this module owns
 * only host presentation — tone-to-color mapping, glyph composition, and
 * status calls.
 */

import type { ProviderStatusHost } from "./provider-status.ts";
import type { QuotaSnapshot } from "./quota-contract.ts";
import { renderQuotaStatus } from "./quota-render.ts";
import type { NowSeconds } from "./quota-time.ts";

export const PROVIDER_STATUS_ID = "pi-quota";

export interface StatusPresenterDeps {
  readonly nowSeconds: NowSeconds;
  /** Available footer width in columns; undefined means unbounded. */
  readonly width?: number;
}

export function clearProviderStatus(host: ProviderStatusHost): void {
  if (host.mode === "tui") host.ui.setStatus(PROVIDER_STATUS_ID, undefined);
}

export function renderProviderStatus(
  host: ProviderStatusHost,
  snapshot: QuotaSnapshot,
  deps: StatusPresenterDeps,
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
