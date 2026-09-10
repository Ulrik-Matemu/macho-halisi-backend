import { generateSecret, verifySync, generateURI } from "otplib";
import QRCode from "qrcode";
import { encrypt, decrypt } from "./crypto.js";

const ISSUER = "Macho Halisi";

export function generateMfaSecret(): string {
  return generateSecret();
}

// User.mfaSecret is stored encrypted at rest (AES-256-GCM, see lib/crypto.ts)
// so a database leak does not also leak every user's live TOTP seed.
// Callers work in plaintext right up to the DB write/read boundary.
export function encryptMfaSecret(plaintextSecret: string): string {
  return encrypt(plaintextSecret);
}

export function decryptMfaSecret(storedSecret: string): string {
  return decrypt(storedSecret);
}

export function verifyMfaCode(code: string, secret: string): boolean {
  try {
    const result = verifySync({ token: code, secret });
    return result.valid;
  } catch {
    return false;
  }
}

export async function generateQrCodeDataUrl(email: string, secret: string): Promise<string> {
  const otpauth = generateURI({
    issuer: ISSUER,
    label: email,
    secret,
  });
  return QRCode.toDataURL(otpauth);
}
