import { Router } from "express";
import { Role, ItineraryStatus } from "@prisma/client";
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
} from "./itineraries.schemas.js";

export const itinerariesRouter = Router();

// All routes under /itineraries require authentication at minimum
itinerariesRouter.use(requireAuth);

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
      include: {
        days: { orderBy: { dayNumber: "asc" } },
        images: { orderBy: { sortOrder: "asc" } },
        destinations: {
          include: {
            destination: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
        author: { select: { id: true, email: true, role: true } },
        editor: { select: { id: true, email: true, role: true } },
      },
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
          availabilityStatus: input.availabilityStatus,
          days: {
            create: input.days.map((d) => ({
              dayNumber: d.dayNumber,
              title: d.title,
              description: d.description,
              accommodation: d.accommodation,
              activities: d.activities,
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
        include: {
          days: { orderBy: { dayNumber: "asc" } },
          images: { orderBy: { sortOrder: "asc" } },
          destinations: {
            include: {
              destination: {
                select: { id: true, name: true, slug: true },
              },
            },
          },
          author: { select: { id: true, email: true, role: true } },
          editor: { select: { id: true, email: true, role: true } },
        },
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

      // Generate slug if title or slug was changed
      let slug: string | undefined = undefined;
      if (input.slug) {
        slug = await generateUniqueItinerarySlug(input.slug, id);
      } else if (input.title && input.title !== existing.title) {
        slug = await generateUniqueItinerarySlug(input.title, id);
      }

      // Execute updates atomically via transaction
      const updated = await prisma.$transaction(async (tx) => {
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
            editorId: req.user!.userId,
            overview: input.overview,
            nights: input.nights,
            startingPrice,
            priceOnRequest,
            inclusions: input.inclusions,
            exclusions: input.exclusions,
            travelInfo: input.travelInfo,
            routeMapUrl: input.routeMapUrl !== undefined ? input.routeMapUrl || null : undefined,
            availabilityStatus: input.availabilityStatus,
          },
          include: {
            days: { orderBy: { dayNumber: "asc" } },
            images: { orderBy: { sortOrder: "asc" } },
            destinations: {
              include: {
                destination: {
                  select: { id: true, name: true, slug: true },
                },
              },
            },
            author: { select: { id: true, email: true, role: true } },
            editor: { select: { id: true, email: true, role: true } },
          },
        });
      });

      res.json({
        status: "ok",
        itinerary: updated,
      });
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
        include: {
          days: { orderBy: { dayNumber: "asc" } },
          images: { orderBy: { sortOrder: "asc" } },
          destinations: {
            include: {
              destination: {
                select: { id: true, name: true, slug: true },
              },
            },
          },
          author: { select: { id: true, email: true, role: true } },
          editor: { select: { id: true, email: true, role: true } },
        },
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
        include: {
          days: { orderBy: { dayNumber: "asc" } },
          images: { orderBy: { sortOrder: "asc" } },
          destinations: {
            include: {
              destination: {
                select: { id: true, name: true, slug: true },
              },
            },
          },
          author: { select: { id: true, email: true, role: true } },
          editor: { select: { id: true, email: true, role: true } },
        },
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
