-- CreateIndex
-- Backs GET /public/itineraries: WHERE status = 'PUBLISHED' ORDER BY "publishedAt" DESC
CREATE INDEX "itineraries_status_publishedAt_idx" ON "itineraries"("status", "publishedAt");
