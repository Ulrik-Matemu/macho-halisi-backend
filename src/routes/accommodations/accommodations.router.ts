import { Router } from "express";
import { Role, ItineraryStatus, Accommodation, Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { generateUniqueAccommodationSlug } from "../../lib/slug.js";
import { deleteCloudinaryAsset } from "../../lib/cloudinary.js";
import {
  createAccommodationSchema,
  updateAccommodationSchema,
  addImageSchema,
  accommodationQuerySchema,
  UpdateAccommodationInput,
} from "./accommodations.schemas.js";

export const accommodationsRouter = Router();

// All routes under /accommodations require authentication at minimum
accommodationsRouter.use(requireAuth);

// Shared `include` for every full-detail accommodation response — one
// canonical shape instead of copies drifting apart.
const accommodationInclude = {
  images: { orderBy: { sortOrder: "asc" as const } },
  destination: {
    select: { id: true, name: true, slug: true, latitude: true, longitude: true, blurb: true },
  },
  author: { select: { id: true, email: true, role: true } },
  editor: { select: { id: true, email: true, role: true } },
} as const;

/**
 * Validates that a referenced destinationId actually exists. Zod can't check
 * a cross-record reference, so this runs in the route handler before writing.
 * Returns true when the id is unset (null/undefined) or exists.
 */
async function destinationExists(destinationId: string | null | undefined): Promise<boolean> {
  if (!destinationId) return true;
  const destination = await prisma.destination.findUnique({
    where: { id: destinationId },
    select: { id: true },
  });
  return Boolean(destination);
}

/**
 * Applies a validated update payload to the live accommodation — price calc
 * and scalar update. Shared by PUT /:id (when not yet PUBLISHED) and
 * PATCH /:id/publish-changes (which applies a staged AccommodationRevision).
 */
async function applyAccommodationUpdate(
  id: string,
  input: UpdateAccommodationInput,
  existing: Pick<Accommodation, "name" | "priceOnRequest" | "pricePerNight">,
  editorId: string
) {
  // Generate slug if name or slug was changed
  let slug: string | undefined = undefined;
  if (input.slug) {
    slug = await generateUniqueAccommodationSlug(input.slug, id);
  } else if (input.name && input.name !== existing.name) {
    slug = await generateUniqueAccommodationSlug(input.name, id);
  }

  // Price calculations
  const priceOnRequest =
    input.priceOnRequest !== undefined ? input.priceOnRequest : existing.priceOnRequest;
  let pricePerNight = existing.pricePerNight;
  if (priceOnRequest) {
    pricePerNight = null;
  } else if (input.pricePerNight !== undefined) {
    pricePerNight = input.pricePerNight as any;
  }

  return prisma.accommodation.update({
    where: { id },
    data: {
      name: input.name,
      slug,
      status: input.status,
      editorId,
      type: input.type,
      serviceTier: input.serviceTier,
      starRating: input.starRating,
      locationText: input.locationText,
      latitude: input.latitude,
      longitude: input.longitude,
      description: input.description,
      amenities: input.amenities,
      pricePerNight,
      priceOnRequest,
      destinationId: input.destinationId !== undefined ? input.destinationId || null : undefined,
    },
    include: accommodationInclude,
  });
}

/**
 * Overlays a staged (not-yet-applied) update onto the live accommodation, for
 * the PUT response when the accommodation is PUBLISHED — nothing here is
 * persisted, it's purely so the editor's screen shows the pending edit in the
 * same shape as a normal response. `full` must have been fetched with
 * `accommodationInclude`.
 */
async function buildRevisionPreview(
  full: Prisma.AccommodationGetPayload<{ include: typeof accommodationInclude }>,
  input: UpdateAccommodationInput
) {
  let destination = full.destination;
  if (input.destinationId !== undefined) {
    destination = input.destinationId
      ? await prisma.destination.findUnique({
          where: { id: input.destinationId },
          select: { id: true, name: true, slug: true, latitude: true, longitude: true, blurb: true },
        })
      : null;
  }

  const priceOnRequest = input.priceOnRequest !== undefined ? input.priceOnRequest : full.priceOnRequest;
  const pricePerNight = priceOnRequest
    ? null
    : input.pricePerNight !== undefined
    ? input.pricePerNight
    : full.pricePerNight;

  return {
    ...full,
    name: input.name ?? full.name,
    type: input.type ?? full.type,
    serviceTier: input.serviceTier ?? full.serviceTier,
    starRating: input.starRating !== undefined ? input.starRating : full.starRating,
    locationText: input.locationText ?? full.locationText,
    latitude: input.latitude !== undefined ? input.latitude : full.latitude,
    longitude: input.longitude !== undefined ? input.longitude : full.longitude,
    description: input.description !== undefined ? input.description : full.description,
    amenities: input.amenities ?? full.amenities,
    pricePerNight,
    priceOnRequest,
    destination,
    destinationId: input.destinationId !== undefined ? input.destinationId || null : full.destinationId,
  };
}

// ─── 1. GET /accommodations — List lightweight summaries ──────────
accommodationsRouter.get("/", async (req, res, next) => {
  try {
    const parseResult = accommodationQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid query parameters",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { page, limit, status } = parseResult.data;
    const skip = (page - 1) * limit;
    const where = status ? { status } : {};

    const [total, accommodations] = await Promise.all([
      prisma.accommodation.count({ where }),
      prisma.accommodation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          type: true,
          serviceTier: true,
          starRating: true,
          locationText: true,
          pricePerNight: true,
          priceOnRequest: true,
          publishedAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      status: "ok",
      data: accommodations,
      pagination: { page, limit, total, totalPages },
    });
  } catch (err) {
    next(err);
  }
});

// ─── 2. GET /accommodations/:id — Full detail ─────────────────────
accommodationsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const accommodation = await prisma.accommodation.findUnique({
      where: { id },
      include: accommodationInclude,
    });

    if (!accommodation) {
      res.status(404).json({ status: "error", message: "Accommodation not found" });
      return;
    }

    res.json({ status: "ok", accommodation });
  } catch (err) {
    next(err);
  }
});

// ─── 3. POST /accommodations — Create DRAFT accommodation ──────────
accommodationsRouter.post(
  "/",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const parseResult = createAccommodationSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;

      if (!(await destinationExists(input.destinationId))) {
        res.status(400).json({ status: "error", message: "Referenced destination does not exist" });
        return;
      }

      const slug = input.slug
        ? await generateUniqueAccommodationSlug(input.slug)
        : await generateUniqueAccommodationSlug(input.name);

      const accommodation = await prisma.accommodation.create({
        data: {
          name: input.name,
          slug,
          status: ItineraryStatus.DRAFT, // Always initialize as DRAFT
          authorId: req.user!.userId,
          type: input.type,
          serviceTier: input.serviceTier,
          starRating: input.starRating,
          locationText: input.locationText,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description,
          amenities: input.amenities,
          pricePerNight: input.priceOnRequest ? null : input.pricePerNight,
          priceOnRequest: input.priceOnRequest,
          destinationId: input.destinationId || null,
          images: {
            create: input.images.map((img) => ({
              url: img.url,
              cloudinaryPublicId: img.cloudinaryPublicId || null,
              sortOrder: img.sortOrder,
              altText: img.altText,
            })),
          },
        },
        include: accommodationInclude,
      });

      res.status(201).json({ status: "ok", accommodation });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4. PUT /accommodations/:id — Update & (if published) stage ────
//
// PUBLISHED accommodations get a review gate: instead of writing straight to
// the live record, the payload is staged as an AccommodationRevision, and an
// admin applies it later via PATCH /:id/publish-changes. DRAFT/IN_REVIEW
// records aren't live yet, so they keep writing straight through.
accommodationsRouter.put(
  "/:id",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.accommodation.findUnique({ where: { id } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }

      const parseResult = updateAccommodationSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;

      if (!(await destinationExists(input.destinationId))) {
        res.status(400).json({ status: "error", message: "Referenced destination does not exist" });
        return;
      }

      if (existing.status === ItineraryStatus.PUBLISHED) {
        await prisma.accommodationRevision.upsert({
          where: { accommodationId: id },
          create: { accommodationId: id, data: input as object, editorId: req.user!.userId },
          update: { data: input as object, editorId: req.user!.userId },
        });

        // Preview response by overlaying staged fields onto the live record —
        // nothing below is persisted to the live accommodation.
        const full = await prisma.accommodation.findUnique({ where: { id }, include: accommodationInclude });
        const preview = await buildRevisionPreview(full!, input);

        res.json({ status: "ok", accommodation: preview, pendingReview: true });
        return;
      }

      const updated = await applyAccommodationUpdate(id, input, existing, req.user!.userId);
      res.json({ status: "ok", accommodation: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4a. GET /accommodations/:id/revision — Pending edit, if any ───
accommodationsRouter.get("/:id/revision", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const revision = await prisma.accommodationRevision.findUnique({
      where: { accommodationId: id },
      include: { editor: { select: { id: true, email: true, role: true } } },
    });

    if (!revision) {
      res.json({ status: "ok", revision: null, preview: null });
      return;
    }

    const parseResult = updateAccommodationSchema.safeParse(revision.data);
    const full = parseResult.success
      ? await prisma.accommodation.findUnique({ where: { id }, include: accommodationInclude })
      : null;
    const preview = full && parseResult.success ? await buildRevisionPreview(full, parseResult.data) : null;

    res.json({ status: "ok", revision, preview });
  } catch (err) {
    next(err);
  }
});

// ─── 4b. DELETE /accommodations/:id/revision — Discard pending edit
accommodationsRouter.delete(
  "/:id/revision",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      await prisma.accommodationRevision.deleteMany({ where: { accommodationId: id } });
      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4c. PATCH /accommodations/:id/publish-changes — ADMIN ONLY ────
accommodationsRouter.patch(
  "/:id/publish-changes",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const [existing, revision] = await Promise.all([
        prisma.accommodation.findUnique({ where: { id } }),
        prisma.accommodationRevision.findUnique({ where: { accommodationId: id } }),
      ]);

      if (!existing) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }
      if (!revision) {
        res.status(404).json({ status: "error", message: "No pending changes to publish" });
        return;
      }

      // Re-validate the stored payload — it was valid when saved, but the
      // schema or referenced destination may have moved on since.
      const parseResult = updateAccommodationSchema.safeParse(revision.data);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "The pending revision is no longer valid — re-edit and save again before publishing.",
          errors: parseResult.error.flatten(),
        });
        return;
      }
      const input = parseResult.data;

      if (!(await destinationExists(input.destinationId))) {
        res.status(400).json({
          status: "error",
          message: "The pending revision references a destination that no longer exists — re-edit and save again.",
        });
        return;
      }

      const updated = await applyAccommodationUpdate(id, input, existing, req.user!.userId);
      await prisma.accommodationRevision.deleteMany({ where: { accommodationId: id } });

      res.json({ status: "ok", accommodation: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 5. PATCH /accommodations/:id/publish — ADMIN ONLY ────────────
accommodationsRouter.patch(
  "/:id/publish",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const accommodation = await prisma.accommodation.findUnique({ where: { id } });

      if (!accommodation) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }

      // Ready-to-publish validation
      if (!accommodation.name || accommodation.name.trim() === "") {
        res.status(400).json({ status: "error", message: "Accommodation name cannot be empty" });
        return;
      }
      if (!accommodation.locationText || accommodation.locationText.trim() === "") {
        res.status(400).json({ status: "error", message: "Accommodation must have a location before publishing" });
        return;
      }
      if (
        !accommodation.priceOnRequest &&
        (accommodation.pricePerNight === null || accommodation.pricePerNight === undefined)
      ) {
        res.status(400).json({
          status: "error",
          message: "Accommodation must have a price per night when price on request is false",
        });
        return;
      }

      const published = await prisma.accommodation.update({
        where: { id },
        data: {
          status: ItineraryStatus.PUBLISHED,
          publishedAt: new Date(),
          editorId: req.user!.userId,
        },
        include: accommodationInclude,
      });

      res.json({ status: "ok", accommodation: published });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 6. PATCH /accommodations/:id/archive — ADMIN ONLY ────────────
accommodationsRouter.patch(
  "/:id/archive",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.accommodation.findUnique({ where: { id } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }

      const archived = await prisma.accommodation.update({
        where: { id },
        data: { status: ItineraryStatus.ARCHIVED, editorId: req.user!.userId },
        include: accommodationInclude,
      });

      res.json({ status: "ok", accommodation: archived });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 7. DELETE /accommodations/:id — ADMIN ONLY ───────────────────
accommodationsRouter.delete(
  "/:id",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.accommodation.findUnique({
        where: { id },
        include: { images: true },
      });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }

      // Best-effort cleanup of Cloudinary assets before the DB cascade removes
      // the image rows — a failure here shouldn't block the delete.
      for (const image of existing.images) {
        if (image.cloudinaryPublicId) {
          try {
            await deleteCloudinaryAsset(image.cloudinaryPublicId);
          } catch (cloudinaryErr) {
            console.warn(`Failed to delete asset from Cloudinary (${image.cloudinaryPublicId}):`, cloudinaryErr);
          }
        }
      }

      await prisma.accommodation.delete({ where: { id } });

      res.json({ status: "ok", message: "Accommodation deleted successfully" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 8. POST /accommodations/:id/images — Add gallery image ───────
accommodationsRouter.post(
  "/:id/images",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const accommodationId = req.params.id as string;
      const existing = await prisma.accommodation.findUnique({ where: { id: accommodationId } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Accommodation not found" });
        return;
      }

      const parseResult = addImageSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;
      const image = await prisma.accommodationImage.create({
        data: {
          accommodationId,
          url: input.url,
          cloudinaryPublicId: input.cloudinaryPublicId || null,
          sortOrder: input.sortOrder,
          altText: input.altText,
        },
      });

      res.status(201).json({ status: "ok", image });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 9. DELETE /accommodations/:id/images/:imageId — Remove image ─
accommodationsRouter.delete(
  "/:id/images/:imageId",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const accommodationId = req.params.id as string;
      const imageId = req.params.imageId as string;

      const image = await prisma.accommodationImage.findFirst({
        where: { id: imageId, accommodationId },
      });

      if (!image) {
        res.status(404).json({ status: "error", message: "Image not found on this accommodation" });
        return;
      }

      if (image.cloudinaryPublicId) {
        try {
          await deleteCloudinaryAsset(image.cloudinaryPublicId);
        } catch (cloudinaryErr) {
          console.warn(`Failed to delete asset from Cloudinary (${image.cloudinaryPublicId}):`, cloudinaryErr);
        }
      }

      await prisma.accommodationImage.delete({ where: { id: imageId } });

      res.json({ status: "ok", message: "Image removed successfully" });
    } catch (err) {
      next(err);
    }
  }
);
