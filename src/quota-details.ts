/**
 * Quota details view rendering.
 *
 * The /quota details view shows every provider in the provider registry with
 * its quota state: validated quota windows with reset times, validated quota
 * telemetry under unknown semantics, or a sanitized unavailable reason.
 * Unavailable quota never renders zero or invented quota. Rendering contains
 * no provider-specific endpoint logic.
 */

import {
  orderQuotaWindows,
  type QuotaSourceKind,
  type UnavailableReason,
} from "./quota-contract.ts";
import { formatAge, formatResetCountdown, formatTimestamp } from "./quota-time.ts";
import { PROVIDER_ADAPTERS } from "./provider-registry.ts";
import type { QuotaState } from "./quota-lifecycle.ts";

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
