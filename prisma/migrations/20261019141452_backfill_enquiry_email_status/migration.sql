-- Enquiries received before delivery tracking were never emailed.
UPDATE "enquiries" SET "emailStatus" = 'SKIPPED' WHERE "emailStatus" = 'PENDING';
