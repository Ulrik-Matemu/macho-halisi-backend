import "dotenv/config";
import { prisma } from "../src/db/prisma.js";

/**
 * Deletes RefreshToken rows that are no longer useful to keep around:
 * anything already revoked (via logout, rotation, or reuse-detection), and
 * anything past its expiry regardless of revocation state. Intended to run
 * on a schedule (cron / systemd timer) since nothing else prunes this
 * table today.
 */
async function pruneTokens() {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
    },
  });

  console.log(`🧹 Pruned ${result.count} expired/revoked refresh token(s).`);
  return result.count;
}

if (process.argv[1]?.endsWith("prune-tokens.ts")) {
  pruneTokens()
    .catch((err) => {
      console.error("❌ Failed to prune refresh tokens:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { pruneTokens };
