/**
 * Duration and reset formatting for quota status.
 *
 * Reset countdowns round up to the next minute and omit seconds. Expired
 * reset timestamps render as resetting now, without implying the provider
 * has actually replenished quota.
 */

/** Formats elapsed time compactly for diagnostic freshness metadata. */
export function formatAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Formats a Unix timestamp when it fits JavaScript's ISO date range. */
export function formatTimestamp(timestampSeconds: number): string | undefined {
  const date = new Date(timestampSeconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Formats a window duration compactly, e.g. 300 → "5m", 18000 → "5h", 604800 → "7d". */
export function formatWindowDuration(durationSeconds: number): string {
  if (durationSeconds < 3600) return `${Math.max(1, Math.floor(durationSeconds / 60))}m`;
  if (durationSeconds < 86400) return `${Math.floor(durationSeconds / 3600)}h`;
  return `${Math.floor(durationSeconds / 86400)}d`;
}

/**
 * Formats the remaining time until a reset:
 * under one hour as minutes, under one day as hours and minutes,
 * one day or more as days and hours. Expired resets render as "now".
 */
export function formatResetCountdown(resetAtSeconds: number, nowSeconds: number): string {
  const remainingSeconds = resetAtSeconds - nowSeconds;
  if (remainingSeconds <= 0) return "now";

  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `${remainingMinutes}m`;

  const hours = Math.floor(remainingMinutes / 60);
  if (hours < 24) return `${hours}h${remainingMinutes % 60}m`;

  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
