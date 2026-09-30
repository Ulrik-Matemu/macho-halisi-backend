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
    // Must reference one of this accommodation's own images — checked in
    // the route handler, since Zod can't validate a cross-record
    // reference. Not wired into POST /accommodations below: images are
    // created in that same call, so there's nothing to reference yet.
    heroImageId: z.string().uuid("Invalid image ID format").optional().nullable(),
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
    heroImageId: z.string().uuid("Invalid image ID format").optional().nullable(),
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

// Order is purely cosmetic now — the hero/cover image is the explicit
// Accommodation.heroImageId (see above), not gallery position. `order`
// must list every one of the accommodation's current image IDs exactly
// once.
export const reorderImagesSchema = z.object({
  order: z.array(z.string().uuid("Invalid image ID format")).min(1, "order must include at least one image ID"),
});

export const updateImageSchema = z.object({
  altText: z.string().trim().max(300, "Alt text must be 300 characters or fewer").optional().nullable(),
});

export type CreateAccommodationInput = z.infer<typeof createAccommodationSchema>;
export type UpdateAccommodationInput = z.infer<typeof updateAccommodationSchema>;
export type AddImageInput = z.infer<typeof addImageSchema>;
export type ReorderImagesInput = z.infer<typeof reorderImagesSchema>;
export type UpdateImageInput = z.infer<typeof updateImageSchema>;
export type AccommodationQueryParams = z.infer<typeof accommodationQuerySchema>;
