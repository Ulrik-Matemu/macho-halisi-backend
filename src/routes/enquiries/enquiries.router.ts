import { Router } from "express";
import { EnquiryStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  ENQUIRY_EXPORT_LIMIT,
  bulkEnquirySchema,
  enquiryExportQuerySchema,
  enquiryIdSchema,
  enquiryListQuerySchema,
  updateEnquirySchema,
} from "./enquiries.schemas.js";

// Staff-side enquiry inbox. Submissions arrive anonymously via
// POST /public/enquiries; everything here is ADMIN-only since enquiries
// carry guests' personal contact details.
export const enquiriesRouter = Router();

enquiriesRouter.use(requireAuth, requireRole(Role.ADMIN));

const enquirySelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  partySize: true,
  preferredDates: true,
  message: true,
  status: true,
  source: true,
  pagePath: true,
  referrerHost: true,
  utmSource: true,
  country: true,
  city: true,
  sessionId: true,
  staffNotes: true,
  respondedAt: true,
  createdAt: true,
  updatedAt: true,
  itinerary: { select: { id: true, title: true, slug: true } },
  handledBy: { select: { id: true, email: true } },
} satisfies Prisma.EnquirySelect;

// Shared by the inbox list and the export so both match the same rows.
function buildWhere(status?: EnquiryStatus, q?: string): Prisma.EnquiryWhereInput {
  return {
    ...(status && { status }),
    ...(q && {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
      ],
    }),
  };
}

// GET /enquiries — paginated inbox with status filter and search
enquiriesRouter.get("/", async (req, res, next) => {
  try {
    const parseResult = enquiryListQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid query parameters",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { page, limit, status, q } = parseResult.data;
    const skip = (page - 1) * limit;
    const where = buildWhere(status, q);

    const [total, enquiries] = await Promise.all([
      prisma.enquiry.count({ where }),
      prisma.enquiry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: enquirySelect,
      }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      status: "ok",
      data: enquiries,
      pagination: { page, limit, total, totalPages },
    });
  } catch (err) {
    next(err);
  }
});

// GET /enquiries/stats — counts by status, for the sidebar badge and overview
enquiriesRouter.get("/stats", async (_req, res, next) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [grouped, last7d] = await Promise.all([
      prisma.enquiry.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.enquiry.count({ where: { createdAt: { gte: weekAgo } } }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(EnquiryStatus).map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])
    ) as Record<EnquiryStatus, number>;

    res.json({
      status: "ok",
      byStatus,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      last7d,
    });
  } catch (err) {
    next(err);
  }
});

// GET /enquiries/export — every matching enquiry (unpaginated, capped) for
// PDF/XLSX reports built in the dashboard. `ids` overrides the filters.
enquiriesRouter.get("/export", async (req, res, next) => {
  try {
    const parseResult = enquiryExportQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid query parameters",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { status, q, ids } = parseResult.data;
    const where: Prisma.EnquiryWhereInput = ids ? { id: { in: ids } } : buildWhere(status, q);
    const enquiries = await prisma.enquiry.findMany({
      where,
      take: ENQUIRY_EXPORT_LIMIT + 1,
      orderBy: { createdAt: "desc" },
      select: enquirySelect,
    });

    res.json({
      status: "ok",
      data: enquiries.slice(0, ENQUIRY_EXPORT_LIMIT),
      truncated: enquiries.length > ENQUIRY_EXPORT_LIMIT,
    });
  } catch (err) {
    next(err);
  }
});

// POST /enquiries/bulk — delete or re-status several enquiries at once
enquiriesRouter.post("/bulk", async (req, res, next) => {
  try {
    const parseResult = bulkEnquirySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { ids, action, status } = parseResult.data;
    const where = { id: { in: ids } };

    if (action === "delete") {
      const { count } = await prisma.enquiry.deleteMany({ where });
      res.json({ status: "ok", count });
      return;
    }

    const count = await prisma.$transaction(async (tx) => {
      // Stamp the first response only, as the single PATCH does.
      if (status === EnquiryStatus.RESPONDED) {
        await tx.enquiry.updateMany({ where: { ...where, respondedAt: null }, data: { respondedAt: new Date() } });
      }
      const result = await tx.enquiry.updateMany({
        where,
        data: { status, handledById: req.user!.userId },
      });
      return result.count;
    });

    res.json({ status: "ok", count });
  } catch (err) {
    next(err);
  }
});

// GET /enquiries/:id — full enquiry plus the pages viewed before enquiring
enquiriesRouter.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (!enquiryIdSchema.safeParse(id).success) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    const enquiry = await prisma.enquiry.findUnique({ where: { id }, select: enquirySelect });
    if (!enquiry) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    const journey = enquiry.sessionId
      ? await prisma.analyticsEvent.findMany({
          where: { sessionId: enquiry.sessionId, type: "PAGEVIEW", createdAt: { lte: enquiry.createdAt } },
          orderBy: { createdAt: "asc" },
          select: { path: true, createdAt: true },
          take: 50,
        })
      : [];

    res.json({ status: "ok", enquiry, journey });
  } catch (err) {
    next(err);
  }
});

// PATCH /enquiries/:id — update status and/or staff notes
enquiriesRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (!enquiryIdSchema.safeParse(id).success) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    const parseResult = updateEnquirySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const existing = await prisma.enquiry.findUnique({
      where: { id },
      select: { id: true, respondedAt: true },
    });
    if (!existing) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    const { status, staffNotes } = parseResult.data;
    const enquiry = await prisma.enquiry.update({
      where: { id },
      data: {
        ...(status !== undefined && { status }),
        ...(staffNotes !== undefined && { staffNotes: staffNotes || null }),
        handledById: req.user!.userId,
        // Stamp the first response only — moving on to CLOSED keeps it.
        ...(status === EnquiryStatus.RESPONDED && !existing.respondedAt && { respondedAt: new Date() }),
      },
      select: enquirySelect,
    });

    res.json({ status: "ok", enquiry });
  } catch (err) {
    next(err);
  }
});

// DELETE /enquiries/:id — permanent removal (e.g. a guest's erasure request)
enquiriesRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (!enquiryIdSchema.safeParse(id).success) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    const { count } = await prisma.enquiry.deleteMany({ where: { id } });
    if (count === 0) {
      res.status(404).json({ status: "error", message: "Enquiry not found" });
      return;
    }

    res.json({ status: "ok", message: "Enquiry deleted" });
  } catch (err) {
    next(err);
  }
});
