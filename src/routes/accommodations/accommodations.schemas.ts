import { z } from "zod";
import { ItineraryStatus, AccommodationType, ServiceTier } from "@prisma/client";

export const imageInputSchema = z.object({
  url: z.string().url("Must be a valid image URL"),
  cloudinaryPublicId: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().default(0),
  altText: z.string().trim().optional().nullable(),
});

export const createAccommodationSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    slug: z.string().trim().min(1).optional(),
    type: z.nativeEnum(AccommodationType),
    serviceTier: z.nativeEnum(ServiceTier),
    starRating: z.number().int().min(1).max(5).optional().nullable(),
    locationText: z.string().trim().min(1, "Location is required"),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    amenities: z.array(z.string().trim()).default([]),
    pricePerNight: z.number().positive("Price per night must be a positive amount").optional().nullable(),
    priceOnRequest: z.boolean().default(false),
    destinationId: z.string().uuid("Invalid destination ID format").optional().nullable(),
    images: z.array(imageInputSchema).default([]),
  })
  .refine(
    (data) => {
      if (!data.priceOnRequest && (data.pricePerNight === null || data.pricePerNight === undefined)) {
        return false;
      }
      return true;
    },
    {
      message: "pricePerNight is required when priceOnRequest is false",
      path: ["pricePerNight"],
    }
  );

export const updateAccommodationSchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").optional(),
    slug: z.string().trim().min(1).optional(),
    status: z
      .nativeEnum(ItineraryStatus)
      .refine((val) => val === ItineraryStatus.DRAFT || val === ItineraryStatus.IN_REVIEW, {
        message:
          "Status updates via PUT can only set DRAFT or IN_REVIEW. Use PATCH /accommodations/:id/publish to publish.",
      })
      .optional(),
    type: z.nativeEnum(AccommodationType).optional(),
    serviceTier: z.nativeEnum(ServiceTier).optional(),
    starRating: z.number().int().min(1).max(5).optional().nullable(),
    locationText: z.string().trim().min(1, "Location cannot be empty").optional(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    amenities: z.array(z.string().trim()).optional(),
    pricePerNight: z.number().positive("Price per night must be a positive amount").optional().nullable(),
    priceOnRequest: z.boolean().optional(),
    destinationId: z.string().uuid("Invalid destination ID format").optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.priceOnRequest === false && data.pricePerNight === null) {
        return false;
      }
      return true;
    },
    {
      message: "pricePerNight cannot be null when priceOnRequest is false",
      path: ["pricePerNight"],
    }
  );

export const addImageSchema = z.object({
  url: z.string().url("Must be a valid image URL"),
  cloudinaryPublicId: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().default(0),
  altText: z.string().trim().optional().nullable(),
});

export const accommodationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  status: z.nativeEnum(ItineraryStatus).optional(),
});

export type CreateAccommodationInput = z.infer<typeof createAccommodationSchema>;
export type UpdateAccommodationInput = z.infer<typeof updateAccommodationSchema>;
export type AddImageInput = z.infer<typeof addImageSchema>;
export type AccommodationQueryParams = z.infer<typeof accommodationQuerySchema>;
