import { z } from "zod";

export const createDestinationSchema = z.object({
  name: z.string().trim().min(1, "Destination name is required"),
});

export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;
