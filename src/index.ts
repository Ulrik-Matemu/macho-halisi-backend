import "dotenv/config";
import { env } from "./config/env.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`🦁 Macho Halisi API running → http://localhost:${env.PORT}`);
  console.log(`   Environment: ${env.NODE_ENV}`);
});

