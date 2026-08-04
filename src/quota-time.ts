/**
 * Duration and reset formatting for quota status.
 *
 * Reset countdowns round up to the next minute and omit seconds. Expired
 * reset timestamps render as resetting now, without implying the provider
 * has actually replenished quota.
 */

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
