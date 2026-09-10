import { Router } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { generateUniqueDestinationSlug } from "../../lib/slug.js";
import { createDestinationSchema } from "./destinations.schemas.js";

export const destinationsRouter = Router();

// All destinations routes require authentication at minimum
destinationsRouter.use(requireAuth);

// ─── 1. GET /destinations — List all destinations ──────────────
destinationsRouter.get("/", async (_req, res, next) => {
  try {
    const destinations = await prisma.destination.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
      },
      orderBy: { name: "asc" },
    });

    res.json({
      status: "ok",
      data: destinations,
    });
  } catch (err) {
    next(err);
  }
});

// ─── 2. POST /destinations — Create destination ────────────────
destinationsRouter.post(
  "/",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  async (req, res, next) => {
    try {
      const parseResult = createDestinationSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const { name } = parseResult.data;

      // Case-insensitive check for existing destination name
      const existing = await prisma.destination.findFirst({
        where: {
          name: {
            equals: name,
            mode: "insensitive",
          },
        },
      });

      if (existing) {
        res.status(409).json({
          status: "error",
          message: "A destination with this name already exists",
        });
        return;
      }

      const slug = await generateUniqueDestinationSlug(name);

      const destination = await prisma.destination.create({
        data: {
          name,
          slug,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        status: "ok",
        destination,
      });
    } catch (err) {
      next(err);
    }
  }
);
