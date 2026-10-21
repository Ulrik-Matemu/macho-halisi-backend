import { z } from "zod";

// Blank (`FOO=`) is treated as unset rather than an invalid URL.
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  // Development mode exposes stack traces and error details in responses
  // (middleware/errorHandler.ts), so on Render (which sets RENDER=true) an
  // unset NODE_ENV means production rather than falling back to development.
  NODE_ENV: z.enum(["development", "production", "test"]).default(process.env.RENDER ? "production" : "development"),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().default(5433),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DATABASE_URL: z.string().url(),
  // Comma-separated list of allowed origins, e.g.
  // "https://app.example.com,https://staging.example.com". Kept as a single
  // env var (rather than CORS_ORIGIN_1/2/...) so hosts like Vercel/Render
  // need only one value to edit per environment.
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((val) => val.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1, "CORS_ORIGIN must contain at least one valid URL")),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  // Signs the short-lived MFA challenge/enrollment tokens. Separate from
  // JWT_ACCESS_SECRET so an MFA token can never verify as an access token
  // (or vice versa), even if the purpose check in lib/tokens.ts regresses.
  JWT_MFA_SECRET: z.string().min(32, "JWT_MFA_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "MFA_ENCRYPTION_KEY must be a 64-character hex string (32 bytes) — generate with `openssl rand -hex 32`"),
  CLOUDINARY_CLOUD_NAME: z.string().min(1, "CLOUDINARY_CLOUD_NAME is required"),
  CLOUDINARY_API_KEY: z.string().min(1, "CLOUDINARY_API_KEY is required"),
  CLOUDINARY_API_SECRET: z.string().min(1, "CLOUDINARY_API_SECRET is required"),
  // Shared secret the Next.js server sends as X-Ingest-Secret when
  // forwarding analytics events — the only writer allowed on
  // POST /analytics/ingest.
  ANALYTICS_INGEST_SECRET: z.string().min(32, "ANALYTICS_INGEST_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`"),
  // Shared secret the website's server sends as X-Origin-Secret on every
  // API call (src/middleware/requireOriginSecret.ts). While unset the lock
  // is off, so it can be rolled out by setting it on Vercel first and on
  // Render second without a window where the site can't reach the API.
  ORIGIN_SECRET: optionalString.pipe(z.string().min(32, "ORIGIN_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`").optional()),
  // Shared secret the GitHub Actions uptime cron sends as X-Monitor-Secret
  // on POST /monitoring/uptime.
  MONITOR_SECRET: z.string().min(32, "MONITOR_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`"),
  // Built-in uptime checker (src/lib/uptimeScheduler.ts). It only runs when
  // UPTIME_SITE_URL is set, so local dev stays quiet by default. The API's
  // own public URL defaults to Render's RENDER_EXTERNAL_URL.
  UPTIME_SITE_URL: optionalUrl,
  UPTIME_API_URL: optionalUrl,
  // Outbound enquiry email (src/lib/mailer.ts). Mail is skipped, with a
  // warning, unless the sender address and password are both set.
  EMAIL_FOR_ENQUIRIES: optionalString.pipe(z.string().email().optional()),
  EMAIL_PASSWORD_FOR_ENQUIRIES: optionalString,
  EMAIL_SMTP_HOST: optionalString.pipe(z.string().optional()).default("mail.twt.co.tz"),
  EMAIL_SMTP_PORT: z.coerce.number().default(465),
  // Comma-separated recipients of new-enquiry alerts. Test inbox plus the
  // company address for now.
  ENQUIRY_NOTIFY_TO: optionalString
    .default("ulrikjosephat@gmail.com,info@machohalisi.com")
    .transform((val) => (val ?? "").split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().email()).min(1, "ENQUIRY_NOTIFY_TO must contain at least one valid email")),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
