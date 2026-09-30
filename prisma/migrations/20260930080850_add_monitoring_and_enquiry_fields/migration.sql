-- CreateEnum
CREATE TYPE "AnalyticsEventType" AS ENUM ('PAGEVIEW', 'EVENT', 'WEB_VITAL', 'JS_ERROR', 'PAGE_LEAVE');

-- CreateEnum
CREATE TYPE "UptimeTarget" AS ENUM ('SITE', 'PAGE', 'API', 'DATABASE');

-- AlterTable
ALTER TABLE "enquiries" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "handledById" UUID,
ADD COLUMN     "pagePath" TEXT,
ADD COLUMN     "referrerHost" TEXT,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "staffNotes" TEXT,
ADD COLUMN     "utmSource" TEXT;

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "type" "AnalyticsEventType" NOT NULL,
    "name" TEXT,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "referrerHost" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "visitorHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uptime_checks" (
    "id" UUID NOT NULL,
    "target" "UptimeTarget" NOT NULL,
    "url" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "statusCode" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "source" TEXT NOT NULL DEFAULT 'github-actions',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uptime_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_metric_buckets" (
    "id" UUID NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "routeGroup" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "clientErrorCount" INTEGER NOT NULL DEFAULT 0,
    "totalMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "le100" INTEGER NOT NULL DEFAULT 0,
    "le300" INTEGER NOT NULL DEFAULT 0,
    "le1000" INTEGER NOT NULL DEFAULT 0,
    "gt1000" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "api_metric_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_createdAt_idx" ON "analytics_events"("createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_type_createdAt_idx" ON "analytics_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_sessionId_idx" ON "analytics_events"("sessionId");

-- CreateIndex
CREATE INDEX "uptime_checks_target_checkedAt_idx" ON "uptime_checks"("target", "checkedAt");

-- CreateIndex
CREATE INDEX "uptime_checks_checkedAt_idx" ON "uptime_checks"("checkedAt");

-- CreateIndex
CREATE INDEX "api_metric_buckets_bucketStart_idx" ON "api_metric_buckets"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "api_metric_buckets_bucketStart_routeGroup_method_key" ON "api_metric_buckets"("bucketStart", "routeGroup", "method");

-- CreateIndex
CREATE INDEX "enquiries_status_createdAt_idx" ON "enquiries"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
