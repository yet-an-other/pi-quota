/**
 * Quota contract: shared types and pure validation guards.
 *
 * A provider adapter resolves Pi authentication, verifies the provider
 * origin, fetches provider data, validates it, and returns a quota snapshot.
 * Validation is strict at the adapter boundary: invalid values are dropped
 * and missing values remain unknown — never zero.
 */

/** Stability classification of a provider quota source. */
export type QuotaSourceKind = "public" | "first-party-private" | "experimental";

export interface QuotaSourceMeta {
  readonly kind: QuotaSourceKind;
  readonly detailUrl?: string;
  /** Unix epoch seconds at which the snapshot was produced. */
  readonly fetchedAtSeconds: number;
}

/** A validated provider-reported allowance period. */
export interface QuotaWindow {
  /** Stable identifier, unique within a provider snapshot. */
  readonly id: string;
  /** Display label, typically derived from the window duration. */
  readonly label: string;
  /** Verified remaining percentage, 0–100 inclusive. */
  readonly remainingPercent: number;
  readonly durationSeconds?: number;
  /** Unix epoch seconds at which the window resets. */
  readonly resetAtSeconds?: number;
  readonly blocked?: boolean;
}

/** Provider-reported usage metrics whose semantics are not verified. */
export interface QuotaTelemetry {
  readonly id: string;
  readonly providerLabel: string;
  readonly percent?: number;
  readonly counters?: Readonly<Record<string, number>>;
  readonly semantics: "unknown";
}

export type UnavailableReason =
  | "unsupported"
  | "auth-unavailable"
  | "auth-required"
  | "schema-drift"
  | "transient"
  | "ambiguous";

export type QuotaSnapshot =
  | {
      readonly status: "available";
      readonly provider: string;
      readonly windows: readonly QuotaWindow[];
      readonly source: QuotaSourceMeta;
    }
  | {
      readonly status: "degraded";
      readonly provider: string;
      readonly telemetry: readonly QuotaTelemetry[];
      readonly source: QuotaSourceMeta;
    }
  | {
      readonly status: "unavailable";
      readonly provider: string;
      readonly reason: UnavailableReason;
      readonly source: QuotaSourceMeta;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value when it is a finite number, otherwise unknown. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Derives remaining percent from a validated consumed percent.
 * Consumed values outside 0–100 are clamped, never treated as exact.
 */
export function clampRemainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/**
 * Orders validated quota windows by ascending duration, preserving snapshot
 * order for ties and unknown durations (unknown sorts last).
 */
export function orderQuotaWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  return windows
    .map((quotaWindow, index) => ({ quotaWindow, index }))
    .sort((a, b) => {
      const durationA = a.quotaWindow.durationSeconds ?? Number.POSITIVE_INFINITY;
      const durationB = b.quotaWindow.durationSeconds ?? Number.POSITIVE_INFINITY;
      if (durationA !== durationB) return durationA - durationB;
      return a.index - b.index;
    })
    .map(({ quotaWindow }) => quotaWindow);
}
