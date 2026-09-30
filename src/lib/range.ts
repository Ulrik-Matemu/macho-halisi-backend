import { z } from "zod";

// Shared reporting-window parsing for the admin analytics and monitoring
// endpoints. Every window is anchored to "now" and paired with the
// immediately preceding window of equal length, so KPIs can show change.

export const RANGE_KEYS = ["24h", "7d", "30d", "90d"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

const RANGE_MS: Record<RangeKey, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export const rangeQuerySchema = z.object({
  range: z.enum(RANGE_KEYS).default("7d"),
});

export interface ReportWindow {
  key: RangeKey;
  from: Date;
  to: Date;
  prevFrom: Date;
  /** Bucket size for time series: hourly for 24h, daily otherwise. */
  granularity: "hour" | "day";
  minutes: number;
}

export function resolveWindow(key: RangeKey, now: Date = new Date()): ReportWindow {
  const span = RANGE_MS[key];
  const to = now;
  const from = new Date(to.getTime() - span);
  return {
    key,
    from,
    to,
    prevFrom: new Date(from.getTime() - span),
    granularity: key === "24h" ? "hour" : "day",
    minutes: span / 60_000,
  };
}

/**
 * Timestamps are stored as `timestamp(3)` (no zone, UTC by Prisma
 * convention). Bind them as ISO strings converted to UTC explicitly so the
 * comparison never depends on the database session's TimeZone setting.
 */
export function utc(date: Date): string {
  return date.toISOString();
}
