import { Router } from "express";
import { Role, ItineraryStatus, Itinerary, Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { generateUniqueItinerarySlug } from "../../lib/slug.js";
import { deleteCloudinaryAsset } from "../../lib/cloudinary.js";
import {
  createItinerarySchema,
  updateItinerarySchema,
  addImageSchema,
  itineraryQuerySchema,
  availabilityPeriodInputSchema,
  UpdateItineraryInput,
} from "./itineraries.schemas.js";

export const itinerariesRouter = Router();

// All routes under /itineraries require authentication at minimum
itinerariesRouter.use(requireAuth);

// Shared `include` for every full-detail itinerary response (GET, POST,
// PUT, publish, archive, publish-changes) — one canonical shape instead of
// six copies drifting apart.
const itineraryInclude = {
  days: {
    orderBy: { dayNumber: "asc" as const },
    include: { heroImage: { select: { id: true, url: true, altText: true } } },
  },
  images: { orderBy: { sortOrder: "asc" as const } },
  destinations: {
    include: {
      destination: {
        select: { id: true, name: true, slug: true, latitude: true, longitude: true, blurb: true },
      },
    },
  },
  availabilityPeriods: { orderBy: { startDate: "asc" as const } },
  author: { select: { id: true, email: true, role: true } },
  editor: { select: { id: true, email: true, role: true } },
} as const;

/**
 * Validates that every heroImageId in `days` references an image actually
 * belonging to this itinerary. Zod can't check a cross-record reference,
 * so this runs in the route handler before anything is written. Returns
 * the first invalid id, or null when every reference is valid.
 */
async function findInvalidHeroImageId(
  itineraryId: string,
  days: UpdateItineraryInput["days"]
): Promise<string | null> {
  const referencedImageIds = (days ?? [])
    .map((d) => d.heroImageId)
    .filter((v): v is string => Boolean(v));
  if (referencedImageIds.length === 0) return null;

  const ownedImages = await prisma.itineraryImage.findMany({
    where: { itineraryId, id: { in: referencedImageIds } },
    select: { id: true },
  });
  const ownedIds = new Set(ownedImages.map((img) => img.id));
  return referencedImageIds.find((imgId) => !ownedIds.has(imgId)) ?? null;
}

/**
 * Applies a validated update payload to the live itinerary — day replace,
 * destination replace, price calc, scalar update — in one transaction.
 * Shared by PUT /:id (when the itinerary isn't PUBLISHED yet, so there's
 * nothing to protect) and PATCH /:id/publish-changes (which applies a
 * previously-staged ItineraryRevision to a PUBLISHED itinerary).
 */
async function applyItineraryUpdate(
  id: string,
  input: UpdateItineraryInput,
  existing: Pick<Itinerary, "title" | "priceOnRequest" | "startingPrice">,
  editorId: string
) {
  // Generate slug if title or slug was changed
  let slug: string | undefined = undefined;
  if (input.slug) {
    slug = await generateUniqueItinerarySlug(input.slug, id);
  } else if (input.title && input.title !== existing.title) {
    slug = await generateUniqueItinerarySlug(input.title, id);
  }

  return prisma.$transaction(async (tx) => {
    // Replace days if provided
    if (input.days !== undefined) {
      await tx.itineraryDay.deleteMany({ where: { itineraryId: id } });
      if (input.days.length > 0) {
        await tx.itineraryDay.createMany({
          data: input.days.map((d) => ({
            itineraryId: id,
            dayNumber: d.dayNumber,
            title: d.title,
            description: d.description,
            accommodation: d.accommodation,
            activities: d.activities,
            latitude: d.latitude,
            longitude: d.longitude,
            heroImageId: d.heroImageId || null,
            highlight: d.highlight,
          })),
        });
      }
    }

    // Replace destination links if provided
    if (input.destinationIds !== undefined) {
      await tx.itineraryDestination.deleteMany({ where: { itineraryId: id } });
      if (input.destinationIds.length > 0) {
        await tx.itineraryDestination.createMany({
          data: input.destinationIds.map((destinationId) => ({
            itineraryId: id,
            destinationId,
          })),
        });
      }
    }

    // Price calculations
    const priceOnRequest =
      input.priceOnRequest !== undefined ? input.priceOnRequest : existing.priceOnRequest;
    let startingPrice = existing.startingPrice;
    if (priceOnRequest) {
      startingPrice = null;
    } else if (input.startingPrice !== undefined) {
      startingPrice = input.startingPrice as any;
    }

    // Update itinerary scalars
    return tx.itinerary.update({
      where: { id },
      data: {
        title: input.title,
        slug,
        status: input.status,
        editorId,
        overview: input.overview,
        nights: input.nights,
        startingPrice,
        priceOnRequest,
        inclusions: input.inclusions,
        exclusions: input.exclusions,
        travelInfo: input.travelInfo,
        routeMapUrl: input.routeMapUrl !== undefined ? input.routeMapUrl || null : undefined,
        showRouteMap: input.showRouteMap,
        availabilityStatus: input.availabilityStatus,
      },
      include: itineraryInclude,
    });
  });
}

/**
 * Overlays a staged (not-yet-applied) update onto the live itinerary, for
 * the PUT response when the itinerary is PUBLISHED — nothing here is
 * persisted, it's purely so the editor's screen shows the pending edit in
 * the same shape as a normal itinerary response. `full` must have been
 * fetched with `itineraryInclude`.
 */
async function buildRevisionPreview(
  full: Prisma.ItineraryGetPayload<{ include: typeof itineraryInclude }>,
  input: UpdateItineraryInput
) {
  let destinations = full.destinations;
  if (input.destinationIds !== undefined) {
    const records = await prisma.destination.findMany({
      where: { id: { in: input.destinationIds } },
      select: { id: true, name: true, slug: true, latitude: true, longitude: true, blurb: true },
    });
    const byId = new Map(records.map((d) => [d.id, d]));
    destinations = input.destinationIds
      .map((destinationId) => {
        const destination = byId.get(destinationId);
        return destination ? { itineraryId: full.id, destinationId, destination } : null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  }

  const imagesById = new Map(full.images.map((img) => [img.id, img]));
  const days =
    input.days !== undefined
      ? input.days.map((d, index) => ({
          id: full.days[index]?.id,
          itineraryId: full.id,
          dayNumber: d.dayNumber,
          title: d.title ?? null,
          description: d.description ?? null,
          accommodation: d.accommodation ?? null,
          activities: d.activities,
          latitude: d.latitude ?? null,
          longitude: d.longitude ?? null,
          heroImageId: d.heroImageId ?? null,
          heroImage: d.heroImageId ? imagesById.get(d.heroImageId) ?? null : null,
          highlight: d.highlight,
        }))
      : full.days;

  const priceOnRequest = input.priceOnRequest !== undefined ? input.priceOnRequest : full.priceOnRequest;
  const startingPrice = priceOnRequest
    ? null
    : input.startingPrice !== undefined
    ? input.startingPrice
    : full.startingPrice;

  return {
    ...full,
    title: input.title ?? full.title,
    overview: input.overview !== undefined ? input.overview : full.overview,
    nights: input.nights !== undefined ? input.nights : full.nights,
    startingPrice,
    priceOnRequest,
    inclusions: input.inclusions ?? full.inclusions,
    exclusions: input.exclusions ?? full.exclusions,
    travelInfo: input.travelInfo !== undefined ? input.travelInfo : full.travelInfo,
    routeMapUrl: input.routeMapUrl !== undefined ? input.routeMapUrl || null : full.routeMapUrl,
    showRouteMap: input.showRouteMap !== undefined ? input.showRouteMap : full.showRouteMap,
    availabilityStatus: input.availabilityStatus ?? full.availabilityStatus,
    days,
    destinations,
  };
}

// ─── 1. GET /itineraries — List lightweight summaries ─────────
itinerariesRouter.get("/", async (req, res, next) => {
  try {
    const parseResult = itineraryQuerySchema.safeParse(req.query);
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

    const [total, itineraries] = await Promise.all([
      prisma.itinerary.count({ where }),
      prisma.itinerary.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          nights: true,
          startingPrice: true,
          priceOnRequest: true,
          availabilityStatus: true,
          publishedAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      status: "ok",
      data: itineraries,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── 2. GET /itineraries/:id — Full detail with nested relations
itinerariesRouter.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const itinerary = await prisma.itinerary.findUnique({
      where: { id },
      include: itineraryInclude,
    });

    if (!itinerary) {
      res.status(404).json({ status: "error", message: "Itinerary not found" });
      return;
    }

    res.json({
      status: "ok",
      itinerary,
    });
  } catch (err) {
    next(err);
  }
});

// ─── 3. POST /itineraries — Create DRAFT itinerary ────────────
itinerariesRouter.post(
  "/",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const parseResult = createItinerarySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;
      const slug = input.slug
        ? await generateUniqueItinerarySlug(input.slug)
        : await generateUniqueItinerarySlug(input.title);

      const itinerary = await prisma.itinerary.create({
        data: {
          title: input.title,
          slug,
          status: ItineraryStatus.DRAFT, // Always initialize as DRAFT
          authorId: req.user!.userId,
          overview: input.overview,
          nights: input.nights,
          startingPrice: input.priceOnRequest ? null : input.startingPrice,
          priceOnRequest: input.priceOnRequest,
          inclusions: input.inclusions,
          exclusions: input.exclusions,
          travelInfo: input.travelInfo,
          routeMapUrl: input.routeMapUrl || null,
          showRouteMap: input.showRouteMap,
          availabilityStatus: input.availabilityStatus,
          days: {
            // heroImageId is intentionally not wired here — images are
            // created in this same call, so the client can't yet know
            // their IDs to reference. Set it via a later PUT once images
            // exist (matches the existing upload-after-create workflow).
            create: input.days.map((d) => ({
              dayNumber: d.dayNumber,
              title: d.title,
              description: d.description,
              accommodation: d.accommodation,
              activities: d.activities,
              latitude: d.latitude,
              longitude: d.longitude,
              highlight: d.highlight,
            })),
          },
          images: {
            create: input.images.map((img) => ({
              url: img.url,
              cloudinaryPublicId: img.cloudinaryPublicId || null,
              sortOrder: img.sortOrder,
              altText: img.altText,
            })),
          },
          destinations: {
            create: input.destinationIds.map((destinationId) => ({
              destinationId,
            })),
          },
        },
        include: itineraryInclude,
      });

      res.status(201).json({
        status: "ok",
        itinerary,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4. PUT /itineraries/:id — Update itinerary & replace days ─
//
// PUBLISHED itineraries get a review gate: instead of writing straight to
// the live record, the payload is staged as an ItineraryRevision, and an
// admin applies it later via PATCH /:id/publish-changes. DRAFT/IN_REVIEW
// itineraries aren't live yet, so there's nothing to protect — they keep
// writing straight through, exactly as before this gate existed.
itinerariesRouter.put(
  "/:id",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.itinerary.findUnique({
        where: { id },
      });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }

      const parseResult = updateItinerarySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;

      const invalidHeroImageId = await findInvalidHeroImageId(id, input.days);
      if (invalidHeroImageId) {
        res.status(400).json({
          status: "error",
          message: `heroImageId ${invalidHeroImageId} does not reference an image belonging to this itinerary`,
        });
        return;
      }

      if (existing.status === ItineraryStatus.PUBLISHED) {
        await prisma.itineraryRevision.upsert({
          where: { itineraryId: id },
          create: { itineraryId: id, data: input as object, editorId: req.user!.userId },
          update: { data: input as object, editorId: req.user!.userId },
        });

        // Build a preview response by overlaying the staged fields onto the
        // live record, so the editor keeps rendering from the same shape —
        // nothing below is actually persisted to the live itinerary/days/
        // destinations tables. Slug is deliberately left as the live value
        // here (not regenerated) since it drives the public URL and must
        // not change until the revision is actually published.
        const full = await prisma.itinerary.findUnique({ where: { id }, include: itineraryInclude });
        const preview = await buildRevisionPreview(full!, input);

        res.json({ status: "ok", itinerary: preview, pendingReview: true });
        return;
      }

      const updated = await applyItineraryUpdate(id, input, existing, req.user!.userId);

      res.json({
        status: "ok",
        itinerary: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4a. GET /itineraries/:id/revision — Pending edit, if any ──
// Same access as GET /:id (no extra role gate beyond requireAuth) — used
// on editor page load to resume an in-flight draft or notice a pending
// change left by another editor. Also returns `preview` — the same
// live-record-plus-revision merge the PUBLISHED branch of PUT /:id
// computes — so the frontend never has to reimplement that merge itself.
itinerariesRouter.get("/:id/revision", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const revision = await prisma.itineraryRevision.findUnique({
      where: { itineraryId: id },
      include: { editor: { select: { id: true, email: true, role: true } } },
    });

    if (!revision) {
      res.json({ status: "ok", revision: null, preview: null });
      return;
    }

    const parseResult = updateItinerarySchema.safeParse(revision.data);
    const full = parseResult.success
      ? await prisma.itinerary.findUnique({ where: { id }, include: itineraryInclude })
      : null;
    const preview = full && parseResult.success ? await buildRevisionPreview(full, parseResult.data) : null;

    res.json({ status: "ok", revision, preview });
  } catch (err) {
    next(err);
  }
});

// ─── 4b. DELETE /itineraries/:id/revision — Discard pending edit
// Same role gate as PUT — discarding is just abandoning your own
// in-progress edit, not a publish/status decision.
itinerariesRouter.delete(
  "/:id/revision",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      await prisma.itineraryRevision.deleteMany({ where: { itineraryId: id } });
      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 4c. PATCH /itineraries/:id/publish-changes — ADMIN ONLY ───
// Applies a pending ItineraryRevision to the live record and clears it —
// the actual "go live" moment for an edit made after the itinerary was
// already published. Mirrors /publish and /archive in being ADMIN-only.
itinerariesRouter.patch(
  "/:id/publish-changes",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const [existing, revision] = await Promise.all([
        prisma.itinerary.findUnique({ where: { id } }),
        prisma.itineraryRevision.findUnique({ where: { itineraryId: id } }),
      ]);

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }
      if (!revision) {
        res.status(404).json({ status: "error", message: "No pending changes to publish" });
        return;
      }

      // Re-validate the stored payload — it was valid when saved, but the
      // schema or the itinerary's own image set may have moved on since.
      const parseResult = updateItinerarySchema.safeParse(revision.data);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "The pending revision is no longer valid — re-edit and save again before publishing.",
          errors: parseResult.error.flatten(),
        });
        return;
      }
      const input = parseResult.data;

      const invalidHeroImageId = await findInvalidHeroImageId(id, input.days);
      if (invalidHeroImageId) {
        res.status(400).json({
          status: "error",
          message: `heroImageId ${invalidHeroImageId} no longer references an image belonging to this itinerary — re-edit and save again.`,
        });
        return;
      }

      const updated = await applyItineraryUpdate(id, input, existing, req.user!.userId);
      // Small window between the apply transaction and this delete rather
      // than one atomic unit — acceptable here: worst case a stale
      // revision briefly reappears in GET /:id/revision after a concurrent
      // retry, not a data-loss risk (the live record is already correct).
      await prisma.itineraryRevision.deleteMany({ where: { itineraryId: id } });

      res.json({ status: "ok", itinerary: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 5. PATCH /itineraries/:id/publish — ADMIN ONLY ───────────
itinerariesRouter.patch(
  "/:id/publish",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const itinerary = await prisma.itinerary.findUnique({
        where: { id },
        include: { days: true },
      });

      if (!itinerary) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }

      // Ready-to-publish validation
      if (itinerary.days.length === 0) {
        res.status(400).json({
          status: "error",
          message: "Itinerary must have at least one day defined before publishing",
        });
        return;
      }

      if (!itinerary.title || itinerary.title.trim() === "") {
        res.status(400).json({
          status: "error",
          message: "Itinerary title cannot be empty",
        });
        return;
      }

      if (!itinerary.priceOnRequest && (itinerary.startingPrice === null || itinerary.startingPrice === undefined)) {
        res.status(400).json({
          status: "error",
          message: "Itinerary must have a starting price when price on request is false",
        });
        return;
      }

      const published = await prisma.itinerary.update({
        where: { id },
        data: {
          status: ItineraryStatus.PUBLISHED,
          publishedAt: new Date(),
          editorId: req.user!.userId,
        },
        include: itineraryInclude,
      });

      res.json({
        status: "ok",
        itinerary: published,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 6. PATCH /itineraries/:id/archive — ADMIN ONLY ───────────
itinerariesRouter.patch(
  "/:id/archive",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.itinerary.findUnique({ where: { id } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }

      const archived = await prisma.itinerary.update({
        where: { id },
        data: {
          status: ItineraryStatus.ARCHIVED,
          editorId: req.user!.userId,
        },
        include: itineraryInclude,
      });

      res.json({
        status: "ok",
        itinerary: archived,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 7. DELETE /itineraries/:id — ADMIN ONLY ───────────────────
itinerariesRouter.delete(
  "/:id",
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const existing = await prisma.itinerary.findUnique({ where: { id } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }

      await prisma.itinerary.delete({ where: { id } });

      res.json({
        status: "ok",
        message: "Itinerary deleted successfully",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 8. POST /itineraries/:id/images — Add gallery image ──────
itinerariesRouter.post(
  "/:id/images",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const itineraryId = req.params.id as string;
      const existing = await prisma.itinerary.findUnique({ where: { id: itineraryId } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
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
      const image = await prisma.itineraryImage.create({
        data: {
          itineraryId,
          url: input.url,
          cloudinaryPublicId: input.cloudinaryPublicId || null,
          sortOrder: input.sortOrder,
          altText: input.altText,
        },
      });

      res.status(201).json({
        status: "ok",
        image,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 9. DELETE /itineraries/:id/images/:imageId — Remove image ─
itinerariesRouter.delete(
  "/:id/images/:imageId",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const itineraryId = req.params.id as string;
      const imageId = req.params.imageId as string;

      const image = await prisma.itineraryImage.findFirst({
        where: {
          id: imageId,
          itineraryId,
        },
      });

      if (!image) {
        res.status(404).json({ status: "error", message: "Image not found on this itinerary" });
        return;
      }

      // If asset was uploaded to Cloudinary, delete it from Cloudinary storage
      if (image.cloudinaryPublicId) {
        try {
          await deleteCloudinaryAsset(image.cloudinaryPublicId);
        } catch (cloudinaryErr) {
          console.warn(`Failed to delete asset from Cloudinary (${image.cloudinaryPublicId}):`, cloudinaryErr);
        }
      }

      await prisma.itineraryImage.delete({ where: { id: imageId } });

      res.json({
        status: "ok",
        message: "Image removed successfully",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 10. POST /itineraries/:id/availability-periods — Add a dated
// availability period ───────────────────────────────────────────
// Supplementary calendar detail only — Itinerary.availabilityStatus
// remains the single, manually set badge shown on cards and the
// detail-page sidebar. These periods are managed as their own
// dedicated resource (create/update/delete below), the same pattern
// as gallery images above — not folded into the PUT /:id autosave
// payload, which would mean replacing the whole list on every save.
itinerariesRouter.post(
  "/:id/availability-periods",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const itineraryId = req.params.id as string;
      const existing = await prisma.itinerary.findUnique({ where: { id: itineraryId } });

      if (!existing) {
        res.status(404).json({ status: "error", message: "Itinerary not found" });
        return;
      }

      const parseResult = availabilityPeriodInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;
      const period = await prisma.availabilityPeriod.create({
        data: {
          itineraryId,
          startDate: input.startDate,
          endDate: input.endDate,
          status: input.status,
          note: input.note || null,
        },
      });

      res.status(201).json({
        status: "ok",
        period,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 11. PATCH /itineraries/:id/availability-periods/:periodId —
// Update a dated availability period ────────────────────────────
itinerariesRouter.patch(
  "/:id/availability-periods/:periodId",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const itineraryId = req.params.id as string;
      const periodId = req.params.periodId as string;

      const existingPeriod = await prisma.availabilityPeriod.findFirst({
        where: { id: periodId, itineraryId },
      });

      if (!existingPeriod) {
        res.status(404).json({ status: "error", message: "Availability period not found on this itinerary" });
        return;
      }

      const parseResult = availabilityPeriodInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const input = parseResult.data;
      const period = await prisma.availabilityPeriod.update({
        where: { id: periodId },
        data: {
          startDate: input.startDate,
          endDate: input.endDate,
          status: input.status,
          note: input.note || null,
        },
      });

      res.json({
        status: "ok",
        period,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── 12. DELETE /itineraries/:id/availability-periods/:periodId —
// Remove a dated availability period ─────────────────────────────
itinerariesRouter.delete(
  "/:id/availability-periods/:periodId",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const itineraryId = req.params.id as string;
      const periodId = req.params.periodId as string;

      const existingPeriod = await prisma.availabilityPeriod.findFirst({
        where: { id: periodId, itineraryId },
      });

      if (!existingPeriod) {
        res.status(404).json({ status: "error", message: "Availability period not found on this itinerary" });
        return;
      }

      await prisma.availabilityPeriod.delete({ where: { id: periodId } });

      res.json({
        status: "ok",
        message: "Availability period removed successfully",
      });
    } catch (err) {
      next(err);
    }
  }
);
