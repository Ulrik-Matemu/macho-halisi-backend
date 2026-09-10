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

export interface MfaChallengePayload {
  userId: string;
  purpose: "mfa_challenge";
}

// ── Access Token ───────────────────────────────

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & AccessTokenPayload;
  // Reject MFA challenge tokens that were accidentally sent as access tokens
  if ((decoded as any).purpose === "mfa_challenge") {
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

// ── MFA Challenge Token ────────────────────────

export function signMfaChallengeToken(userId: string): string {
  const payload: MfaChallengePayload = { userId, purpose: "mfa_challenge" };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
}

export function verifyMfaChallengeToken(token: string): MfaChallengePayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & MfaChallengePayload;
  if (decoded.purpose !== "mfa_challenge") {
    throw new Error("Invalid MFA challenge token");
  }
  return { userId: decoded.userId, purpose: decoded.purpose };
}

// ── Token hashing (for RefreshToken storage) ───

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
