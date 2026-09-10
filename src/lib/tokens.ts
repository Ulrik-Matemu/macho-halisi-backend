import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { Role } from "@prisma/client";

// ── Token payload types ────────────────────────

export interface AccessTokenPayload {
  userId: string;
  role: Role;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string; // UUID of the RefreshToken row
}

export type MfaTokenPurpose = "mfa_challenge" | "mfa_enroll";

export interface MfaChallengePayload {
  userId: string;
  purpose: MfaTokenPurpose;
}

// ── Access Token ───────────────────────────────

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & AccessTokenPayload;
  // Reject MFA challenge/enrollment tokens that were accidentally sent as access tokens
  const purpose = (decoded as any).purpose;
  if (purpose === "mfa_challenge" || purpose === "mfa_enroll") {
    throw new Error("MFA challenge token cannot be used as access token");
  }
  return { userId: decoded.userId, role: decoded.role };
}

// ── Refresh Token ──────────────────────────────

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload & RefreshTokenPayload;
  return { userId: decoded.userId, tokenId: decoded.tokenId };
}

// ── MFA Challenge / Enrollment Tokens ──────────
//
// Two distinct, non-interchangeable purposes are minted from /auth/login:
//   "mfa_challenge" — issued when the user already has MFA enabled; only
//                      usable at POST /auth/mfa/verify.
//   "mfa_enroll"     — issued when the user has NOT yet enabled MFA; only
//                      usable at POST /auth/mfa/enroll[/confirm].
// Keeping these separate stops a holder of a valid password (but not the
// authenticator) from calling /auth/mfa/enroll on an already-enrolled
// account and replacing the real secret with their own.

export function signMfaChallengeToken(userId: string, purpose: MfaTokenPurpose): string {
  const payload: MfaChallengePayload = { userId, purpose };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
}

export function verifyMfaChallengeToken(
  token: string,
  expectedPurpose: MfaTokenPurpose
): MfaChallengePayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & MfaChallengePayload;
  if (decoded.purpose !== expectedPurpose) {
    throw new Error("Invalid or mismatched-purpose MFA token");
  }
  return { userId: decoded.userId, purpose: decoded.purpose };
}

// ── Token hashing (for RefreshToken storage) ───

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Duration parsing (for RefreshToken.expiresAt) ──
//
// Mirrors the small subset of the `ms`-style syntax jsonwebtoken accepts
// for JWT_REFRESH_EXPIRES_IN, so the DB row's expiresAt actually matches
// the JWT's own exp claim instead of a hardcoded 7 days.

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseDurationMs(input: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${input}"`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  return value * DURATION_UNIT_MS[unit];
}
