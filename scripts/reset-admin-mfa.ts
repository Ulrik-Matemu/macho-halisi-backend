import "dotenv/config";
import { prisma } from "../src/db/prisma.js";

async function main() {
  const email = "admin@machohalisi.com";

  console.log(`🔍 Finding user: ${email}...`);
  const beforeUser = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
    },
  });

  if (!beforeUser) {
    console.error(`❌ User with email "${email}" not found.`);
    process.exit(1);
  }

  console.log("\n📋 BEFORE STATE:");
  console.log(`   ID:         ${beforeUser.id}`);
  console.log(`   Email:      ${beforeUser.email}`);
  console.log(`   Role:       ${beforeUser.role}`);
  console.log(`   mfaEnabled: ${beforeUser.mfaEnabled}`);
  console.log(`   mfaSecret:  ${beforeUser.mfaSecret ? "[REDACTED_SECRET_PRESENT]" : "null"}`);

  // Reset MFA state for admin only
  const updatedUser = await prisma.user.update({
    where: { email },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
    },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
    },
  });

  // Also revoke any active refresh tokens for this user so clean login is required
  const revokedCount = await prisma.refreshToken.updateMany({
    where: { userId: updatedUser.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Query fresh from DB to strictly confirm
  const afterUser = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
    },
  });

  console.log("\n📋 AFTER STATE:");
  console.log(`   ID:         ${afterUser?.id}`);
  console.log(`   Email:      ${afterUser?.email}`);
  console.log(`   Role:       ${afterUser?.role}`);
  console.log(`   mfaEnabled: ${afterUser?.mfaEnabled}`);
  console.log(`   mfaSecret:  ${afterUser?.mfaSecret}`);
  console.log(`   Revoked active refresh tokens: ${revokedCount.count}`);

  // Confirm editor is untouched
  const editorUser = await prisma.user.findUnique({
    where: { email: "editor@machohalisi.com" },
    select: { id: true, email: true, role: true, mfaEnabled: true, mfaSecret: true },
  });

  if (editorUser) {
    console.log(`\n🔒 Confirmed editor account untouched:`);
    console.log(`   Editor: ${editorUser.email} (Role: ${editorUser.role}, mfaEnabled: ${editorUser.mfaEnabled})`);
  }

  console.log("\n✅ MFA reset complete. The admin account is ready for real manual enrollment.");
}

main()
  .catch((e) => {
    console.error("❌ Error resetting admin MFA:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
