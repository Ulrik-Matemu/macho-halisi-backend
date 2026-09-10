import "dotenv/config";
import { prisma } from "../src/db/prisma.js";
import { encryptMfaSecret } from "../src/lib/mfa.js";
import { isEncrypted } from "../src/lib/crypto.js";

/**
 * One-off migration: encrypts any User.mfaSecret rows still stored as
 * plaintext (from before field-level encryption was introduced). Safe to
 * re-run — rows already in the `v1:iv:tag:ciphertext` format are skipped.
 */
async function encryptExistingMfaSecrets() {
  const users = await prisma.user.findMany({
    where: { mfaSecret: { not: null } },
    select: { id: true, email: true, mfaSecret: true },
  });

  let migrated = 0;
  let alreadyEncrypted = 0;

  for (const user of users) {
    if (!user.mfaSecret) continue;

    if (isEncrypted(user.mfaSecret)) {
      alreadyEncrypted++;
      continue;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: encryptMfaSecret(user.mfaSecret) },
    });
    console.log(`🔐 Encrypted mfaSecret for ${user.email}`);
    migrated++;
  }

  console.log(
    `\nDone. Migrated: ${migrated}, already encrypted: ${alreadyEncrypted}, total scanned: ${users.length}.`
  );
}

if (process.argv[1]?.endsWith("encrypt-existing-mfa-secrets.ts")) {
  encryptExistingMfaSecrets()
    .catch((err) => {
      console.error("❌ Failed to encrypt existing MFA secrets:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { encryptExistingMfaSecrets };
