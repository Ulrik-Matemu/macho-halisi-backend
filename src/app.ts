import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health/index.js";
import { publicRouter } from "./routes/public/index.js";
import { authRouter } from "./routes/auth/index.js";
import { usersRouter } from "./routes/users/index.js";
import { itinerariesRouter } from "./routes/itineraries/index.js";
import { uploadsRouter } from "./routes/uploads/index.js";
import { destinationsRouter } from "./routes/destinations/index.js";
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
  // Unauthenticated public routes — mounted first and deliberately never
  // pass through requireAuth, unlike every other router below.
  app.use("/public", publicRouter);
  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/itineraries", itinerariesRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/destinations", destinationsRouter);

  // ── Error handling (must be last) ────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
