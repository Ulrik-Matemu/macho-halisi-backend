import { generateSecret, verifySync, generateURI } from "otplib";
import QRCode from "qrcode";

const ISSUER = "Macho Halisi";

export function generateMfaSecret(): string {
  return generateSecret();
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
