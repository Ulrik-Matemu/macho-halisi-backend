import { RequestHandler } from "express";
import { Role } from "@prisma/client";
import { verifyAccessToken } from "../lib/tokens.js";

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

export const requireAuth: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ status: "error", message: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.userId, role: payload.role };
    next();
  } catch (err) {
    res.status(401).json({ status: "error", message: "Invalid or expired access token" });
  }
};
