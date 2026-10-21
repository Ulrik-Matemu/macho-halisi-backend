import { RequestHandler } from "express";
import { Role } from "@prisma/client";
import { verifyAccessToken } from "../lib/tokens.js";
import { prisma } from "../db/prisma.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: Role;
      };
    }
  }
}

// The JWT proves who the caller is, but its role claim is frozen for the
// token's ~15 min lifetime. Each request re-reads the account's current
// role and active flag instead, so a deactivation or demotion takes effect
// immediately rather than when the token expires. Cached briefly to keep
// this to roughly one query per user per window; users.router.ts clears an
// entry the moment it changes that user.
const ACCOUNT_CACHE_TTL_MS = 30 * 1000;
const accountCache = new Map<string, { role: Role; isActive: boolean; expiresAt: number }>();

export function invalidateAuthCache(userId: string) {
  accountCache.delete(userId);
}

async function currentAccount(userId: string) {
  const cached = accountCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!user) {
    accountCache.delete(userId);
    return null;
  }
  const entry = { ...user, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS };
  accountCache.set(userId, entry);
  return entry;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ status: "error", message: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  let userId: string;
  try {
    userId = verifyAccessToken(token).userId;
  } catch {
    res.status(401).json({ status: "error", message: "Invalid or expired access token" });
    return;
  }

  try {
    const account = await currentAccount(userId);
    if (!account || !account.isActive) {
      res.status(401).json({ status: "error", message: "Invalid or expired access token" });
      return;
    }
    req.user = { userId, role: account.role };
    next();
  } catch (err) {
    next(err);
  }
};
