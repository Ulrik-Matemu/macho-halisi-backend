import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { secretsMatch } from "../lib/secret.js";
import { isFromWebsite } from "./requireOriginSecret.js";

/**
 * The visitor's IP, for rate-limit keys. Nearly all traffic arrives via the
 * website's server (Vercel), so req.ip is Vercel's egress IP, shared by
 * every visitor. The website forwards the real client IP in X-Client-IP,
 * trusted only alongside a valid origin or ingest secret, so a direct
 * caller can't spoof its way out of a limit. Null when the website called
 * without a visitor behind it (build-time / ISR fetches).
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-client-ip"];
  const trusted = isFromWebsite(req) || secretsMatch(req.headers["x-ingest-secret"], env.ANALYTICS_INGEST_SECRET);
  if (trusted) return typeof forwarded === "string" && forwarded ? forwarded : null;
  return req.ip ?? "unknown";
}

const clientKey = (req: Request) => ipKeyGenerator(clientIp(req) ?? "website");

/**
 * Global ceiling on every API route — a flood guard, not a fair-use quota,
 * so it sits well above anything a real visitor or editor produces. The
 * website's own server-side fetches (no visitor IP; build/ISR) are exempt:
 * they're already bounded by Next's cache.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Off until the origin lock is on: without it, every visitor and the
  // site's own ISR fetches share Vercel's IP and would trip one bucket.
  skip: (req) => !env.ORIGIN_SECRET || clientIp(req) === null,
  keyGenerator: clientKey,
  message: { status: "error", message: "Too many requests. Please slow down." },
});

/**
 * Applies to POST /auth/refresh. A session refreshes about once per access
 * token lifetime (15 min); the ceiling allows for parallel dashboard
 * requests racing to refresh while still stopping refresh-token guessing.
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { status: "error", message: "Too many session refreshes. Please log in again." },
});

// ── Auth endpoint rate limiting ─────────────────
//
// A 6-digit TOTP code has only 10^6 possibilities, and a login attempt is a
// direct password guess. Neither endpoint had any request cap before this,
// so both were brute-forceable with unlimited attempts.

/**
 * Applies to POST /auth/login. Keyed on IP + the submitted email so a
 * single IP can't lock out every account, and a single account can't be
 * hammered from many IPs without each IP still being capped individually.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `${clientKey(req)}:${email}`;
  },
  message: {
    status: "error",
    message: "Too many login attempts. Please try again in a few minutes.",
  },
});

/**
 * Applies to POST /auth/mfa/verify and POST /auth/mfa/enroll/confirm.
 * Keyed on IP + the challenge/enrollment token subject (rather than the
 * raw token, which changes every login) so repeated code guesses against
 * one in-flight challenge are capped tightly.
 */
export const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token =
      (typeof req.body?.challengeToken === "string" && req.body.challengeToken) ||
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "");
    return `${clientKey(req)}:${token}`;
  },
  message: {
    status: "error",
    message: "Too many verification attempts. Please request a new code.",
  },
});

/**
 * Applies to POST /public/enquiries. The enquiry form is the only
 * anonymous write on the public API, so it's capped per IP to keep a
 * scripted flood from burying genuine leads in the dashboard inbox.
 */
export const enquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: {
    status: "error",
    message: "Too many enquiries from this connection. Please try again shortly or reach us on WhatsApp.",
  },
});

/**
 * Applies to POST /analytics/ingest. Every request arrives from the
 * Next.js server (one IP), so this is a coarse ceiling against a runaway
 * client rather than per-visitor throttling.
 */
export const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Ingest rate limit exceeded" },
});
