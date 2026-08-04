/**
 * Quota footer rendering.
 *
 * The footer segment is icon-only and begins with the quota glyph. At most
 * two validated quota windows are shown, ordered by ascending duration.
 * Unavailable quota renders nothing — never zero or invented quota.
 * Rendering contains no provider-specific endpoint logic.
 */

import { orderQuotaWindows, type QuotaSnapshot, type QuotaWindow } from "./quota-contract.ts";
import { formatResetCountdown } from "./quota-time.ts";

export const QUOTA_GLYPH = "◷";
export const RESET_GLYPH = "↻";

export interface RenderedQuotaStatus {
  readonly glyph: string;
  readonly text: string;
  readonly tone: "normal" | "muted";
}

export interface RenderOptions {
  readonly nowSeconds: number;
  /** Available footer width in columns; undefined means unbounded. */
  readonly width?: number;
}

function windowText(quotaWindow: QuotaWindow, nowSeconds: number, withReset: boolean): string {
  const base = `${quotaWindow.label} ${quotaWindow.remainingPercent}%`;
  if (!withReset || quotaWindow.resetAtSeconds === undefined) return base;
  return `${base} ${RESET_GLYPH}${formatResetCountdown(quotaWindow.resetAtSeconds, nowSeconds)}`;
}

export function renderQuotaStatus(
  snapshot: QuotaSnapshot,
  options: RenderOptions,
): RenderedQuotaStatus | undefined {
  if (snapshot.status === "unavailable") return undefined;

  if (snapshot.status === "degraded") {
    return { glyph: QUOTA_GLYPH, text: "telemetry", tone: "muted" };
  }

  const windows = orderQuotaWindows(snapshot.windows).slice(0, 2);
  if (windows.length === 0) return undefined;

  // Width degradation: omit reset segments first, then secondary windows.
  const candidates = [
    windows.map((w) => windowText(w, options.nowSeconds, true)).join(" · "),
    windows.map((w) => windowText(w, options.nowSeconds, false)).join(" · "),
    windowText(windows[0], options.nowSeconds, false),
  ];

  const fits = (text: string) =>
    options.width === undefined || QUOTA_GLYPH.length + 1 + text.length <= options.width;
  const text = candidates.find(fits) ?? candidates[candidates.length - 1];
  return { glyph: QUOTA_GLYPH, text, tone: "normal" };
}
