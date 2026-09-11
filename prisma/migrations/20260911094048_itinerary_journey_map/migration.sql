-- AlterTable
ALTER TABLE "destinations" ADD COLUMN     "blurb" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "itineraries" ADD COLUMN     "showRouteMap" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "itinerary_days" ADD COLUMN     "heroImageId" UUID,
ADD COLUMN     "highlight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AddForeignKey
ALTER TABLE "itinerary_days" ADD CONSTRAINT "itinerary_days_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "itinerary_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
