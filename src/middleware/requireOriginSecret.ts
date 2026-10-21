import { RequestHandler, Request } from "express";
import { env } from "../config/env.js";
import { secretsMatch } from "../lib/secret.js";

/** True when the request was sent by the website's own server. */
export function isFromWebsite(req: Request): boolean {
  return !!env.ORIGIN_SECRET && secretsMatch(req.headers["x-origin-secret"], env.ORIGIN_SECRET);
}

// Routes reachable without the origin secret: Render's health check and the
// built-in uptime scheduler hit /health, and the GitHub uptime cron posts to
// /monitoring/uptime with its own MONITOR_SECRET.
const EXEMPT = [
  { method: "GET", path: "/health" },
  { method: "POST", path: "/monitoring/uptime" },
];

/**
 * Locks the API to the website. Every legitimate caller is the Next.js
 * server (browsers never talk to this API directly), so anything without
 * the shared X-Origin-Secret is someone who found the onrender.com URL.
 * Rejected before any router, database query or body-heavy work runs.
 * Inactive until ORIGIN_SECRET is set — see src/config/env.ts.
 */
export const requireOriginSecret: RequestHandler = (req, res, next) => {
  if (!env.ORIGIN_SECRET) return next();
  const path = req.path.replace(/\/+$/, "") || "/";
  if (EXEMPT.some((e) => e.method === req.method && e.path === path)) return next();
  if (isFromWebsite(req)) return next();
  res.status(403).json({ status: "error", message: "Forbidden" });
};
