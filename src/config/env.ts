import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
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
  // Shared secret the GitHub Actions uptime cron sends as X-Monitor-Secret
  // on POST /monitoring/uptime.
  MONITOR_SECRET: z.string().min(32, "MONITOR_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`"),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
