/**
 * Duration and reset formatting for quota status.
 *
 * Reset countdowns round up to the next minute and omit seconds. Expired
 * reset timestamps render as resetting now, without implying the provider
 * has actually replenished quota.
 */

/** Reads the current time as Unix epoch seconds. */
export type NowSeconds = () => number;

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

/** Pads a number to two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Formats a Unix timestamp as "dd-MM-YYYY HH:mm" in the local time zone,
 * when it fits JavaScript's date range.
 */
export function formatTimestamp(timestampSeconds: number): string | undefined {
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  return (
    `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
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
