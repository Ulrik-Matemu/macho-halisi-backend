import { PrismaClient } from "@prisma/client";

// Single PrismaClient instance — reused across the app.
// In development with hot-reload (tsx watch), store the instance on
// globalThis to prevent creating a new connection pool on every restart.

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
