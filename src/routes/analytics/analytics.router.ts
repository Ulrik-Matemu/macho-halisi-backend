import { Router } from "express";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ingestLimiter } from "../../middleware/rateLimit.js";
import { secretsMatch } from "../../lib/secret.js";
import { rangeQuerySchema, resolveWindow, utc } from "../../lib/range.js";
import {
  ingestBatchSchema,
  breakdownQuerySchema,
  type BreakdownDimension,
} from "./analytics.schemas.js";

// Self-hosted, cookieless web analytics. Writes arrive only from the
// Next.js server (shared secret) — it resolves geo from Vercel's edge
// headers and replaces the visitor IP with a daily-rotating hash before
// anything reaches this router. Every read is ADMIN-only.
export const analyticsRouter = Router();

// A session with no activity for this long is no longer "active now".
const REALTIME_WINDOW_MINUTES = 5;

/** `"createdAt"` within [from, to), bound as explicit UTC — see lib/range.ts. */
function within(from: Date, to: Date) {
  return Prisma.sql`"createdAt" >= (${utc(from)}::timestamptz AT TIME ZONE 'UTC')
    AND "createdAt" < (${utc(to)}::timestamptz AT TIME ZONE 'UTC')`;
}

function badQuery(res: import("express").Response, error: { flatten: () => unknown }) {
  res.status(400).json({ status: "error", message: "Invalid query parameters", errors: error.flatten() });
}

// ─── POST /analytics/ingest — batch write from the Next.js server ───
analyticsRouter.post("/ingest", ingestLimiter, async (req, res, next) => {
  try {
    if (!secretsMatch(req.headers["x-ingest-secret"], env.ANALYTICS_INGEST_SECRET)) {
      res.status(401).json({ status: "error", message: "Invalid ingest secret" });
      return;
    }

    const parseResult = ingestBatchSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid analytics batch",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { count } = await prisma.analyticsEvent.createMany({
      data: parseResult.data.events.map((e) => ({
        ...e,
        country: e.country?.toUpperCase() ?? null,
        metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });

    res.status(202).json({ status: "ok", accepted: count });
  } catch (err) {
    next(err);
  }
});

// Every route below is admin-only.
analyticsRouter.use(requireAuth, requireRole(Role.ADMIN));

interface OverviewRow {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounced: number;
  avg_duration_s: number | null;
}

async function overviewFor(from: Date, to: Date) {
  const [row] = await prisma.$queryRaw<OverviewRow[]>`
    WITH s AS (
      SELECT "sessionId",
             COUNT(*) FILTER (WHERE type = 'PAGEVIEW') AS pv,
             EXTRACT(EPOCH FROM MAX("createdAt") - MIN("createdAt")) AS dur
      FROM analytics_events
      WHERE ${within(from, to)}
      GROUP BY "sessionId"
    )
    SELECT
      (SELECT COUNT(DISTINCT "visitorHash") FROM analytics_events
         WHERE type = 'PAGEVIEW' AND ${within(from, to)})::int AS visitors,
      COALESCE(SUM(pv), 0)::int AS pageviews,
      (COUNT(*) FILTER (WHERE pv > 0))::int AS sessions,
      (COUNT(*) FILTER (WHERE pv = 1))::int AS bounced,
      (AVG(dur) FILTER (WHERE pv > 0))::float AS avg_duration_s
    FROM s`;

  const enquiries = await prisma.enquiry.count({
    where: { createdAt: { gte: from, lt: to } },
  });

  const sessions = row?.sessions ?? 0;
  return {
    visitors: row?.visitors ?? 0,
    pageviews: row?.pageviews ?? 0,
    sessions,
    bounceRate: sessions ? (row!.bounced / sessions) : 0,
    avgSessionSeconds: Math.round(row?.avg_duration_s ?? 0),
    pagesPerSession: sessions ? (row!.pageviews / sessions) : 0,
    enquiries,
    conversionRate: sessions ? enquiries / sessions : 0,
  };
}

// ─── GET /analytics/overview — KPIs for the window and the one before ───
analyticsRouter.get("/overview", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);

    const w = resolveWindow(parsed.data.range);
    const [current, previous] = await Promise.all([
      overviewFor(w.from, w.to),
      overviewFor(w.prevFrom, w.from),
    ]);

    res.json({ status: "ok", range: w.key, from: w.from, to: w.to, current, previous });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/timeseries — visitors / pageviews / enquiries per bucket ───
analyticsRouter.get("/timeseries", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);

    const w = resolveWindow(parsed.data.range);
    // Safe: granularity comes from resolveWindow, never from the request.
    const g = Prisma.raw(`'${w.granularity}'`);

    const rows = await prisma.$queryRaw<
      { bucket: Date; pageviews: number; visitors: number; enquiries: number }[]
    >`
      SELECT b.bucket,
             COALESCE(e.pageviews, 0)::int AS pageviews,
             COALESCE(e.visitors, 0)::int AS visitors,
             COALESCE(q.enquiries, 0)::int AS enquiries
      FROM generate_series(
        date_trunc(${g}, (${utc(w.from)}::timestamptz AT TIME ZONE 'UTC')),
        date_trunc(${g}, (${utc(w.to)}::timestamptz AT TIME ZONE 'UTC')),
        ('1 ' || ${g})::interval
      ) AS b(bucket)
      LEFT JOIN (
        SELECT date_trunc(${g}, "createdAt") AS bucket,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT "visitorHash") AS visitors
        FROM analytics_events
        WHERE type = 'PAGEVIEW' AND ${within(w.from, w.to)}
        GROUP BY 1
      ) e USING (bucket)
      LEFT JOIN (
        SELECT date_trunc(${g}, "createdAt") AS bucket, COUNT(*) AS enquiries
        FROM enquiries
        WHERE ${within(w.from, w.to)}
        GROUP BY 1
      ) q USING (bucket)
      ORDER BY b.bucket`;

    res.json({ status: "ok", range: w.key, granularity: w.granularity, data: rows });
  } catch (err) {
    next(err);
  }
});

interface BreakdownRow {
  label: string;
  value: number;
  secondary: number | null;
}

/**
 * Builds the query for one breakdown dimension. `value` is the headline
 * count (visitors, pageviews or sessions depending on the dimension) and
 * `secondary` an optional supporting count.
 */
function breakdownQuery(dimension: BreakdownDimension, from: Date, to: Date, limit: number) {
  const win = within(from, to);

  // Entry pageviews — the first PAGEVIEW of each session. The tracker only
  // sends referrer/UTM on that first hit, so source dimensions read here.
  const entries = Prisma.sql`
    SELECT DISTINCT ON ("sessionId") "sessionId", path, "referrerHost", "utmSource", "utmCampaign"
    FROM analytics_events
    WHERE type = 'PAGEVIEW' AND ${win}
    ORDER BY "sessionId", "createdAt" ASC`;

  switch (dimension) {
    case "page":
      return Prisma.sql`
        SELECT path AS label, COUNT(*)::int AS value, COUNT(DISTINCT "visitorHash")::int AS secondary
        FROM analytics_events WHERE type = 'PAGEVIEW' AND ${win}
        GROUP BY path ORDER BY value DESC LIMIT ${limit}`;
    case "entry":
      return Prisma.sql`
        SELECT path AS label, COUNT(*)::int AS value, NULL::int AS secondary
        FROM (${entries}) e GROUP BY path ORDER BY value DESC LIMIT ${limit}`;
    case "exit":
      return Prisma.sql`
        SELECT path AS label, COUNT(*)::int AS value, NULL::int AS secondary
        FROM (
          SELECT DISTINCT ON ("sessionId") "sessionId", path
          FROM analytics_events
          WHERE type = 'PAGEVIEW' AND ${win}
          ORDER BY "sessionId", "createdAt" DESC
        ) x GROUP BY path ORDER BY value DESC LIMIT ${limit}`;
    case "referrer":
      return Prisma.sql`
        SELECT COALESCE("referrerHost", '(direct)') AS label, COUNT(*)::int AS value, NULL::int AS secondary
        FROM (${entries}) e GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
    case "utm_source":
      return Prisma.sql`
        SELECT "utmSource" AS label, COUNT(*)::int AS value, NULL::int AS secondary
        FROM (${entries}) e WHERE "utmSource" IS NOT NULL
        GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
    case "utm_campaign":
      return Prisma.sql`
        SELECT "utmCampaign" AS label, COUNT(*)::int AS value, NULL::int AS secondary
        FROM (${entries}) e WHERE "utmCampaign" IS NOT NULL
        GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
    case "city":
      return Prisma.sql`
        SELECT city || COALESCE(', ' || country, '') AS label,
               COUNT(DISTINCT "visitorHash")::int AS value, COUNT(*)::int AS secondary
        FROM analytics_events
        WHERE type = 'PAGEVIEW' AND city IS NOT NULL AND ${win}
        GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
    case "event":
      return Prisma.sql`
        SELECT name AS label, COUNT(*)::int AS value, COUNT(DISTINCT "sessionId")::int AS secondary
        FROM analytics_events
        WHERE type = 'EVENT' AND name IS NOT NULL AND ${win}
        GROUP BY name ORDER BY value DESC LIMIT ${limit}`;
    case "country":
    case "device":
    case "browser":
    case "os": {
      // Safe: the column name is picked from the whitelisted enum above.
      const col = Prisma.raw(`"${dimension}"`);
      return Prisma.sql`
        SELECT COALESCE(${col}, 'Unknown') AS label,
               COUNT(DISTINCT "visitorHash")::int AS value, COUNT(*)::int AS secondary
        FROM analytics_events WHERE type = 'PAGEVIEW' AND ${win}
        GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
    }
  }
}

// ─── GET /analytics/breakdown — top-N for one dimension ───
analyticsRouter.get("/breakdown", async (req, res, next) => {
  try {
    const parsed = breakdownQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);

    const { range, dimension, limit } = parsed.data;
    const w = resolveWindow(range);
    const rows = await prisma.$queryRaw<BreakdownRow[]>(breakdownQuery(dimension, w.from, w.to, limit));

    res.json({ status: "ok", range: w.key, dimension, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/realtime — sessions active in the last few minutes ───
analyticsRouter.get("/realtime", async (_req, res, next) => {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - REALTIME_WINDOW_MINUTES * 60_000);

    const [pages, [totals]] = await Promise.all([
      prisma.$queryRaw<{ label: string; value: number }[]>`
        SELECT path AS label, COUNT(*)::int AS value
        FROM (
          SELECT DISTINCT ON ("sessionId") "sessionId", path
          FROM analytics_events
          WHERE type = 'PAGEVIEW' AND ${within(from, to)}
          ORDER BY "sessionId", "createdAt" DESC
        ) x GROUP BY path ORDER BY value DESC LIMIT 10`,
      prisma.$queryRaw<{ active: number }[]>`
        SELECT COUNT(DISTINCT "sessionId")::int AS active
        FROM analytics_events WHERE ${within(from, to)}`,
    ]);

    res.json({
      status: "ok",
      windowMinutes: REALTIME_WINDOW_MINUTES,
      activeVisitors: totals?.active ?? 0,
      pages,
    });
  } catch (err) {
    next(err);
  }
});
