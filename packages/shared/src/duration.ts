const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Short duration text: under 1 hour "45m", under 1 day "3h 20m", under 14 days "3d 4h", else "23d".
 * Units are rounded down; a zero second part is left out ("3h", "2d"). Negative values count as 0.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < HOUR_MS) return `${Math.floor(safe / MINUTE_MS)}m`;
  if (safe < DAY_MS) {
    const hours = Math.floor(safe / HOUR_MS);
    const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safe / DAY_MS);
  if (days < 14) {
    const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return `${days}d`;
}

/** doneAt minus createdAt in ms, or null when not done. Never negative. */
export function todoDurationMs(createdAt: string, doneAt: string | null): number | null {
  if (doneAt === null) return null;
  return Math.max(0, Date.parse(doneAt) - Date.parse(createdAt));
}
