import { Router } from "express";
import crypto from "node:crypto";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { verifyPassword } from "../../lib/password.js";
import {
  signAccessToken,
  signRefreshToken,
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  verifyRefreshToken,
  hashToken,
  parseDurationMs,
} from "../../lib/tokens.js";
import { env } from "../../config/env.js";
import {
  generateMfaSecret,
  verifyMfaCode,
  generateQrCodeDataUrl,
  encryptMfaSecret,
  decryptMfaSecret,
} from "../../lib/mfa.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { authLimiter, mfaLimiter } from "../../middleware/rateLimit.js";
import {
  loginSchema,
  mfaVerifySchema,
  mfaEnrollConfirmSchema,
  refreshSchema,
  logoutSchema,
} from "./auth.schemas.js";

export const authRouter = Router();

// Persisted lockout thresholds. These back up the in-memory authLimiter:
// the rate limiter resets on process restart or if the attacker rotates
// IPs, but this state lives in the database and does not.
const MAX_FAILED_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Helper to issue access and refresh token pair
async function issueTokenPair(userId: string, role: Role) {
  const accessToken = signAccessToken({ userId, role });
  const tokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ userId, tokenId });
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN));

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId,
      tokenHash,
      expiresAt,
    },
  });

  return { accessToken, refreshToken };
}

// 1. POST /auth/login
authRouter.post("/login", authLimiter, async (req, res, next) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { email, password } = parseResult.data;
    const user = await prisma.user.findUnique({ where: { email } });

    // Account-level lockout, independent of the IP-keyed authLimiter above.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      res.status(423).json({
        status: "error",
        message: "This account is temporarily locked due to repeated failed login attempts. Please try again later.",
      });
      return;
    }

    if (user && !user.isActive) {
      res.status(403).json({
        status: "error",
        message: "This account has been deactivated. Contact an administrator.",
      });
      return;
    }

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      if (user) {
        const failedLoginCount = user.failedLoginCount + 1;
        const lockedOut = failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: lockedOut ? 0 : failedLoginCount,
            lockedUntil: lockedOut ? new Date(Date.now() + LOGIN_LOCKOUT_DURATION_MS) : null,
          },
        });
      }
      res.status(401).json({ status: "error", message: "Invalid email or password" });
      return;
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    if (!user.mfaEnabled) {
      const challengeToken = signMfaChallengeToken(user.id, "mfa_enroll");
      res.json({
        status: "mfa_enrollment_required",
        challengeToken,
      });
      return;
    }

    const challengeToken = signMfaChallengeToken(user.id, "mfa_challenge");
    res.json({
      status: "mfa_required",
      challengeToken,
    });
  } catch (err) {
    next(err);
  }
});

// 2. POST /auth/mfa/enroll
authRouter.post("/mfa/enroll", async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ status: "error", message: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = verifyMfaChallengeToken(token, "mfa_enroll");
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired enrollment token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    // Enrollment tokens are only ever minted for users without MFA already
    // enabled, but re-check here in case the user enabled MFA in another
    // session between login and this call.
    if (user.mfaEnabled) {
      res.status(409).json({
        status: "error",
        message: "MFA is already enabled for this account. Contact an administrator to reset it.",
      });
      return;
    }

    const secret = generateMfaSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: encryptMfaSecret(secret) },
    });

    // The QR code / manual entry secret shown to the user is the plaintext
    // value; only the stored copy is encrypted.
    const qrCodeDataUrl = await generateQrCodeDataUrl(user.email, secret);

    res.json({
      status: "ok",
      secret,
      qrCodeDataUrl,
    });
  } catch (err) {
    next(err);
  }
});

// 3. POST /auth/mfa/enroll/confirm
authRouter.post("/mfa/enroll/confirm", mfaLimiter, async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ status: "error", message: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = verifyMfaChallengeToken(token, "mfa_enroll");
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired enrollment token" });
      return;
    }

    const parseResult = mfaEnrollConfirmSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid code format", errors: parseResult.error.flatten() });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.mfaSecret) {
      res.status(400).json({ status: "error", message: "MFA enrollment not initiated" });
      return;
    }

    if (user.mfaEnabled) {
      res.status(409).json({
        status: "error",
        message: "MFA is already enabled for this account. Contact an administrator to reset it.",
      });
      return;
    }

    const isValid = verifyMfaCode(parseResult.data.code, decryptMfaSecret(user.mfaSecret));
    if (!isValid) {
      res.status(400).json({ status: "error", message: "Invalid verification code" });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true },
    });

    const tokens = await issueTokenPair(user.id, user.role);

    res.json({
      status: "ok",
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
});

// 4. POST /auth/mfa/verify
authRouter.post("/mfa/verify", mfaLimiter, async (req, res, next) => {
  try {
    const parseResult = mfaVerifySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { challengeToken, code } = parseResult.data;
    let payload;
    try {
      payload = verifyMfaChallengeToken(challengeToken, "mfa_challenge");
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired challenge token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      res.status(400).json({ status: "error", message: "MFA is not enabled for this user" });
      return;
    }

    const isValid = verifyMfaCode(code, decryptMfaSecret(user.mfaSecret));
    if (!isValid) {
      res.status(400).json({ status: "error", message: "Invalid verification code" });
      return;
    }

    const tokens = await issueTokenPair(user.id, user.role);

    res.json({
      status: "ok",
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
});

// 5. POST /auth/refresh
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const parseResult = refreshSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { refreshToken } = parseResult.data;

    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!tokenRecord) {
      res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
      return;
    }

    // Reuse detection: this exact token was already rotated away (or
    // explicitly logged out) once before. A legitimate client never
    // presents the same refresh token twice — this is the signal that the
    // token was stolen and both the attacker and the legitimate holder are
    // now racing to use it. Revoke every live token for the user so both
    // are forced to log in again.
    if (tokenRecord.revokedAt !== null) {
      await prisma.refreshToken.updateMany({
        where: { userId: tokenRecord.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.status(401).json({
        status: "error",
        message: "Refresh token reuse detected. All sessions have been revoked — please log in again.",
      });
      return;
    }

    if (tokenRecord.expiresAt < new Date()) {
      res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(401).json({ status: "error", message: "User not found" });
      return;
    }

    // Rotate: revoke the presented token and issue a brand new pair. The
    // old token can now never be validly presented again — any future
    // presentation of it is the reuse-detection branch above.
    await prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await issueTokenPair(user.id, user.role);

    res.json({
      status: "ok",
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
});

// 6. POST /auth/logout
authRouter.post("/logout", async (req, res, next) => {
  try {
    const parseResult = logoutSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { refreshToken } = parseResult.data;
    const tokenHash = hashToken(refreshToken);

    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    res.json({
      status: "ok",
      message: "Logged out",
    });
  } catch (err) {
    next(err);
  }
});

// 7. GET /auth/me
authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, role: true },
    });

    if (!user) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    res.json({
      status: "ok",
      user,
    });
  } catch (err) {
    next(err);
  }
});
