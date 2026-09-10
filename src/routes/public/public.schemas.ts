import { z } from "zod";

export const publicItineraryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(12),
});

export type PublicItineraryQueryParams = z.infer<typeof publicItineraryQuerySchema>;
