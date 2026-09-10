import "dotenv/config";
import http from "node:http";
import { Role, ItineraryStatus } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { signAccessToken } from "../src/lib/tokens.js";
import { hashPassword } from "../src/lib/password.js";

interface TestCaseResult {
  num: number;
  name: string;
  passed: boolean;
  status: number;
  expectedStatus: number;
  details: string;
}

const results: TestCaseResult[] = [];
const TOTAL_TESTS = 10;

async function makeRequest(
  serverUrl: string,
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; data: any; raw: string }> {
  const url = `${serverUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, options);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, raw: text };
}

async function main() {
  console.log("📅 Running Availability & Inventory Tracking verification suite...\n");

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Temporary test server listening on ${serverUrl}\n`);

  const suffix = Date.now();
  const seeded: { userIds: string[]; itineraryId?: string } = { userIds: [] };

  try {
    // ── Setup: temp AUTHOR + temp VIEWER, one DRAFT itinerary with a day
    // (publish requires at least one day) ─────────────────────────────
    const author = await prisma.user.create({
      data: {
        email: `avail-test-author-${suffix}@test.local`,
        passwordHash: await hashPassword("AuthorPassword123!"),
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    const viewer = await prisma.user.create({
      data: {
        email: `avail-test-viewer-${suffix}@test.local`,
        passwordHash: await hashPassword("ViewerPassword123!"),
        role: Role.VIEWER,
        mfaEnabled: false,
      },
    });
    seeded.userIds.push(author.id, viewer.id);
    const authorToken = signAccessToken({ userId: author.id, role: Role.AUTHOR });
    const viewerToken = signAccessToken({ userId: viewer.id, role: Role.VIEWER });

    const itinerary = await prisma.itinerary.create({
      data: {
        title: `Availability Test Itinerary ${suffix}`,
        slug: `availability-test-${suffix}`,
        status: ItineraryStatus.DRAFT,
        authorId: author.id,
        nights: 5,
        startingPrice: 2999,
        priceOnRequest: false,
        days: { create: [{ dayNumber: 1, title: "Arrival", activities: [] }] },
      },
    });
    seeded.itineraryId = itinerary.id;
    console.log(`👤 Seeded AUTHOR/VIEWER users and one DRAFT itinerary (${itinerary.slug})\n`);

    // ──────────────────────────────────────────────────────────────
    // TEST 1: AUTHOR creates a period -> 201
    // ──────────────────────────────────────────────────────────────
    console.log("--- Test 1: AUTHOR creates an availability period ---");
    const res1 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods`,
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      { startDate: "2026-06-01", endDate: "2026-10-31", status: "AVAILABLE", note: "Peak migration season" }
    );
    const pass1 =
      res1.status === 201 &&
      res1.data?.status === "ok" &&
      res1.data?.period?.status === "AVAILABLE" &&
      res1.data?.period?.note === "Peak migration season";

    results.push({
      num: 1,
      name: "POST .../availability-periods creates a period as AUTHOR",
      passed: pass1,
      status: res1.status,
      expectedStatus: 201,
      details: `Response: ${JSON.stringify(res1.data)}`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED" : `❌ Test 1 FAILED: ${JSON.stringify(res1.data)}`);

    const periodId = res1.data?.period?.id;

    // ──────────────────────────────────────────────────────────────
    // TEST 2 (REGRESSION): VIEWER is blocked from creating a period
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 2 (REGRESSION): VIEWER blocked from creating a period ---");
    const res2 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods`,
      "POST",
      { Authorization: `Bearer ${viewerToken}` },
      { startDate: "2026-01-01", endDate: "2026-01-10", status: "LIMITED" }
    );
    const pass2 = res2.status === 403 && res2.data?.status === "error";

    results.push({
      num: 2,
      name: "REGRESSION: VIEWER role is rejected with 403 on create",
      passed: pass2,
      status: res2.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(res2.data)}`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED" : `❌ Test 2 FAILED: ${JSON.stringify(res2.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 3: endDate before startDate is rejected with 400
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 3: endDate before startDate is rejected ---");
    const res3 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods`,
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      { startDate: "2026-12-20", endDate: "2026-12-01", status: "FULLY_BOOKED" }
    );
    const pass3 = res3.status === 400 && res3.data?.status === "error";

    results.push({
      num: 3,
      name: "endDate earlier than startDate is rejected with 400",
      passed: pass3,
      status: res3.status,
      expectedStatus: 400,
      details: `Response: ${JSON.stringify(res3.data)}`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED" : `❌ Test 3 FAILED: ${JSON.stringify(res3.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 4: PATCH updates the period
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 4: AUTHOR updates the period ---");
    const res4 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods/${periodId}`,
      "PATCH",
      { Authorization: `Bearer ${authorToken}` },
      { startDate: "2026-06-01", endDate: "2026-10-31", status: "LIMITED", note: "Fewer camps open now" }
    );
    const pass4 =
      res4.status === 200 &&
      res4.data?.period?.status === "LIMITED" &&
      res4.data?.period?.note === "Fewer camps open now";

    results.push({
      num: 4,
      name: "PATCH .../availability-periods/:id updates status and note",
      passed: pass4,
      status: res4.status,
      expectedStatus: 200,
      details: `Response: ${JSON.stringify(res4.data)}`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED" : `❌ Test 4 FAILED: ${JSON.stringify(res4.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 5: dashboard GET /itineraries/:id includes the period
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 5: dashboard detail GET includes availabilityPeriods ---");
    const res5 = await makeRequest(serverUrl, `/itineraries/${itinerary.id}`, "GET", {
      Authorization: `Bearer ${authorToken}`,
    });
    const pass5 =
      res5.status === 200 &&
      Array.isArray(res5.data?.itinerary?.availabilityPeriods) &&
      res5.data.itinerary.availabilityPeriods.length === 1 &&
      res5.data.itinerary.availabilityPeriods[0].status === "LIMITED";

    results.push({
      num: 5,
      name: "GET /itineraries/:id includes the period in availabilityPeriods",
      passed: pass5,
      status: res5.status,
      expectedStatus: 200,
      details: `availabilityPeriods: ${JSON.stringify(res5.data?.itinerary?.availabilityPeriods)}`,
    });
    console.log(pass5 ? "✅ Test 5 PASSED" : `❌ Test 5 FAILED: ${JSON.stringify(res5.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 6 (REGRESSION): after PATCH /publish, the full-replace
    // response still carries availabilityPeriods (the dashboard editor
    // does setFormState(data.itinerary) on publish/archive — if the
    // publish route's include omitted this field, periods would appear
    // to vanish from the editor until a reload).
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 6 (REGRESSION): PATCH /publish response still includes availabilityPeriods ---");
    const res6 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/publish`,
      "PATCH",
      { Authorization: `Bearer ${signAccessToken({ userId: author.id, role: Role.ADMIN })}` }
    );
    const pass6 =
      res6.status === 200 &&
      Array.isArray(res6.data?.itinerary?.availabilityPeriods) &&
      res6.data.itinerary.availabilityPeriods.length === 1;

    results.push({
      num: 6,
      name: "REGRESSION: publish response includes availabilityPeriods (not silently dropped)",
      passed: pass6,
      status: res6.status,
      expectedStatus: 200,
      details: `availabilityPeriods present: ${Array.isArray(res6.data?.itinerary?.availabilityPeriods)}, count: ${res6.data?.itinerary?.availabilityPeriods?.length}`,
    });
    console.log(pass6 ? "✅ Test 6 PASSED" : `❌ Test 6 FAILED: ${JSON.stringify(res6.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 7: public detail endpoint returns the period
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 7: public detail endpoint returns availabilityPeriods ---");
    const res7 = await makeRequest(serverUrl, `/public/itineraries/${itinerary.slug}`, "GET");
    const pass7 =
      res7.status === 200 &&
      Array.isArray(res7.data?.itinerary?.availabilityPeriods) &&
      res7.data.itinerary.availabilityPeriods.length === 1 &&
      res7.data.itinerary.availabilityPeriods[0].note === "Fewer camps open now";

    results.push({
      num: 7,
      name: "GET /public/itineraries/:slug includes availabilityPeriods",
      passed: pass7,
      status: res7.status,
      expectedStatus: 200,
      details: `availabilityPeriods: ${JSON.stringify(res7.data?.itinerary?.availabilityPeriods)}`,
    });
    console.log(pass7 ? "✅ Test 7 PASSED" : `❌ Test 7 FAILED: ${JSON.stringify(res7.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 8: public LIST endpoint also carries periods (summary/detail
    // parity — deliberately reversed from the original design, which kept
    // this endpoint period-free; the homepage/grid cards now need it to
    // compute a compact "current or next" line client-side).
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 8: public list endpoint includes availabilityPeriods (summary/detail parity) ---");
    const res8 = await makeRequest(serverUrl, `/public/itineraries?limit=50`, "GET");
    const listEntry = (res8.data?.data || []).find((i: any) => i.id === itinerary.id);
    const pass8 =
      res8.status === 200 &&
      Array.isArray(listEntry?.availabilityPeriods) &&
      listEntry.availabilityPeriods.length === 1 &&
      listEntry.availabilityPeriods[0].note === "Fewer camps open now";

    results.push({
      num: 8,
      name: "GET /public/itineraries (summary) includes availabilityPeriods per itinerary",
      passed: pass8,
      status: res8.status,
      expectedStatus: 200,
      details: `availabilityPeriods on list entry: ${JSON.stringify(listEntry?.availabilityPeriods)}`,
    });
    console.log(pass8 ? "✅ Test 8 PASSED" : `❌ Test 8 FAILED: ${JSON.stringify(listEntry)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 9: DELETE removes the period
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 9: AUTHOR deletes the period ---");
    const res9 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods/${periodId}`,
      "DELETE",
      { Authorization: `Bearer ${authorToken}` }
    );
    const res9Check = await makeRequest(serverUrl, `/itineraries/${itinerary.id}`, "GET", {
      Authorization: `Bearer ${authorToken}`,
    });
    const pass9 =
      res9.status === 200 &&
      res9.data?.status === "ok" &&
      Array.isArray(res9Check.data?.itinerary?.availabilityPeriods) &&
      res9Check.data.itinerary.availabilityPeriods.length === 0;

    results.push({
      num: 9,
      name: "DELETE .../availability-periods/:id removes it (confirmed via follow-up GET)",
      passed: pass9,
      status: res9.status,
      expectedStatus: 200,
      details: `Delete response: ${JSON.stringify(res9.data)}, periods remaining: ${res9Check.data?.itinerary?.availabilityPeriods?.length}`,
    });
    console.log(pass9 ? "✅ Test 9 PASSED" : `❌ Test 9 FAILED: ${JSON.stringify(res9.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 10: deleting an already-deleted period returns 404
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 10: deleting an already-deleted period returns 404 ---");
    const res10 = await makeRequest(
      serverUrl,
      `/itineraries/${itinerary.id}/availability-periods/${periodId}`,
      "DELETE",
      { Authorization: `Bearer ${authorToken}` }
    );
    const pass10 = res10.status === 404 && res10.data?.status === "error";

    results.push({
      num: 10,
      name: "DELETE on an already-deleted period returns 404",
      passed: pass10,
      status: res10.status,
      expectedStatus: 404,
      details: `Response: ${JSON.stringify(res10.data)}`,
    });
    console.log(pass10 ? "✅ Test 10 PASSED" : `❌ Test 10 FAILED: ${JSON.stringify(res10.data)}`);
  } catch (err: any) {
    console.error("❌ Unexpected test execution error:", err);
  } finally {
    console.log("\n🧹 Cleaning up seeded test data & stopping test server...");
    if (seeded.itineraryId) {
      await prisma.itinerary.delete({ where: { id: seeded.itineraryId } }).catch(() => {});
    }
    for (const userId of seeded.userIds) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("✅ Cleanup complete.\n");
  }

  console.log("==================================================");
  console.log("SUMMARY REPORT: AVAILABILITY & INVENTORY TRACKING");
  console.log("==================================================");

  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${icon} [Test ${r.num}] ${r.name}`);
    console.log(`   - HTTP Status: ${r.status} (expected ${r.expectedStatus})`);
    console.log(`   - Details: ${r.details}`);
    if (!r.passed) allPassed = false;
  }

  console.log("\n--------------------------------------------------");
  if (allPassed && results.length === TOTAL_TESTS) {
    console.log(`🎉 ALL ${results.length}/${TOTAL_TESTS} AVAILABILITY TRACKING TESTS PASSED`);
    console.log("--------------------------------------------------\n");
  } else {
    console.error(`🚨 TEST FAILURES DETECTED: Passed ${results.filter((r) => r.passed).length}/${results.length}`);
    console.log("--------------------------------------------------\n");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("Fatal error in test runner:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
