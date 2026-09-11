import { z } from "zod";
import { ItineraryStatus, AvailabilityStatus } from "@prisma/client";

export const dayInputSchema = z.object({
  dayNumber: z.number().int().positive("Day number must be a positive integer"),
  title: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  accommodation: z.string().trim().optional().nullable(),
  activities: z.array(z.string().trim()).default([]),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  // Must reference one of this itinerary's own images — checked in the
  // route handler against the itinerary's current image set, since Zod
  // alone can't validate a cross-record reference.
  heroImageId: z.string().uuid("Invalid image ID format").optional().nullable(),
  highlight: z.boolean().default(false),
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
    showRouteMap: z.boolean().default(true),
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
    showRouteMap: z.boolean().optional(),
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

export const availabilityPeriodInputSchema = z
  .object({
    startDate: z.coerce.date({ message: "startDate must be a valid date" }),
    endDate: z.coerce.date({ message: "endDate must be a valid date" }),
    status: z.nativeEnum(AvailabilityStatus),
    note: z.string().trim().max(280, "Note must be 280 characters or fewer").optional().nullable(),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be on or after the start date",
    path: ["endDate"],
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
export type AvailabilityPeriodInput = z.infer<typeof availabilityPeriodInputSchema>;
