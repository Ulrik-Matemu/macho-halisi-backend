-- CreateEnum
CREATE TYPE "GalleryImageStatus" AS ENUM ('LIVE', 'PENDING_ADD', 'PENDING_DELETE');

-- AlterTable
ALTER TABLE "accommodation_images" ADD COLUMN     "pendingAltText" TEXT,
ADD COLUMN     "pendingSortOrder" INTEGER,
ADD COLUMN     "status" "GalleryImageStatus" NOT NULL DEFAULT 'LIVE';

-- AlterTable
ALTER TABLE "accommodations" ADD COLUMN     "heroImageId" UUID;

-- AlterTable
ALTER TABLE "itineraries" ADD COLUMN     "heroImageId" UUID;

-- AlterTable
ALTER TABLE "itinerary_images" ADD COLUMN     "pendingAltText" TEXT,
ADD COLUMN     "pendingSortOrder" INTEGER,
ADD COLUMN     "status" "GalleryImageStatus" NOT NULL DEFAULT 'LIVE';

-- AddForeignKey
ALTER TABLE "itineraries" ADD CONSTRAINT "itineraries_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "itinerary_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "accommodation_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
