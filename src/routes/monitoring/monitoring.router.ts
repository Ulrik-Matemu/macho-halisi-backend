import { Router } from "express";
import { Prisma, Role, UptimeTarget } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { recentServerErrors } from "../../middleware/requestMetrics.js";
import { secretsMatch } from "../../lib/secret.js";
import { rangeQuerySchema, resolveWindow, utc } from "../../lib/range.js";
import { uptimeBatchSchema } from "./monitoring.schemas.js";

// Uptime, API performance, Core Web Vitals, errors and system health.
// Uptime results are written by the external GitHub Actions cron (shared
// secret) — the backend can't meaningfully report its own downtime.
// Every read is ADMIN-only.
export const monitoringRouter = Router();

// The cron runs every 5 minutes; GitHub may delay scheduled runs, so allow
// a few missed runs before flagging the monitor itself as silent.
const STALE_AFTER_MINUTES = 15;
// Consecutive failures closer together than this belong to one incident.
const INCIDENT_GAP_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function within(from: Date, to: Date, column = "createdAt") {
  const col = Prisma.raw(`"${column}"`);
  return Prisma.sql`${col} >= (${utc(from)}::timestamptz AT TIME ZONE 'UTC')
    AND ${col} < (${utc(to)}::timestamptz AT TIME ZONE 'UTC')`;
}

function badQuery(res: import("express").Response, error: { flatten: () => unknown }) {
  res.status(400).json({ status: "error", message: "Invalid query parameters", errors: error.flatten() });
}

// ─── POST /monitoring/uptime — results from the uptime cron ───
monitoringRouter.post("/uptime", async (req, res, next) => {
  try {
    if (!secretsMatch(req.headers["x-monitor-secret"], env.MONITOR_SECRET)) {
      res.status(401).json({ status: "error", message: "Invalid monitor secret" });
      return;
    }

    const parsed = uptimeBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "error", message: "Invalid uptime batch", errors: parsed.error.flatten() });
      return;
    }

    const checkedAt = new Date();
    const { count } = await prisma.uptimeCheck.createMany({
      data: parsed.data.checks.map((c) => ({
        ...c,
        source: parsed.data.source ?? "github-actions",
        checkedAt,
      })),
    });

    res.status(201).json({ status: "ok", recorded: count });
  } catch (err) {
    next(err);
  }
});

// Every route below is admin-only.
monitoringRouter.use(requireAuth, requireRole(Role.ADMIN));

// ─── GET /monitoring/uptime — status, uptime %, latency, incidents ───
monitoringRouter.get("/uptime", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);
    const w = resolveWindow(parsed.data.range);
    const g = Prisma.raw(`'${w.granularity}'`);
    const now = new Date();

    const [pctRows, latestRows, latencyRows, dailyRows, failures] = await Promise.all([
      // Uptime % per target over 24h / 7d / 30d in one pass.
      prisma.$queryRaw<
        { target: UptimeTarget; d1: number | null; d7: number | null; d30: number | null }[]
      >`
        SELECT target::text AS target,
          (AVG(ok::int) FILTER (WHERE "checkedAt" >= (${utc(new Date(now.getTime() - DAY_MS))}::timestamptz AT TIME ZONE 'UTC')))::float AS d1,
          (AVG(ok::int) FILTER (WHERE "checkedAt" >= (${utc(new Date(now.getTime() - 7 * DAY_MS))}::timestamptz AT TIME ZONE 'UTC')))::float AS d7,
          AVG(ok::int)::float AS d30
        FROM uptime_checks
        WHERE "checkedAt" >= (${utc(new Date(now.getTime() - 30 * DAY_MS))}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY target`,
      prisma.$queryRaw<
        { target: UptimeTarget; url: string; ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: Date }[]
      >`
        SELECT DISTINCT ON (target, url) target::text AS target, url, ok, "statusCode", "latencyMs", error, "checkedAt"
        FROM uptime_checks
        ORDER BY target, url, "checkedAt" DESC`,
      // Average latency per bucket and target for the selected range.
      prisma.$queryRaw<{ bucket: Date; target: UptimeTarget; avg_ms: number | null; checks: number }[]>`
        SELECT date_trunc(${g}, "checkedAt") AS bucket, target::text AS target,
               AVG("latencyMs")::float AS avg_ms, COUNT(*)::int AS checks
        FROM uptime_checks
        WHERE ${within(w.from, w.to, "checkedAt")}
        GROUP BY 1, 2 ORDER BY 1`,
      // Daily uptime for the 90-segment status bar.
      prisma.$queryRaw<{ day: Date; target: UptimeTarget; pct: number; checks: number }[]>`
        SELECT date_trunc('day', "checkedAt") AS day, target::text AS target,
               AVG(ok::int)::float AS pct, COUNT(*)::int AS checks
        FROM uptime_checks
        WHERE "checkedAt" >= (${utc(new Date(now.getTime() - 90 * DAY_MS))}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1, 2 ORDER BY 1`,
      prisma.uptimeCheck.findMany({
        where: { ok: false, checkedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
        orderBy: [{ target: "asc" }, { url: "asc" }, { checkedAt: "asc" }],
        select: { target: true, url: true, checkedAt: true, statusCode: true, error: true },
        take: 5000,
      }),
    ]);

    // Group consecutive failures of the same target+url into incidents.
    type Incident = {
      target: UptimeTarget;
      url: string;
      startedAt: Date;
      lastFailureAt: Date;
      failedChecks: number;
      lastError: string | null;
      resolvedAt: Date | null;
    };
    const incidents: Incident[] = [];
    for (const f of failures) {
      const prev = incidents[incidents.length - 1];
      if (
        prev &&
        prev.target === f.target &&
        prev.url === f.url &&
        f.checkedAt.getTime() - prev.lastFailureAt.getTime() <= INCIDENT_GAP_MS
      ) {
        prev.lastFailureAt = f.checkedAt;
        prev.failedChecks++;
        prev.lastError = f.error ?? (f.statusCode ? `HTTP ${f.statusCode}` : prev.lastError);
      } else {
        incidents.push({
          target: f.target,
          url: f.url,
          startedAt: f.checkedAt,
          lastFailureAt: f.checkedAt,
          failedChecks: 1,
          lastError: f.error ?? (f.statusCode ? `HTTP ${f.statusCode}` : null),
          resolvedAt: null,
        });
      }
    }

    // Most recent first, capped — then find when each one recovered.
    incidents.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const recentIncidents = incidents.slice(0, 20);
    await Promise.all(
      recentIncidents.map(async (inc) => {
        const recovery = await prisma.uptimeCheck.findFirst({
          where: { target: inc.target, url: inc.url, ok: true, checkedAt: { gt: inc.lastFailureAt } },
          orderBy: { checkedAt: "asc" },
          select: { checkedAt: true },
        });
        inc.resolvedAt = recovery?.checkedAt ?? null;
      })
    );

    const lastCheckAt = latestRows.reduce<Date | null>(
      (max, r) => (!max || r.checkedAt > max ? r.checkedAt : max),
      null
    );
    const stale = !lastCheckAt || now.getTime() - lastCheckAt.getTime() > STALE_AFTER_MINUTES * 60_000;

    res.json({
      status: "ok",
      range: w.key,
      granularity: w.granularity,
      lastCheckAt,
      stale,
      staleAfterMinutes: STALE_AFTER_MINUTES,
      targets: pctRows.map((r) => ({ target: r.target, uptime24h: r.d1, uptime7d: r.d7, uptime30d: r.d30 })),
      latest: latestRows,
      latency: latencyRows,
      daily: dailyRows,
      incidents: recentIncidents.map((i) => ({
        ...i,
        durationMs: (i.resolvedAt ?? now).getTime() - i.startedAt.getTime(),
        ongoing: !i.resolvedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

interface PerfRow {
  count: number;
  errors: number;
  client_errors: number;
  total_ms: number;
  max_ms: number;
  le100: number;
  le300: number;
  le1000: number;
  gt1000: number;
}

/**
 * Estimates p95 from the coarse histogram as the upper bound of the bucket
 * the 95th percentile falls in — so it reads "≤ 300 ms", never a false
 * precise number. Returns null for the open-ended > 1s bucket.
 */
function estimateP95(r: PerfRow): number | null {
  if (!r.count) return 0;
  const target = r.count * 0.95;
  if (r.le100 >= target) return 100;
  if (r.le100 + r.le300 >= target) return 300;
  if (r.le100 + r.le300 + r.le1000 >= target) return 1000;
  return null;
}

function summarizePerf(r: PerfRow, minutes: number) {
  return {
    requests: r.count,
    requestsPerMinute: minutes ? r.count / minutes : 0,
    errorRate: r.count ? r.errors / r.count : 0,
    clientErrorRate: r.count ? r.client_errors / r.count : 0,
    avgMs: r.count ? r.total_ms / r.count : 0,
    maxMs: r.max_ms,
    p95UpperMs: estimateP95(r),
  };
}

const PERF_COLUMNS = Prisma.sql`
  COALESCE(SUM(count), 0)::int AS count,
  COALESCE(SUM("errorCount"), 0)::int AS errors,
  COALESCE(SUM("clientErrorCount"), 0)::int AS client_errors,
  COALESCE(SUM("totalMs"), 0)::float AS total_ms,
  COALESCE(MAX("maxMs"), 0)::float AS max_ms,
  COALESCE(SUM(le100), 0)::int AS le100,
  COALESCE(SUM(le300), 0)::int AS le300,
  COALESCE(SUM(le1000), 0)::int AS le1000,
  COALESCE(SUM(gt1000), 0)::int AS gt1000`;

// ─── GET /monitoring/performance — API throughput, errors and latency ───
monitoringRouter.get("/performance", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);
    const w = resolveWindow(parsed.data.range);
    const g = Prisma.raw(`'${w.granularity}'`);
    const win = within(w.from, w.to, "bucketStart");

    const [[totals], routes, series] = await Promise.all([
      prisma.$queryRaw<PerfRow[]>`SELECT ${PERF_COLUMNS} FROM api_metric_buckets WHERE ${win}`,
      prisma.$queryRaw<(PerfRow & { route: string; method: string })[]>`
        SELECT "routeGroup" AS route, method, ${PERF_COLUMNS}
        FROM api_metric_buckets WHERE ${win}
        GROUP BY 1, 2 ORDER BY count DESC LIMIT 50`,
      prisma.$queryRaw<{ bucket: Date; count: number; errors: number; avg_ms: number | null }[]>`
        SELECT date_trunc(${g}, "bucketStart") AS bucket,
               SUM(count)::int AS count, SUM("errorCount")::int AS errors,
               (SUM("totalMs") / NULLIF(SUM(count), 0))::float AS avg_ms
        FROM api_metric_buckets WHERE ${win}
        GROUP BY 1 ORDER BY 1`,
    ]);

    res.json({
      status: "ok",
      range: w.key,
      granularity: w.granularity,
      totals: summarizePerf(totals, w.minutes),
      routes: routes.map((r) => ({ route: r.route, method: r.method, ...summarizePerf(r, w.minutes) })),
      series,
    });
  } catch (err) {
    next(err);
  }
});

// Google's Core Web Vitals thresholds: [good upper bound, poor lower bound].
const VITAL_THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

function rateVital(name: string, p75: number): "good" | "needs-improvement" | "poor" | null {
  const t = VITAL_THRESHOLDS[name];
  if (!t) return null;
  if (p75 <= t[0]) return "good";
  if (p75 <= t[1]) return "needs-improvement";
  return "poor";
}

// ─── GET /monitoring/web-vitals — p75 real-user Core Web Vitals ───
monitoringRouter.get("/web-vitals", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);
    const w = resolveWindow(parsed.data.range);
    const win = within(w.from, w.to);

    const [overall, pages] = await Promise.all([
      prisma.$queryRaw<{ name: string; p75: number; samples: number }[]>`
        SELECT name, percentile_cont(0.75) WITHIN GROUP (ORDER BY value)::float AS p75, COUNT(*)::int AS samples
        FROM analytics_events
        WHERE type = 'WEB_VITAL' AND value IS NOT NULL AND ${win}
        GROUP BY name`,
      prisma.$queryRaw<{ path: string; name: string; p75: number; samples: number }[]>`
        SELECT path, name, percentile_cont(0.75) WITHIN GROUP (ORDER BY value)::float AS p75, COUNT(*)::int AS samples
        FROM analytics_events
        WHERE type = 'WEB_VITAL' AND value IS NOT NULL AND name IN ('LCP', 'INP', 'CLS') AND ${win}
        GROUP BY path, name
        HAVING COUNT(*) >= 3`,
    ]);

    // Pivot per-page rows into one entry per page, worst LCP first.
    const byPage = new Map<string, { path: string; samples: number; metrics: Record<string, { p75: number; rating: string | null }> }>();
    for (const r of pages) {
      const entry = byPage.get(r.path) ?? { path: r.path, samples: 0, metrics: {} };
      entry.samples = Math.max(entry.samples, r.samples);
      entry.metrics[r.name] = { p75: r.p75, rating: rateVital(r.name, r.p75) };
      byPage.set(r.path, entry);
    }
    const pageList = [...byPage.values()]
      .sort((a, b) => (b.metrics.LCP?.p75 ?? 0) - (a.metrics.LCP?.p75 ?? 0))
      .slice(0, 15);

    res.json({
      status: "ok",
      range: w.key,
      thresholds: VITAL_THRESHOLDS,
      overall: overall.map((r) => ({ ...r, rating: rateVital(r.name, r.p75) })),
      pages: pageList,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /monitoring/errors — frontend JS errors + recent backend 5xx ───
monitoringRouter.get("/errors", async (req, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return badQuery(res, parsed.error);
    const w = resolveWindow(parsed.data.range);

    const clientErrors = await prisma.$queryRaw<
      { message: string; occurrences: number; sessions: number; lastSeen: Date; samplePath: string; sampleMeta: Prisma.JsonValue }[]
    >`
      SELECT name AS message,
             COUNT(*)::int AS occurrences,
             COUNT(DISTINCT "sessionId")::int AS sessions,
             MAX("createdAt") AS "lastSeen",
             (ARRAY_AGG(path ORDER BY "createdAt" DESC))[1] AS "samplePath",
             (ARRAY_AGG(metadata ORDER BY "createdAt" DESC))[1] AS "sampleMeta"
      FROM analytics_events
      WHERE type = 'JS_ERROR' AND ${within(w.from, w.to)}
      GROUP BY name
      ORDER BY occurrences DESC
      LIMIT 30`;

    res.json({ status: "ok", range: w.key, clientErrors, serverErrors: recentServerErrors() });
  } catch (err) {
    next(err);
  }
});

// ─── GET /monitoring/system — process, database and content health ───
monitoringRouter.get("/system", async (_req, res, next) => {
  try {
    const dbStart = process.hrtime.bigint();
    let dbOk = true;
    try {
      await pool.query("SELECT 1");
    } catch {
      dbOk = false;
    }
    const dbLatencyMs = Number(process.hrtime.bigint() - dbStart) / 1e6;

    const [[size], counts, newEnquiries] = await Promise.all([
      prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`,
      Promise.all([
        prisma.itinerary.count(),
        prisma.accommodation.count(),
        prisma.destination.count(),
        prisma.enquiry.count(),
        prisma.user.count(),
        prisma.analyticsEvent.count(),
      ]),
      prisma.enquiry.count({ where: { status: "NEW" } }),
    ]);

    const mem = process.memoryUsage();
    res.json({
      status: "ok",
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        environment: env.NODE_ENV,
        commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
        memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
      },
      database: {
        connected: dbOk,
        latencyMs: dbLatencyMs,
        sizeBytes: Number(size?.bytes ?? 0),
      },
      counts: {
        itineraries: counts[0],
        accommodations: counts[1],
        destinations: counts[2],
        enquiries: counts[3],
        newEnquiries,
        users: counts[4],
        analyticsEvents: counts[5],
      },
    });
  } catch (err) {
    next(err);
  }
});
