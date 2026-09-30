import "dotenv/config";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startUptimeScheduler } from "./lib/uptimeScheduler.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`🦁 Macho Halisi API running → http://localhost:${env.PORT}`);
  console.log(`   Environment: ${env.NODE_ENV}`);
  // Started here rather than in createApp() so the verify-* scripts, which
  // build their own in-process app, never run background probes.
  startUptimeScheduler();
});

