import { z } from "zod";

export const createDestinationSchema = z.object({
  name: z.string().trim().min(1, "Destination name is required"),
});

// Coordinates and blurb only — name/slug are immutable via this route
// (renaming a shared, itinerary-referenced destination is a bigger
// operation than this catalog-edit form needs to support).
export const updateDestinationSchema = z.object({
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  blurb: z.string().trim().max(280, "Blurb must be 280 characters or fewer").optional().nullable(),
});

export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;
