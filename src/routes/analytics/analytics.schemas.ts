import { z } from "zod";
import { AnalyticsEventType } from "@prisma/client";
import { RANGE_KEYS } from "../../lib/range.js";

const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const ingestEventSchema = z.object({
  type: z.nativeEnum(AnalyticsEventType),
  name: optionalText(300),
  path: z.string().trim().min(1).max(500),
  referrer: optionalText(1000),
  referrerHost: optionalText(255),
  utmSource: optionalText(100),
  utmMedium: optionalText(100),
  utmCampaign: optionalText(100),
  country: optionalText(2),
  region: optionalText(100),
  city: optionalText(100),
  device: optionalText(20),
  browser: optionalText(50),
  os: optionalText(50),
  visitorHash: z.string().trim().min(8).max(128),
  sessionId: z.string().trim().min(8).max(64),
  value: z.number().finite().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const ingestBatchSchema = z.object({
  events: z.array(ingestEventSchema).min(1).max(20),
});

export const BREAKDOWN_DIMENSIONS = [
  "page",
  "entry",
  "exit",
  "referrer",
  "utm_source",
  "utm_campaign",
  "country",
  "city",
  "device",
  "browser",
  "os",
  "event",
] as const;

export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export const breakdownQuerySchema = z.object({
  range: z.enum(RANGE_KEYS).default("7d"),
  dimension: z.enum(BREAKDOWN_DIMENSIONS),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export type IngestEvent = z.infer<typeof ingestEventSchema>;
