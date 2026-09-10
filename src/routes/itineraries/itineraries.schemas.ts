import { z } from "zod";
import { ItineraryStatus, AvailabilityStatus } from "@prisma/client";

export const dayInputSchema = z.object({
  dayNumber: z.number().int().positive("Day number must be a positive integer"),
  title: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  accommodation: z.string().trim().optional().nullable(),
  activities: z.array(z.string().trim()).default([]),
});

export const imageInputSchema = z.object({
  url: z.string().url("Must be a valid image URL"),
  cloudinaryPublicId: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().default(0),
  altText: z.string().trim().optional().nullable(),
});

export const createItinerarySchema = z
  .object({
    title: z.string().trim().min(1, "Title is required"),
    slug: z.string().trim().min(1).optional(),
    overview: z.string().trim().optional().nullable(),
    nights: z.number().int().nonnegative("Nights must be 0 or greater").optional().nullable(),
    startingPrice: z.number().positive("Starting price must be a positive amount").optional().nullable(),
    priceOnRequest: z.boolean().default(false),
    inclusions: z.array(z.string().trim()).default([]),
    exclusions: z.array(z.string().trim()).default([]),
    travelInfo: z.string().trim().optional().nullable(),
    routeMapUrl: z.string().url().optional().nullable().or(z.literal("")),
    availabilityStatus: z.nativeEnum(AvailabilityStatus).default(AvailabilityStatus.AVAILABLE),
    days: z.array(dayInputSchema).default([]),
    destinationIds: z.array(z.string().uuid("Invalid destination ID format")).default([]),
    images: z.array(imageInputSchema).default([]),
  })
  .refine(
    (data) => {
      if (!data.priceOnRequest && (data.startingPrice === null || data.startingPrice === undefined)) {
        return false;
      }
      return true;
    },
    {
      message: "startingPrice is required when priceOnRequest is false",
      path: ["startingPrice"],
    }
  );

export const updateItinerarySchema = z
  .object({
    title: z.string().trim().min(1, "Title cannot be empty").optional(),
    slug: z.string().trim().min(1).optional(),
    status: z
      .nativeEnum(ItineraryStatus)
      .refine(
        (val) => val === ItineraryStatus.DRAFT || val === ItineraryStatus.IN_REVIEW,
        {
          message:
            "Status updates via PUT can only set DRAFT or IN_REVIEW. Use PATCH /itineraries/:id/publish to publish.",
        }
      )
      .optional(),
    overview: z.string().trim().optional().nullable(),
    nights: z.number().int().nonnegative("Nights must be 0 or greater").optional().nullable(),
    startingPrice: z.number().positive("Starting price must be a positive amount").optional().nullable(),
    priceOnRequest: z.boolean().optional(),
    inclusions: z.array(z.string().trim()).optional(),
    exclusions: z.array(z.string().trim()).optional(),
    travelInfo: z.string().trim().optional().nullable(),
    routeMapUrl: z.string().url().optional().nullable().or(z.literal("")),
    availabilityStatus: z.nativeEnum(AvailabilityStatus).optional(),
    days: z.array(dayInputSchema).optional(),
    destinationIds: z.array(z.string().uuid("Invalid destination ID format")).optional(),
  })
  .refine(
    (data) => {
      // If priceOnRequest is explicitly false and startingPrice is set to null, reject
      if (data.priceOnRequest === false && data.startingPrice === null) {
        return false;
      }
      return true;
    },
    {
      message: "startingPrice cannot be null when priceOnRequest is false",
      path: ["startingPrice"],
    }
  );

export const addImageSchema = z.object({
  url: z.string().url("Must be a valid image URL"),
  cloudinaryPublicId: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().default(0),
  altText: z.string().trim().optional().nullable(),
});

export const itineraryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  status: z.nativeEnum(ItineraryStatus).optional(),
});

export type CreateItineraryInput = z.infer<typeof createItinerarySchema>;
export type UpdateItineraryInput = z.infer<typeof updateItinerarySchema>;
export type AddImageInput = z.infer<typeof addImageSchema>;
export type ItineraryQueryParams = z.infer<typeof itineraryQuerySchema>;
