/**
 * Quota footer: owns the footer status end to end.
 *
 * Text composition (glyph, quota window labels, reset countdowns, width
 * degradation), tone (normal/muted/stale), severity coloring (error under
 * 10% remaining, warning under 20%, success otherwise), theme painting, and
 * the host status call all live here. At most two validated quota windows
 * are shown, ordered by ascending duration. Unavailable quota renders
 * nothing — never zero or invented quota. The Pi host seam (theme, status
 * UI) is injected, so rendering stays testable without a TUI.
 */

import type { ProviderStatusHost } from "./provider-registry.ts";
import {
  orderQuotaWindows,
  type QuotaSnapshot,
  type QuotaWindow,
} from "./quota-contract.ts";
import { formatResetCountdown, type NowSeconds } from "./quota-time.ts";

export const PROVIDER_STATUS_ID = "pi-quota";
export const QUOTA_GLYPH = "◷";
export const RESET_GLYPH = "↻";

/**
 * Footer text segment: the quota window label, the remaining-quota body, or
 * a divider between quota windows.
 */
export type StatusSegmentRole = "label" | "value" | "separator";
export interface StatusSegment {
  readonly role: StatusSegmentRole;
  readonly text: string;
  /** Remaining quota of the quota window this segment belongs to, when applicable. */
  readonly remainingPercent?: number;
}

export interface RenderedQuotaStatus {
  readonly glyph: string;
  readonly text: string;
  readonly segments: readonly StatusSegment[];
  readonly tone: "normal" | "muted" | "stale";
}

export interface RenderOptions {
  readonly nowSeconds: number;
  /** Available footer width in columns; undefined means unbounded. */
  readonly width?: number;
  /** Last renderable snapshot is being preserved after a failed refresh. */
  readonly stale?: boolean;
}

function windowSegments(
  quotaWindow: QuotaWindow,
  nowSeconds: number,
  withReset: boolean,
): StatusSegment[] {
  let value = ` ${quotaWindow.remainingPercent}%`;
  if (withReset && quotaWindow.resetAtSeconds !== undefined) {
    value += ` ${RESET_GLYPH} ${formatResetCountdown(quotaWindow.resetAtSeconds, nowSeconds)}`;
  }
  return [
    { role: "label", text: `${quotaWindow.label}:` },
    { role: "value", text: value, remainingPercent: quotaWindow.remainingPercent },
  ];
}

export function renderQuotaStatus(
  snapshot: QuotaSnapshot,
  options: RenderOptions,
): RenderedQuotaStatus | undefined {
  if (snapshot.status === "unavailable") return undefined;

  if (snapshot.status === "degraded") {
    return {
      glyph: QUOTA_GLYPH,
      text: "telemetry",
      segments: [{ role: "value", text: "telemetry" }],
      tone: options.stale ? "stale" : "muted",
    };
  }

  const windows = orderQuotaWindows(snapshot.windows).slice(0, 2);
  if (windows.length === 0) return undefined;

  const joinWindows = (withReset: boolean): StatusSegment[] =>
    windows.flatMap((quotaWindow, index) => [
      ...(index === 0 ? [] : [{ role: "separator" as const, text: " · " }]),
      ...windowSegments(quotaWindow, options.nowSeconds, withReset),
    ]);

  // Width degradation: omit reset segments first, then secondary windows.
  const candidates = [
    joinWindows(true),
    joinWindows(false),
    windowSegments(windows[0], options.nowSeconds, false),
  ];

  const segmentText = (segments: readonly StatusSegment[]) =>
    segments.map((segment) => segment.text).join("");
  const fits = (segments: readonly StatusSegment[]) =>
    options.width === undefined ||
    QUOTA_GLYPH.length + 1 + segmentText(segments).length <= options.width;
  const segments = candidates.find(fits) ?? candidates[candidates.length - 1];
  return {
    glyph: QUOTA_GLYPH,
    text: segmentText(segments),
    segments,
    tone: options.stale ? "stale" : "normal",
  };
}

type Theme = ProviderStatusHost["theme"];

/** Maps remaining quota onto a severity color: error under 10%, warning under 20%. */
function severityColor(
  remainingPercent: number | undefined,
): "success" | "warning" | "error" {
  if (remainingPercent === undefined || remainingPercent >= 20) return "success";
  return remainingPercent >= 10 ? "warning" : "error";
}

/** Paints a value segment: percent, reset glyph, and countdown share the severity color. */
function paintValue(theme: Theme, text: string, remainingPercent: number | undefined): string {
  const color = severityColor(remainingPercent);
  return text
    .split(RESET_GLYPH)
    .map((part, index) =>
      `${index === 0 ? "" : theme.fg(color, RESET_GLYPH)}` +
      `${part === "" ? "" : theme.fg(color, part)}`)
    .join("");
}

function paintText(theme: Theme, rendered: RenderedQuotaStatus): string {
  // Stale and muted tones keep a single flat color so freshness stays legible.
  if (rendered.tone !== "normal") {
    return theme.fg(rendered.tone === "stale" ? "muted" : "dim", rendered.text);
  }
  // Labels take the success color; dividers match pi's own footer dividers;
  // values take the severity color of their window.
  return rendered.segments
    .map((segment) => {
      if (segment.role === "label") return theme.fg("success", segment.text);
      if (segment.role === "separator") return theme.fg("dim", segment.text);
      return paintValue(theme, segment.text, segment.remainingPercent);
    })
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
