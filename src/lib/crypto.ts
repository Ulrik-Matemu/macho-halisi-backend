import crypto from "node:crypto";
import { env } from "../config/env.js";

// ── AES-256-GCM field-level encryption ─────────
//
// Used for User.mfaSecret so a database dump/leak does not hand over every
// user's live TOTP seed. MFA_ENCRYPTION_KEY is a 32-byte key expressed as
// 64 hex characters (generate with `openssl rand -hex 32`).

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // recommended IV length for GCM
const CIPHERTEXT_PREFIX = "v1:";

function getKey(): Buffer {
  return Buffer.from(env.MFA_ENCRYPTION_KEY, "hex");
}

/**
 * Encrypts plaintext into a single self-describing string:
 *   v1:<iv hex>:<authTag hex>:<ciphertext hex>
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${CIPHERTEXT_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(encoded: string): string {
  if (!isEncrypted(encoded)) {
    throw new Error("Value is not in the expected encrypted format");
  }

  const [ivHex, authTagHex, ciphertextHex] = encoded.slice(CIPHERTEXT_PREFIX.length).split(":");
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");
  const ciphertext = Buffer.from(ciphertextHex!, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** True if the value was produced by `encrypt()`, as opposed to legacy plaintext. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(CIPHERTEXT_PREFIX) && value.split(":").length === 4;
}
