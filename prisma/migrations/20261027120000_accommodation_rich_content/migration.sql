-- Additive only: nullable scalars and JSON columns defaulting to an empty
-- array. Existing rows stay valid and code from before this migration keeps
-- working against the new schema.
ALTER TABLE "accommodations"
    ADD COLUMN "tagline" TEXT,
    ADD COLUMN "elevationMeters" INTEGER,
    ADD COLUMN "maxGuests" INTEGER,
    ADD COLUMN "spaces" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "nearbyPlaces" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "activities" JSONB NOT NULL DEFAULT '[]';
