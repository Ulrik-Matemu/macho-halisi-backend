-- CreateTable
CREATE TABLE "availability_periods" (
    "id" UUID NOT NULL,
    "itineraryId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "AvailabilityStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "availability_periods_itineraryId_startDate_idx" ON "availability_periods"("itineraryId", "startDate");

-- AddForeignKey
ALTER TABLE "availability_periods" ADD CONSTRAINT "availability_periods_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "itineraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
