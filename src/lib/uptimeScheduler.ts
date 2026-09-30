import { UptimeTarget } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";

// ── Built-in uptime checker ─────────────────────
//
// Probes the public site and this API every 5 minutes and records the
// results the same way the GitHub Actions workflow does (POST
// /monitoring/uptime), so the dashboard's Monitoring page has a reliable
// feed. GitHub's `schedule` trigger is best-effort — 5-minute schedules are
// routinely delayed or skipped for hours — so it can't be the only source.
// The workflow stays on as an external backup: it's the one that can still
// report (and email about) an outage of this process itself.

const INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 30_000;
const TIMEOUT_MS = 20_000;
const SOURCE = "backend-scheduler";

interface CheckResult {
  target: UptimeTarget;
  url: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

async function probe(target: UptimeTarget, url: string): Promise<{ result: CheckResult; body: unknown }> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MachoHalisi-UptimeMonitor/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - start);
    const body = await res.json().catch(() => null);
    const ok = res.status >= 200 && res.status < 400;
    return {
      result: { target, url, ok, statusCode: res.status, latencyMs, error: ok ? null : `HTTP ${res.status}` },
      body,
    };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : err.message) : "Request failed";
    return { result: { target, url, ok: false, statusCode: null, latencyMs: null, error: message.slice(0, 200) }, body: null };
  }
}

export async function runUptimeChecks(siteUrl: string, apiUrl: string): Promise<CheckResult[]> {
  const site = siteUrl.replace(/\/$/, "");
  const api = apiUrl.replace(/\/$/, "");

  const [home, itineraries, enquire, health] = await Promise.all([
    probe("SITE", `${site}/`),
    probe("PAGE", `${site}/itineraries`),
    probe("PAGE", `${site}/enquire`),
    probe("API", `${api}/health`),
  ]);

  // /health reports database connectivity — record it as its own target so
  // a DB outage is distinguishable from an API outage (same as the workflow).
  const healthBody = health.body as { database?: { connected?: boolean; latencyMs?: number } } | null;
  const dbOk = health.result.ok && healthBody?.database?.connected === true;
  const database: CheckResult = {
    target: "DATABASE",
    url: `${api}/health#database`,
    ok: dbOk,
    statusCode: null,
    latencyMs: dbOk ? healthBody?.database?.latencyMs ?? null : null,
    error: dbOk ? null : health.result.ok ? "Database not connected" : "API unreachable",
  };

  const results = [home.result, itineraries.result, enquire.result, health.result, database];
  await prisma.uptimeCheck.createMany({
    data: results.map((r) => ({ ...r, source: SOURCE, checkedAt: new Date() })),
  });
  return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Starts the 5-minute checker when UPTIME_SITE_URL is configured. Returns whether it started. */
export function startUptimeScheduler(): boolean {
  const siteUrl = env.UPTIME_SITE_URL;
  const apiUrl = env.UPTIME_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`;
  if (!siteUrl || timer) return false;

  const tick = async () => {
    if (running) return; // never overlap a slow run with the next one
    running = true;
    try {
      const results = await runUptimeChecks(siteUrl, apiUrl);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.warn(`Uptime check: ${failed.length} failing —`, failed.map((f) => `${f.target} ${f.url} (${f.error})`).join("; "));
      }
    } catch (err) {
      console.error("Uptime check run failed:", err);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, FIRST_RUN_DELAY_MS).unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  console.log(`   Uptime checks: every 5 min → site ${siteUrl}, API ${apiUrl}`);
  return true;
}
