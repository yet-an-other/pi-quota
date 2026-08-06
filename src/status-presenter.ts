/**
 * Quota footer presenter: maps rendered quota status onto the Pi host's
 * theme and status UI. Rendering policy (glyph, text, tone) lives in the
 * quota renderer; the host seam lives in provider dispatch; this module owns
 * only host presentation — tone-to-color mapping, segment coloring styles,
 * glyph composition, and status calls.
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

/** Footer coloring styles, cycled by the /quota-style command. */
export const QUOTA_STATUS_STYLES = [
  "plain",
  "units-bright",
  "numbers-bright",
  "green",
  "green-success",
] as const;
export type QuotaStatusStyle = (typeof QUOTA_STATUS_STYLES)[number];

let currentStyle: QuotaStatusStyle = "green-success";

export function setQuotaStatusStyle(style: QuotaStatusStyle): void {
  currentStyle = style;
}

export function getQuotaStatusStyle(): QuotaStatusStyle {
  return currentStyle;
}

type SegmentRole = "number" | "unit" | "reset" | "symbol";

interface Segment {
  role: SegmentRole;
  text: string;
}

/**
 * Splits status text into digit runs, unit runs (%/h/m/d directly following
 * a digit), the reset glyph, and symbol runs (separators, spaces, letters).
 */
function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let previous = "";
  for (const ch of text) {
    const role: SegmentRole = /[0-9]/.test(ch)
      ? "number"
      : /[%hmd]/.test(ch) && /[0-9]/.test(previous)
        ? "unit"
        : ch === RESET_GLYPH
          ? "reset"
          : "symbol";
    const last = segments[segments.length - 1];
    if (last !== undefined && last.role === role) last.text += ch;
    else segments.push({ role, text: ch });
    previous = ch;
  }
  return segments;
}

const LIGHT_GREEN = "\x1b[38;2;126;211;133m";
const DARK_GREEN = "\x1b[38;2;46;125;50m";
const FOREGROUND_RESET = "\x1b[39m";

type Theme = ProviderStatusHost["theme"];

const lightGreen = (text: string) => `${LIGHT_GREEN}${text}${FOREGROUND_RESET}`;
const darkGreen = (text: string) => `${DARK_GREEN}${text}${FOREGROUND_RESET}`;

function paintSegment(theme: Theme, style: QuotaStatusStyle, segment: Segment): string {
  switch (style) {
    case "units-bright":
      return theme.fg(segment.role === "unit" ? "text" : "dim", segment.text);
    case "numbers-bright":
      return theme.fg(segment.role === "number" ? "text" : "dim", segment.text);
    case "green":
      return segment.role === "number" ? lightGreen(segment.text) : darkGreen(segment.text);
    default:
      return theme.fg("dim", segment.text);
  }
}

/** Maps remaining quota onto a severity color: error under 10%, warning under 20%. */
function severityColor(
  remainingPercent: number | undefined,
): "success" | "warning" | "error" {
  if (remainingPercent === undefined || remainingPercent >= 20) return "success";
  return remainingPercent >= 10 ? "warning" : "error";
}

function paintText(theme: Theme, rendered: RenderedQuotaStatus): string {
  // Stale and muted tones keep a single flat color so freshness stays legible.
  if (rendered.tone !== "normal" || currentStyle === "plain") {
    return theme.fg(rendered.tone === "stale" ? "muted" : "dim", rendered.text);
  }
  if (currentStyle === "green-success") {
    // Labels, the reset glyph, and the quota glyph take the success color;
    // values take the severity color of their quota window.
    return rendered.segments
      .map((segment) =>
        segment.role === "label"
          ? theme.fg("success", segment.text)
          : tokenize(segment.text)
              .map((token) =>
                theme.fg(
                  token.role === "reset" ? "success" : severityColor(segment.remainingPercent),
                  token.text,
                ))
              .join(""))
      .join("");
  }
  return tokenize(rendered.text)
    .map((segment) => paintSegment(theme, currentStyle, segment))
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
    layout: currentStyle === "green-success" ? "spaced" : "compact",
  });
  if (rendered === undefined) {
    clearProviderStatus(host);
    return;
  }

  const glyphColor =
    rendered.tone === "stale" ? "warning" : rendered.tone === "muted" ? "muted" : "accent";
  const glyph =
    currentStyle === "green-success" && rendered.tone === "normal"
      ? host.theme.fg("success", rendered.glyph)
      : host.theme.fg(glyphColor, rendered.glyph);
  host.ui.setStatus(PROVIDER_STATUS_ID, `${glyph} ${paintText(host.theme, rendered)}`);
}
