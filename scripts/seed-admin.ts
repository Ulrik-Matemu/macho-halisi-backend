import "dotenv/config";
import { Role } from "@prisma/client";
import { prisma } from "../src/db/prisma.js";
import { hashPassword } from "../src/lib/password.js";

async function seedAdmin() {
  const email = process.env.INITIAL_ADMIN_EMAIL || "admin@machohalisi.com";
  const password = process.env.INITIAL_ADMIN_PASSWORD || "AdminPassword123!";

  console.log(`🌱 Checking initial admin user for: ${email}...`);

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    console.log(`ℹ️  User with email "${email}" already exists (id: ${existingUser.id}, role: ${existingUser.role}).`);
    if (existingUser.role === Role.ADMIN) {
      console.log("✅ Admin user is already provisioned.");
    } else {
      console.log(`⚠️  Warning: Existing user has role "${existingUser.role}" instead of "ADMIN".`);
    }
    return existingUser;
  }

  const passwordHash = await hashPassword(password);

  const adminUser = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: Role.ADMIN,
      mfaEnabled: false,
    },
    select: {
      id: true,
      email: true,
      role: true,
      mfaEnabled: true,
      createdAt: true,
    },
  });

  console.log(`🎉 Successfully bootstrapped initial Admin user:`);
  console.log(`   ID:         ${adminUser.id}`);
  console.log(`   Email:      ${adminUser.email}`);
  console.log(`   Role:       ${adminUser.role}`);
  console.log(`   MFA Status: ${adminUser.mfaEnabled ? "Enabled" : "Enrollment Pending (first login required)"}\n`);

  return adminUser;
}

if (process.argv[1]?.endsWith("seed-admin.ts")) {
  seedAdmin()
    .catch((err) => {
      console.error("❌ Failed to bootstrap admin user:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { seedAdmin };
