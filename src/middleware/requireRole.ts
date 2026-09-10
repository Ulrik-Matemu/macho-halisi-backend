import { RequestHandler } from "express";
import { Role } from "@prisma/client";

export function requireRole(...allowedRoles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ status: "error", message: "Authentication required" });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ status: "error", message: "Insufficient permissions" });
      return;
    }

    next();
  };
}
