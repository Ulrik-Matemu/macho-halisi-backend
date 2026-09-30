import { RequestHandler, Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";

// ── API performance metrics ─────────────────────
//
// Times every request and aggregates in memory into per-minute buckets
// keyed by route *pattern* (e.g. "/public/itineraries/:slug", never the
// concrete slug), then flushes completed minutes to api_metric_buckets
// once a minute. Storing aggregates rather than one row per request keeps
// the table small enough to query over 90 days on a basic Postgres plan.

interface Bucket {
  bucketStart: number;
  routeGroup: string;
  method: string;
  count: number;
  errorCount: number;
  clientErrorCount: number;
  totalMs: number;
  maxMs: number;
  le100: number;
  le300: number;
  le1000: number;
  gt1000: number;
}

const FLUSH_INTERVAL_MS = 60_000;
const buckets = new Map<string, Bucket>();

function routeGroupOf(req: Request): string {
  // req.route is only set once a route handler matched — anything else
  // (404s, requests rejected by earlier middleware) is grouped together so
  // arbitrary probed URLs can't create unbounded distinct groups.
  if (req.route?.path) {
    const path = `${req.baseUrl}${req.route.path === "/" ? "" : req.route.path}`;
    return path || "/";
  }
  return "(unmatched)";
}

export const requestMetrics: RequestHandler = (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const routeGroup = routeGroupOf(req);
    const key = `${minute}|${req.method}|${routeGroup}`;

    let b = buckets.get(key);
    if (!b) {
      b = {
        bucketStart: minute,
        routeGroup,
        method: req.method,
        count: 0,
        errorCount: 0,
        clientErrorCount: 0,
        totalMs: 0,
        maxMs: 0,
        le100: 0,
        le300: 0,
        le1000: 0,
        gt1000: 0,
      };
      buckets.set(key, b);
    }

    b.count++;
    if (res.statusCode >= 500) b.errorCount++;
    else if (res.statusCode >= 400) b.clientErrorCount++;
    b.totalMs += ms;
    b.maxMs = Math.max(b.maxMs, ms);
    if (ms <= 100) b.le100++;
    else if (ms <= 300) b.le300++;
    else if (ms <= 1000) b.le1000++;
    else b.gt1000++;
  });

  next();
};

/** Writes every bucket older than the current minute and drops it from memory. */
export async function flushRequestMetrics(includeCurrent = false): Promise<void> {
  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const ready = [...buckets.entries()].filter(
    ([, b]) => includeCurrent || b.bucketStart < currentMinute
  );
  if (ready.length === 0) return;

  for (const [key] of ready) buckets.delete(key);

  // Upsert-with-increment rather than create: a restart mid-minute, or two
  // instances behind a load balancer, may both write the same bucket.
  for (const [, b] of ready) {
    await prisma.$executeRaw`
      INSERT INTO api_metric_buckets
        (id, "bucketStart", "routeGroup", method, count, "errorCount", "clientErrorCount",
         "totalMs", "maxMs", le100, le300, le1000, gt1000)
      VALUES
        (gen_random_uuid(), (${new Date(b.bucketStart).toISOString()}::timestamptz AT TIME ZONE 'UTC'),
         ${b.routeGroup}, ${b.method}, ${b.count}, ${b.errorCount}, ${b.clientErrorCount},
         ${b.totalMs}, ${b.maxMs}, ${b.le100}, ${b.le300}, ${b.le1000}, ${b.gt1000})
      ON CONFLICT ("bucketStart", "routeGroup", method) DO UPDATE SET
        count = api_metric_buckets.count + EXCLUDED.count,
        "errorCount" = api_metric_buckets."errorCount" + EXCLUDED."errorCount",
        "clientErrorCount" = api_metric_buckets."clientErrorCount" + EXCLUDED."clientErrorCount",
        "totalMs" = api_metric_buckets."totalMs" + EXCLUDED."totalMs",
        "maxMs" = GREATEST(api_metric_buckets."maxMs", EXCLUDED."maxMs"),
        le100 = api_metric_buckets.le100 + EXCLUDED.le100,
        le300 = api_metric_buckets.le300 + EXCLUDED.le300,
        le1000 = api_metric_buckets.le1000 + EXCLUDED.le1000,
        gt1000 = api_metric_buckets.gt1000 + EXCLUDED.gt1000`.catch((err: Prisma.PrismaClientKnownRequestError) =>
      console.error("Failed to flush API metric bucket:", err.message)
    );
  }
}

let flushTimer: NodeJS.Timeout | null = null;

/** Starts the once-a-minute flush. Unref'd so it never holds the process open. */
export function startRequestMetricsFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushRequestMetrics().catch((err) => console.error("Metrics flush failed:", err));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

// ── Recent server errors ────────────────────────
//
// Small in-memory ring buffer of recent 5xx errors, fed by errorHandler, so
// the monitoring page can show what actually failed. Lost on restart by
// design — this is a "what's happening right now" view, not an audit log.

export interface ServerErrorEntry {
  at: string;
  method: string;
  route: string;
  status: number;
  message: string;
}

const MAX_SERVER_ERRORS = 50;
const serverErrors: ServerErrorEntry[] = [];

export function recordServerError(req: Request, status: number, message: string): void {
  serverErrors.unshift({
    at: new Date().toISOString(),
    method: req.method,
    route: routeGroupOf(req) === "(unmatched)" ? req.path : routeGroupOf(req),
    status,
    message: message.slice(0, 500),
  });
  if (serverErrors.length > MAX_SERVER_ERRORS) serverErrors.length = MAX_SERVER_ERRORS;
}

export function recentServerErrors(): ServerErrorEntry[] {
  return [...serverErrors];
}
