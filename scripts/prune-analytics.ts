import "dotenv/config";
import { prisma } from "../src/db/prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Raw analytics events are kept long enough for year-over-year comparison;
// uptime checks and per-minute API buckets only feed 90-day views.
const EVENT_RETENTION_DAYS = 395;
const MONITORING_RETENTION_DAYS = 90;

/**
 * Deletes monitoring data past its retention window. Intended to run on a
 * schedule (e.g. a daily Render cron job running `npm run analytics:prune`)
 * since nothing else prunes these tables.
 */
async function pruneAnalytics() {
  const now = Date.now();
  const eventCutoff = new Date(now - EVENT_RETENTION_DAYS * DAY_MS);
  const monitoringCutoff = new Date(now - MONITORING_RETENTION_DAYS * DAY_MS);

  const [events, checks, buckets] = await prisma.$transaction([
    prisma.analyticsEvent.deleteMany({ where: { createdAt: { lt: eventCutoff } } }),
    prisma.uptimeCheck.deleteMany({ where: { checkedAt: { lt: monitoringCutoff } } }),
    prisma.apiMetricBucket.deleteMany({ where: { bucketStart: { lt: monitoringCutoff } } }),
  ]);

  console.log(
    `🧹 Pruned ${events.count} analytics event(s), ${checks.count} uptime check(s), ${buckets.count} API metric bucket(s).`
  );
  return { events: events.count, checks: checks.count, buckets: buckets.count };
}

if (process.argv[1]?.endsWith("prune-analytics.ts")) {
  pruneAnalytics()
    .catch((err) => {
      console.error("❌ Failed to prune analytics data:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { pruneAnalytics };
