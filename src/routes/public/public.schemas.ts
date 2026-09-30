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

  // Attribution — all optional, filled in by the website's enquiry forms
  // and its /api/enquiries route (geo). Bounded so a crafted request can't
  // bloat the row.
  source: z.enum(["modal", "studio"]).optional().nullable(),
  pagePath: z.string().trim().max(500).optional().nullable(),
  referrerHost: z.string().trim().max(255).optional().nullable(),
  utmSource: z.string().trim().max(100).optional().nullable(),
  country: z.string().trim().max(2).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  sessionId: z.string().trim().max(64).optional().nullable(),

  // Honeypot — a visually hidden input real visitors never fill.
  website: z.string().optional().nullable(),
});

export type PublicEnquiryInput = z.infer<typeof publicEnquirySchema>;

