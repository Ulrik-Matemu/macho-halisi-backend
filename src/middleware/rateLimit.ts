import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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
    return `${ipKeyGenerator(req.ip ?? "unknown")}:${email}`;
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
    return `${ipKeyGenerator(req.ip ?? "unknown")}:${token}`;
  },
  message: {
    status: "error",
    message: "Too many verification attempts. Please request a new code.",
  },
});
