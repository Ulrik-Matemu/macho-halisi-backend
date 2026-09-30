import { z } from "zod";
import { UptimeTarget } from "@prisma/client";

export const uptimeCheckSchema = z.object({
  target: z.nativeEnum(UptimeTarget),
  url: z.string().trim().min(1).max(500),
  ok: z.boolean(),
  statusCode: z.number().int().min(0).max(999).optional().nullable(),
  latencyMs: z.number().int().min(0).max(600_000).optional().nullable(),
  error: z.string().trim().max(500).optional().nullable(),
});

export const uptimeBatchSchema = z.object({
  source: z.string().trim().max(50).optional(),
  checks: z.array(uptimeCheckSchema).min(1).max(20),
});
