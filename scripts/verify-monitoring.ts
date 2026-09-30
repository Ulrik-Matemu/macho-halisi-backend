import "dotenv/config";
import http from "node:http";
import { Role } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/lib/password.js";
import { signAccessToken } from "../src/lib/tokens.js";
import { flushRequestMetrics } from "../src/middleware/requestMetrics.js";

// Verifies the monitoring, analytics and enquiry-inbox surfaces end to end
// against a temporary in-process server: shared-secret writes, ADMIN-only
// reads, aggregate correctness for seeded data, and enquiry hardening.

interface TestCaseResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestCaseResult[] = [];

function check(name: string, passed: boolean, details = "") {
  results.push({ name, passed, details });
  console.log(`${passed ? "✅" : "❌"} ${name}${details ? ` — ${details}` : ""}`);
}

async function call(
  serverUrl: string,
  path: string,
  init: { method?: string; token?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${serverUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  console.log("📈 Running Monitoring & Enquiries verification suite ...\n");

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const serverUrl = `http://localhost:${(server.address() as { port: number }).port}`;

  const suffix = Date.now();
  const uniquePath = `/verify-monitoring-${suffix}`;
  const sessionA = `verify-session-a-${suffix}`;
  const sessionB = `verify-session-b-${suffix}`;
  const uptimeUrl = `https://verify-${suffix}.test/`;
  const errorMessage = `VerifyMonitoringError ${suffix}`;
  const enquiryEmail = `verify-enquiry-${suffix}@test.local`;
  const userIds: string[] = [];

  try {
    // ── Seed one ADMIN and one EDITOR, with tokens minted directly.
    const [admin, editor] = await Promise.all(
      [Role.ADMIN, Role.EDITOR].map(async (role) =>
        prisma.user.create({
          data: {
            email: `verify-monitoring-${role.toLowerCase()}-${suffix}@test.local`,
            passwordHash: await hashPassword("Irrelevant123!"),
            role,
          },
        })
      )
    );
    userIds.push(admin.id, editor.id);
    const adminToken = signAccessToken({ userId: admin.id, role: Role.ADMIN });
    const editorToken = signAccessToken({ userId: editor.id, role: Role.EDITOR });

    // ── Analytics ingest ──────────────────────────
    const base = { visitorHash: `hash-${suffix}-a`, sessionId: sessionA, country: "tz", device: "desktop" };
    const batch = {
      events: [
        { ...base, type: "PAGEVIEW", path: uniquePath, referrerHost: "google.com", utmSource: "verify" },
        { ...base, type: "PAGEVIEW", path: `${uniquePath}/second` },
        { ...base, type: "WEB_VITAL", name: "LCP", path: uniquePath, value: 1800 },
        { ...base, type: "JS_ERROR", name: errorMessage, path: uniquePath, metadata: { source: "verify.js" } },
        { ...base, type: "EVENT", name: "enquiry_open", path: uniquePath },
        { visitorHash: `hash-${suffix}-b`, sessionId: sessionB, type: "PAGEVIEW", path: uniquePath, country: "GB" },
      ],
    };

    let r = await call(serverUrl, "/analytics/ingest", { method: "POST", body: batch });
    check("Ingest rejects a missing secret", r.status === 401, `HTTP ${r.status}`);

    r = await call(serverUrl, "/analytics/ingest", {
      method: "POST",
      body: batch,
      headers: { "X-Ingest-Secret": "wrong-secret-wrong-secret-wrong-secret" },
    });
    check("Ingest rejects a wrong secret", r.status === 401, `HTTP ${r.status}`);

    r = await call(serverUrl, "/analytics/ingest", {
      method: "POST",
      body: batch,
      headers: { "X-Ingest-Secret": env.ANALYTICS_INGEST_SECRET },
    });
    check("Ingest accepts a valid batch", r.status === 202 && r.data.accepted === 6, `HTTP ${r.status}, accepted=${r.data.accepted}`);

    // ── Admin guard ───────────────────────────────
    r = await call(serverUrl, "/analytics/overview", {});
    check("Analytics requires authentication", r.status === 401, `HTTP ${r.status}`);
    r = await call(serverUrl, "/analytics/overview", { token: editorToken });
    check("Analytics is forbidden to EDITOR", r.status === 403, `HTTP ${r.status}`);
    r = await call(serverUrl, "/monitoring/system", { token: editorToken });
    check("Monitoring is forbidden to EDITOR", r.status === 403, `HTTP ${r.status}`);
    r = await call(serverUrl, "/enquiries", { token: editorToken });
    check("Enquiry inbox is forbidden to EDITOR", r.status === 403, `HTTP ${r.status}`);

    // ── Aggregates ───────────────────────────────
    r = await call(serverUrl, "/analytics/overview?range=24h", { token: adminToken });
    check(
      "Overview returns KPIs for ADMIN",
      r.status === 200 && r.data.current.pageviews >= 3 && r.data.current.sessions >= 2,
      `pageviews=${r.data.current?.pageviews}, sessions=${r.data.current?.sessions}`
    );

    r = await call(serverUrl, "/analytics/breakdown?range=24h&dimension=page&limit=50", { token: adminToken });
    const pageRow = r.data.data?.find((row: any) => row.label === uniquePath);
    check("Page breakdown counts seeded pageviews", pageRow?.value === 2 && pageRow?.secondary === 2, JSON.stringify(pageRow));

    r = await call(serverUrl, "/analytics/breakdown?range=24h&dimension=entry&limit=50", { token: adminToken });
    const entryRow = r.data.data?.find((row: any) => row.label === uniquePath);
    check("Entry breakdown finds both sessions' first page", entryRow?.value === 2, JSON.stringify(entryRow));

    r = await call(serverUrl, "/analytics/breakdown?range=24h&dimension=country&limit=50", { token: adminToken });
    check(
      "Country breakdown normalizes codes to upper case",
      r.status === 200 && r.data.data.some((row: any) => row.label === "TZ"),
      `HTTP ${r.status}`
    );

    r = await call(serverUrl, "/analytics/breakdown?range=24h&dimension=nope", { token: adminToken });
    check("Breakdown rejects an unknown dimension", r.status === 400, `HTTP ${r.status}`);

    r = await call(serverUrl, "/analytics/timeseries?range=24h", { token: adminToken });
    check("Timeseries returns hourly buckets", r.status === 200 && r.data.data.length >= 24, `buckets=${r.data.data?.length}`);

    r = await call(serverUrl, "/analytics/realtime", { token: adminToken });
    check("Realtime counts active sessions", r.status === 200 && r.data.activeVisitors >= 2, `active=${r.data.activeVisitors}`);

    // ── Uptime ───────────────────────────────────
    const uptimeBody = {
      checks: [
        { target: "SITE", url: uptimeUrl, ok: false, statusCode: 502, latencyMs: 900 },
      ],
    };
    r = await call(serverUrl, "/monitoring/uptime", { method: "POST", body: uptimeBody });
    check("Uptime write rejects a missing secret", r.status === 401, `HTTP ${r.status}`);

    r = await call(serverUrl, "/monitoring/uptime", {
      method: "POST",
      body: uptimeBody,
      headers: { "X-Monitor-Secret": env.MONITOR_SECRET },
    });
    await call(serverUrl, "/monitoring/uptime", {
      method: "POST",
      body: { checks: [{ target: "SITE", url: uptimeUrl, ok: true, statusCode: 200, latencyMs: 120 }] },
      headers: { "X-Monitor-Secret": env.MONITOR_SECRET },
    });
    check("Uptime write accepts results with the secret", r.status === 201, `HTTP ${r.status}`);

    r = await call(serverUrl, "/monitoring/uptime?range=24h", { token: adminToken });
    const latest = r.data.latest?.find((row: any) => row.url === uptimeUrl);
    const incident = r.data.incidents?.find((row: any) => row.url === uptimeUrl);
    check(
      "Uptime report shows latest status, fresh monitor and a resolved incident",
      r.status === 200 && latest?.ok === true && r.data.stale === false && incident && !incident.ongoing,
      `latest.ok=${latest?.ok}, stale=${r.data.stale}, incident=${incident ? (incident.ongoing ? "ongoing" : "resolved") : "none"}`
    );

    // ── Performance, vitals, errors, system ──────
    await flushRequestMetrics(true);
    r = await call(serverUrl, "/monitoring/performance?range=24h", { token: adminToken });
    check(
      "Performance aggregates flushed request metrics",
      r.status === 200 && r.data.totals.requests > 0 && r.data.routes.some((x: any) => x.route === "/analytics/overview"),
      `requests=${r.data.totals?.requests}`
    );

    r = await call(serverUrl, "/monitoring/web-vitals?range=24h", { token: adminToken });
    check(
      "Web vitals report p75 with a rating",
      r.status === 200 && r.data.overall.some((v: any) => v.name === "LCP" && v.rating),
      JSON.stringify(r.data.overall?.find((v: any) => v.name === "LCP"))
    );

    r = await call(serverUrl, "/monitoring/errors?range=24h", { token: adminToken });
    check(
      "Errors report groups the seeded JS error",
      r.status === 200 && r.data.clientErrors.some((e: any) => e.message === errorMessage),
      `HTTP ${r.status}`
    );

    r = await call(serverUrl, "/monitoring/system", { token: adminToken });
    check("System report shows a connected database", r.status === 200 && r.data.database.connected === true, `HTTP ${r.status}`);

    // ── Enquiries ─────────────────────────────────
    r = await call(serverUrl, "/public/enquiries", {
      method: "POST",
      body: {
        name: "Verify Guest",
        email: enquiryEmail,
        phone: "+255 700 000 000",
        source: "modal",
        pagePath: uniquePath,
        sessionId: sessionA,
        country: "tz",
      },
    });
    const enquiryId = r.data.enquiryId;
    check("Public enquiry is stored", r.status === 201 && !!enquiryId, `HTTP ${r.status}`);

    r = await call(serverUrl, "/public/enquiries", {
      method: "POST",
      body: { name: "Spam Bot", email: `bot-${suffix}@test.local`, phone: "12345", website: "http://spam" },
    });
    const botRows = await prisma.enquiry.count({ where: { email: `bot-${suffix}@test.local` } });
    check("Honeypot submissions look successful but are not stored", r.status === 201 && botRows === 0, `HTTP ${r.status}, rows=${botRows}`);

    r = await call(serverUrl, `/enquiries?q=${encodeURIComponent(enquiryEmail)}`, { token: adminToken });
    check("Inbox search finds the enquiry", r.status === 200 && r.data.data.length === 1 && r.data.data[0].country === "TZ", `found=${r.data.data?.length}`);

    r = await call(serverUrl, `/enquiries/${enquiryId}`, { token: adminToken });
    check("Enquiry detail includes the visitor's journey", r.status === 200 && r.data.journey.length === 2, `journey=${r.data.journey?.length}`);

    r = await call(serverUrl, `/enquiries/${enquiryId}`, {
      method: "PATCH",
      token: adminToken,
      body: { status: "RESPONDED", staffNotes: "Called back" },
    });
    check(
      "Marking RESPONDED stamps respondedAt and handler",
      r.status === 200 && !!r.data.enquiry.respondedAt && r.data.enquiry.handledBy?.id === admin.id,
      `HTTP ${r.status}`
    );

    r = await call(serverUrl, "/enquiries/stats", { token: adminToken });
    check("Stats report counts by status", r.status === 200 && r.data.byStatus.RESPONDED >= 1, `HTTP ${r.status}`);

    r = await call(serverUrl, `/enquiries/not-a-uuid`, { token: adminToken });
    check("Invalid enquiry id is a 404, not a 500", r.status === 404, `HTTP ${r.status}`);

    r = await call(serverUrl, `/enquiries/${enquiryId}`, { method: "DELETE", token: adminToken });
    check("Enquiry can be deleted", r.status === 200, `HTTP ${r.status}`);

    // Two submissions used above; the limiter allows 5 per window.
    let lastStatus = 0;
    for (let i = 0; i < 4; i++) {
      const res = await call(serverUrl, "/public/enquiries", {
        method: "POST",
        body: { name: "Rate Limit", email: `ratelimit-${suffix}-${i}@test.local`, phone: "12345", website: "x" },
      });
      lastStatus = res.status;
    }
    check("Public enquiries are rate limited", lastStatus === 429, `last HTTP ${lastStatus}`);
  } finally {
    await prisma.analyticsEvent.deleteMany({ where: { sessionId: { in: [sessionA, sessionB] } } });
    await prisma.uptimeCheck.deleteMany({ where: { url: uptimeUrl } });
    await prisma.enquiry.deleteMany({ where: { email: { contains: `${suffix}@test.local` } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ Verification suite crashed:", err);
  process.exit(1);
});
