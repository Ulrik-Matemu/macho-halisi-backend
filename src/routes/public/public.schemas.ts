import { z } from "zod";

export const publicItineraryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(12),
});

export type PublicItineraryQueryParams = z.infer<typeof publicItineraryQuerySchema>;

export const publicAccommodationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(12),
});

export type PublicAccommodationQueryParams = z.infer<typeof publicAccommodationQuerySchema>;

export const publicEnquirySchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  email: z.string().trim().email("Please provide a valid email address"),
  phone: z.string().trim().min(5, "Please provide a valid phone or WhatsApp number"),
  itineraryId: z.string().uuid("Invalid itinerary ID").optional().nullable(),
  partySize: z.string().trim().max(100).optional().nullable(),
  preferredDates: z.string().trim().max(200).optional().nullable(),
  message: z.string().trim().max(5000).optional().nullable(),
});

export type PublicEnquiryInput = z.infer<typeof publicEnquirySchema>;

