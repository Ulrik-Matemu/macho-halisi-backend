import "dotenv/config";
import { prisma } from "../src/db/prisma.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";

async function main() {
  const email = "editor@machohalisi.com";
  const newPassword = process.env.RESET_EDITOR_PASSWORD || process.argv[2];

  if (!newPassword) {
    console.error("❌ No password provided. Please supply it via argument or RESET_EDITOR_PASSWORD environment variable.");
    console.error("   Example: npx tsx scripts/reset-editor-credentials.ts \"YourNewSecurePassword123!\"");
    process.exit(1);
  }

  if (newPassword.length < 8) {
    console.error("❌ Password must be at least 8 characters long.");
    process.exit(1);
  }

  console.log(`🔍 Finding user: ${email}...`);
  const beforeUser = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
      passwordHash: true,
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

  // Hash new password using standard application helper (bcrypt, 12 rounds)
  const passwordHash = await hashPassword(newPassword);

  // Reset password and MFA state for editor only
  const updatedUser = await prisma.user.update({
    where: { email },
    data: {
      passwordHash,
      mfaEnabled: false,
      mfaSecret: null,
    },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
      passwordHash: true,
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
      passwordHash: true,
    },
  });

  if (!afterUser) {
    console.error(`❌ Unexpected error: Could not query user after update.`);
    process.exit(1);
  }

  // Verify that the new password actually matches the hash in DB
  const isValidPassword = await verifyPassword(newPassword, afterUser.passwordHash);

  console.log("\n📋 AFTER STATE:");
  console.log(`   ID:         ${afterUser.id}`);
  console.log(`   Email:      ${afterUser.email}`);
  console.log(`   Role:       ${afterUser.role}`);
  console.log(`   mfaEnabled: ${afterUser.mfaEnabled}`);
  console.log(`   mfaSecret:  ${afterUser.mfaSecret}`);
  console.log(`   Password verified: ${isValidPassword ? "✅ SUCCESS" : "❌ FAILED"}`);
  console.log(`   Revoked active refresh tokens: ${revokedCount.count}`);

  // Confirm admin is untouched
  const adminUser = await prisma.user.findUnique({
    where: { email: "admin@machohalisi.com" },
    select: { id: true, email: true, role: true, mfaEnabled: true, mfaSecret: true },
  });

  if (adminUser) {
    console.log(`\n🔒 Confirmed admin account untouched:`);
    console.log(`   Admin:  ${adminUser.email} (Role: ${adminUser.role}, mfaEnabled: ${adminUser.mfaEnabled})`);
  }

  console.log("\n✅ Editor credentials and MFA reset complete. The account is ready for manual login and MFA enrollment.");
}

main()
  .catch((e) => {
    console.error("❌ Error resetting editor credentials:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
