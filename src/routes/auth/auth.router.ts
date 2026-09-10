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
} from "../../lib/tokens.js";
import { generateMfaSecret, verifyMfaCode, generateQrCodeDataUrl } from "../../lib/mfa.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  loginSchema,
  mfaVerifySchema,
  mfaEnrollConfirmSchema,
  refreshSchema,
  logoutSchema,
} from "./auth.schemas.js";

export const authRouter = Router();

// Helper to issue access and refresh token pair
async function issueTokenPair(userId: string, role: Role) {
  const accessToken = signAccessToken({ userId, role });
  const tokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ userId, tokenId });
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

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
authRouter.post("/login", async (req, res, next) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { email, password } = parseResult.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ status: "error", message: "Invalid email or password" });
      return;
    }

    const challengeToken = signMfaChallengeToken(user.id);

    if (!user.mfaEnabled) {
      res.json({
        status: "mfa_enrollment_required",
        challengeToken,
      });
      return;
    }

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
      payload = verifyMfaChallengeToken(token);
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired challenge token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    const secret = generateMfaSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: secret },
    });

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
authRouter.post("/mfa/enroll/confirm", async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ status: "error", message: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = verifyMfaChallengeToken(token);
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired challenge token" });
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

    const isValid = verifyMfaCode(parseResult.data.code, user.mfaSecret);
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
authRouter.post("/mfa/verify", async (req, res, next) => {
  try {
    const parseResult = mfaVerifySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ status: "error", message: "Invalid request payload", errors: parseResult.error.flatten() });
      return;
    }

    const { challengeToken, code } = parseResult.data;
    let payload;
    try {
      payload = verifyMfaChallengeToken(challengeToken);
    } catch {
      res.status(401).json({ status: "error", message: "Invalid or expired challenge token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      res.status(400).json({ status: "error", message: "MFA is not enabled for this user" });
      return;
    }

    const isValid = verifyMfaCode(code, user.mfaSecret);
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

    if (!tokenRecord || tokenRecord.revokedAt !== null || tokenRecord.expiresAt < new Date()) {
      res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(401).json({ status: "error", message: "User not found" });
      return;
    }

    const accessToken = signAccessToken({ userId: user.id, role: user.role });

    res.json({
      status: "ok",
      accessToken,
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
