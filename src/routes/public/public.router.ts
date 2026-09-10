import { Router } from "express";
import { ItineraryStatus } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { publicItineraryQuerySchema } from "./public.schemas.js";
import { publicItinerarySummarySelect, publicItineraryDetailSelect } from "./public.serializers.js";

// Anonymous, public-facing read routes for the marketing site. Nothing in
// this router calls requireAuth — every query here is scoped to
// status: PUBLISHED only, and every response goes through the field
// allowlists in public.serializers.ts so staff identities and unpublished
// content are structurally impossible to leak.
export const publicRouter = Router();

const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

// ─── 1. GET /public/itineraries — paginated PUBLISHED summaries ───
publicRouter.get("/itineraries", async (req, res, next) => {
  try {
    const parseResult = publicItineraryQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid query parameters",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { page, limit } = parseResult.data;
    const skip = (page - 1) * limit;
    const where = { status: ItineraryStatus.PUBLISHED };

    const [total, itineraries] = await Promise.all([
      prisma.itinerary.count({ where }),
      prisma.itinerary.findMany({
        where,
        skip,
        take: limit,
        orderBy: { publishedAt: "desc" },
        select: publicItinerarySummarySelect,
      }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
    res.json({
      status: "ok",
      data: itineraries,
      pagination: { page, limit, total, totalPages },
    });
  } catch (err) {
    next(err);
  }
});

// ─── 2. GET /public/itineraries/:slug — one PUBLISHED itinerary ───
publicRouter.get("/itineraries/:slug", async (req, res, next) => {
  try {
    const slug = req.params.slug as string;

    const itinerary = await prisma.itinerary.findFirst({
      where: { slug, status: ItineraryStatus.PUBLISHED },
      select: publicItineraryDetailSelect,
    });

    if (!itinerary) {
      // Identical 404 whether the slug doesn't exist at all, or exists but
      // is DRAFT/IN_REVIEW/ARCHIVED — a public visitor must never be able
      // to distinguish "no such itinerary" from "not published yet".
      res.status(404).json({ status: "error", message: "Itinerary not found" });
      return;
    }

    res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
    res.json({ status: "ok", itinerary });
  } catch (err) {
    next(err);
  }
});

// ─── 3. GET /public/destinations — destinations with >=1 published itinerary
publicRouter.get("/destinations", async (_req, res, next) => {
  try {
    const destinations = await prisma.destination.findMany({
      where: {
        itineraries: {
          some: { itinerary: { status: ItineraryStatus.PUBLISHED } },
        },
      },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    });

    res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
    res.json({ status: "ok", data: destinations });
  } catch (err) {
    next(err);
  }
});
