/**
 * Quota footer rendering.
 *
 * The footer segment is icon-only and begins with the quota glyph. At most
 * two validated quota windows are shown, ordered by ascending duration.
 * Unavailable quota renders nothing — never zero or invented quota.
 * Rendering contains no provider-specific endpoint logic.
 */

import {
  orderQuotaWindows,
  type QuotaSnapshot,
  type QuotaSourceKind,
  type QuotaWindow,
  type UnavailableReason,
} from "./quota-contract.ts";
import { formatAge, formatResetCountdown, formatTimestamp } from "./quota-time.ts";
import { PROVIDER_ADAPTERS } from "./provider-registry.ts";
import type { QuotaState } from "./quota-lifecycle.ts";

export const QUOTA_GLYPH = "◷";
export const RESET_GLYPH = "↻";

/**
 * Footer text segment: the quota window label or the remaining-quota body.
 * Segments let presenters color labels differently from values.
 */
export type StatusSegmentRole = "label" | "value";
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

const SOURCE_LABELS: Readonly<Record<QuotaSourceKind, string>> = {
  public: "public",
  "first-party-private": "first-party private",
  experimental: "experimental",
};

const UNAVAILABLE_REASON_LABELS: Readonly<Record<UnavailableReason, string>> = {
  unsupported: "unsupported",
  "auth-unavailable": "authentication unavailable",
  "auth-required": "authentication required",
  "schema-drift": "provider schema unavailable",
  transient: "temporarily unavailable",
  ambiguous: "provider behavior ambiguous",
};

function resetDetail(resetAtSeconds: number, nowSeconds: number): string {
  const timestamp = formatTimestamp(resetAtSeconds);
  const countdown = formatResetCountdown(resetAtSeconds, nowSeconds);
  return timestamp === undefined
    ? `resets in ${countdown}`
    : `resets ${timestamp} (${countdown === "now" ? "resetting now" : `in ${countdown}`})`;
}

function providerDetailLines(state: QuotaState | undefined, nowSeconds: number): string[] {
  if (state?.current === undefined) return ["  Status: not fetched"];

  const current = state.current;
  const stale = state.stale && state.lastRenderable !== undefined;
  const snapshot = stale ? state.lastRenderable : current;
  const lastCompletedAt = state?.lastCompletedAt;
  const lines = [
    `  Status: ${stale ? "stale" : snapshot.status}`,
    `  Source: ${SOURCE_LABELS[snapshot.source.kind]}`,
    ...(lastCompletedAt === undefined
      ? []
      : [`  Last update: ${formatAge(nowSeconds - lastCompletedAt)} ago`]),
    ...(stale
      ? [`  Stale data age: ${formatAge(nowSeconds - snapshot.source.fetchedAtSeconds)}`]
      : []),
    ...(current.status === "unavailable"
      ? [`  Unavailable reason: ${UNAVAILABLE_REASON_LABELS[current.reason]}`]
      : []),
  ];
  if (snapshot.status === "degraded") {
    lines.push("  Unknown semantics:");
    for (const telemetry of snapshot.telemetry) {
      const values = [
        ...(telemetry.percent === undefined ? [] : [`percentage ${telemetry.percent}%`]),
        ...Object.entries(telemetry.counters ?? {}).map(([name, value]) => `${name} ${value}`),
      ];
      const detail = values.length === 0 ? "" : `: ${values.join(" · ")}`;
      lines.push(`    ${telemetry.providerLabel}${detail}`);
    }
    return lines;
  }
  if (snapshot.status !== "available") return lines;

  lines.push("  Quota windows:");
  for (const quotaWindow of orderQuotaWindows(snapshot.windows)) {
    const blocked = quotaWindow.blocked === undefined
      ? ""
      : quotaWindow.blocked
        ? " · blocked"
        : " · not blocked";
    const reset = quotaWindow.resetAtSeconds === undefined
      ? ""
      : ` · ${resetDetail(quotaWindow.resetAtSeconds, nowSeconds)}`;
    lines.push(`    ${quotaWindow.label}: ${quotaWindow.remainingPercent}% remaining${reset}${blocked}`);
  }
  return lines;
}

export function renderQuotaDetails(
  states: readonly QuotaState[],
  activeProvider: string | undefined,
  nowSeconds: number,
): string {
  const statesByProvider = new Map(states.map((state) => [state.provider, state]));
  return [
    "Quota details",
    "",
    ...PROVIDER_ADAPTERS.flatMap(({ id, label }) => [
      `${label}${id === activeProvider ? " (active)" : ""}`,
      ...providerDetailLines(statesByProvider.get(id), nowSeconds),
      "",
    ]),
  ].join("\n").trimEnd();
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
      // A separator takes the worse remaining quota of the windows it joins.
      ...(index === 0
        ? []
        : [{
            role: "value" as const,
            text: " · ",
            remainingPercent: Math.min(
              windows[index - 1].remainingPercent,
              quotaWindow.remainingPercent,
            ),
          }]),
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
