-- CreateTable
CREATE TABLE "itinerary_revisions" (
    "id" UUID NOT NULL,
    "itineraryId" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "editorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "itinerary_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_revisions_itineraryId_key" ON "itinerary_revisions"("itineraryId");

-- AddForeignKey
ALTER TABLE "itinerary_revisions" ADD CONSTRAINT "itinerary_revisions_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "itineraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_revisions" ADD CONSTRAINT "itinerary_revisions_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
