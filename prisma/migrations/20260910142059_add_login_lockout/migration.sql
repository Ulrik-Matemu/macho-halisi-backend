-- AlterTable: persisted login-lockout state so a brute-force lockout
-- survives a process restart or the attacker rotating IP addresses (the
-- in-memory rate limiter alone does not).
ALTER TABLE "users" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);
