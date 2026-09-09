import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health/index.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  // ── Security & parsing ───────────────────────
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  // ── Logging ──────────────────────────────────
  if (env.NODE_ENV === "development") {
    app.use(morgan("dev"));
  }

  // ── Routes ───────────────────────────────────
  app.use("/health", healthRouter);

  // ── Error handling (must be last) ────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
