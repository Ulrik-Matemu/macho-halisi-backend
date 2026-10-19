import "dotenv/config";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { getMailer } from "./lib/mailer.js";
import { startUptimeScheduler } from "./lib/uptimeScheduler.js";

const app = createApp();

app.listen(env.PORT, () => {
  getMailer()
    ?.verify()
    .then(() => console.log("   Enquiry email: SMTP connection OK"))
    .catch((err) => console.error("   Enquiry email: SMTP check FAILED —", err.message));
  console.log(`🦁 Macho Halisi API running → http://localhost:${env.PORT}`);
  console.log(`   Environment: ${env.NODE_ENV}`);
  // Started here rather than in createApp() so the verify-* scripts, which
  // build their own in-process app, never run background probes.
  startUptimeScheduler();
});

