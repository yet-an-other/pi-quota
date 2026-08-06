/**
 * Quota footer presenter: maps rendered quota status onto the Pi host's
 * theme and status UI. Rendering policy (glyph, text, tone) lives in the
 * quota renderer; the host seam lives in provider dispatch; this module owns
 * only host presentation — tone-to-color mapping, severity coloring, glyph
 * composition, and status calls.
 */

import type { ProviderStatusHost } from "./provider-registry.ts";
import type { QuotaSnapshot } from "./quota-contract.ts";
import {
  type RenderedQuotaStatus,
  renderQuotaStatus,
  RESET_GLYPH,
} from "./quota-render.ts";
import type { NowSeconds } from "./quota-time.ts";

export const PROVIDER_STATUS_ID = "pi-quota";

type Theme = ProviderStatusHost["theme"];

/** Maps remaining quota onto a severity color: error under 10%, warning under 20%. */
function severityColor(
  remainingPercent: number | undefined,
): "success" | "warning" | "error" {
  if (remainingPercent === undefined || remainingPercent >= 20) return "success";
  return remainingPercent >= 10 ? "warning" : "error";
}

/** Paints a value segment: severity-colored text around a success-colored reset glyph. */
function paintValue(theme: Theme, text: string, remainingPercent: number | undefined): string {
  const color = severityColor(remainingPercent);
  return text
    .split(RESET_GLYPH)
    .map((part, index) =>
      `${index === 0 ? "" : theme.fg("success", RESET_GLYPH)}` +
      `${part === "" ? "" : theme.fg(color, part)}`)
    .join("");
}

function paintText(theme: Theme, rendered: RenderedQuotaStatus): string {
  // Stale and muted tones keep a single flat color so freshness stays legible.
  if (rendered.tone !== "normal") {
    return theme.fg(rendered.tone === "stale" ? "muted" : "dim", rendered.text);
  }
  // Labels take the success color; values take the severity color of their window.
  return rendered.segments
    .map((segment) =>
      segment.role === "label"
        ? theme.fg("success", segment.text)
        : paintValue(theme, segment.text, segment.remainingPercent))
    .join("");
}

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
    rendered.tone === "stale" ? "warning" : rendered.tone === "muted" ? "muted" : "success";
  const glyph = host.theme.fg(glyphColor, rendered.glyph);
  host.ui.setStatus(PROVIDER_STATUS_ID, `${glyph} ${paintText(host.theme, rendered)}`);
}
