import "dotenv/config";
import http from "node:http";
import { Role, ItineraryStatus } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
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
const TOTAL_TESTS = 9;

async function makeRequest(
  serverUrl: string,
  path: string
): Promise<{ status: number; headers: Headers; data: any; raw: string }> {
  const res = await fetch(`${serverUrl}${path}`);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data, raw: text };
}

async function main() {
  console.log("🌍 Running Public Itineraries API verification suite (no auth) ...\n");

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Temporary test server listening on ${serverUrl}\n`);

  const suffix = Date.now();
  const staffEmail = `public-test-author-${suffix}@test.local`;
  const seededIds: { userId?: string; destinationIds: string[]; itineraryIds: string[] } = {
    destinationIds: [],
    itineraryIds: [],
  };

  try {
    // ── Seed: one staff author, two destinations (one linked to a
    // published itinerary, one only linked to a draft), and one itinerary
    // per status so the filtering behavior is actually exercised.
    const author = await prisma.user.create({
      data: {
        email: staffEmail,
        passwordHash: await hashPassword("Irrelevant123!"),
        role: Role.AUTHOR,
      },
    });
    seededIds.userId = author.id;

    const linkedDestination = await prisma.destination.create({
      data: { name: `Public Test Serengeti ${suffix}`, slug: `public-test-serengeti-${suffix}` },
    });
    const unlinkedDestination = await prisma.destination.create({
      data: { name: `Public Test Unlinked ${suffix}`, slug: `public-test-unlinked-${suffix}` },
    });
    seededIds.destinationIds.push(linkedDestination.id, unlinkedDestination.id);

    async function seedItinerary(status: ItineraryStatus, titleSuffix: string) {
      const itinerary = await prisma.itinerary.create({
        data: {
          title: `Public Test ${titleSuffix} ${suffix}`,
          slug: `public-test-${titleSuffix.toLowerCase()}-${suffix}`,
          status,
          authorId: author.id,
          nights: 5,
          startingPrice: 3200,
          priceOnRequest: false,
          publishedAt: status === ItineraryStatus.PUBLISHED ? new Date() : null,
          days: { create: [{ dayNumber: 1, title: "Arrival", activities: ["Game drive"] }] },
          destinations: { create: [{ destinationId: linkedDestination.id }] },
        },
      });
      seededIds.itineraryIds.push(itinerary.id);
      return itinerary;
    }

    const draft = await seedItinerary(ItineraryStatus.DRAFT, "Draft");
    const inReview = await seedItinerary(ItineraryStatus.IN_REVIEW, "InReview");
    const archived = await seedItinerary(ItineraryStatus.ARCHIVED, "Archived");
    const published = await seedItinerary(ItineraryStatus.PUBLISHED, "Published");

    console.log(
      `👤 Seeded author + 2 destinations + 4 itineraries (DRAFT, IN_REVIEW, ARCHIVED, PUBLISHED)\n`
    );

    // ──────────────────────────────────────────────────────────────
    // TEST 1: GET /public/itineraries returns only the PUBLISHED one
    // ──────────────────────────────────────────────────────────────
    console.log("--- Test 1: List only returns PUBLISHED itineraries ---");
    const res1 = await makeRequest(serverUrl, "/public/itineraries?limit=50");
    const ids: string[] = (res1.data?.data || []).map((i: any) => i.id);
    const pass1 =
      res1.status === 200 &&
      ids.includes(published.id) &&
      !ids.includes(draft.id) &&
      !ids.includes(inReview.id) &&
      !ids.includes(archived.id);

    results.push({
      num: 1,
      name: "GET /public/itineraries includes only PUBLISHED, excludes DRAFT/IN_REVIEW/ARCHIVED",
      passed: pass1,
      status: res1.status,
      expectedStatus: 200,
      details: `Returned ${ids.length} itinerary id(s); published included: ${ids.includes(published.id)}`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED" : `❌ Test 1 FAILED: ${JSON.stringify(res1.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 2 (REGRESSION): no staff email anywhere in the list response
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 2 (REGRESSION): staff email address does not leak into the list response ---");
    const rawList = JSON.stringify(res1.data);
    const pass2 = !rawList.includes(staffEmail) && !rawList.includes("authorId") && !rawList.includes("editorId");

    results.push({
      num: 2,
      name: "REGRESSION: staff email / authorId / editorId absent from public list response",
      passed: pass2,
      status: res1.status,
      expectedStatus: 200,
      details: `Response contains staff email: ${rawList.includes(staffEmail)}, authorId key: ${rawList.includes("authorId")}`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED" : "❌ Test 2 FAILED: PII leaked into public response");

    // ──────────────────────────────────────────────────────────────
    // TEST 3: Cache-Control header present on the list route
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 3: Cache-Control header set on list route ---");
    const cacheControl = res1.headers.get("cache-control") || "";
    const pass3 = cacheControl.includes("max-age");
    results.push({
      num: 3,
      name: "GET /public/itineraries sets a Cache-Control header",
      passed: pass3,
      status: res1.status,
      expectedStatus: 200,
      details: `Cache-Control: "${cacheControl}"`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED" : `❌ Test 3 FAILED: ${cacheControl}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 4: GET /public/itineraries/:slug returns the PUBLISHED detail
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 4: Detail route returns full PUBLISHED itinerary by slug ---");
    const res4 = await makeRequest(serverUrl, `/public/itineraries/${published.slug}`);
    const pass4 =
      res4.status === 200 &&
      res4.data?.itinerary?.id === published.id &&
      Array.isArray(res4.data?.itinerary?.days) &&
      res4.data.itinerary.days.length === 1;

    results.push({
      num: 4,
      name: "GET /public/itineraries/:slug returns the published itinerary with days",
      passed: pass4,
      status: res4.status,
      expectedStatus: 200,
      details: `id matches: ${res4.data?.itinerary?.id === published.id}, days: ${res4.data?.itinerary?.days?.length}`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED" : `❌ Test 4 FAILED: ${JSON.stringify(res4.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 5 (REGRESSION): detail response never carries authorId/editorId/
    // author/editor keys, nor the staff email, at any nesting depth.
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 5 (REGRESSION): detail response has no staff PII at any depth ---");
    const rawDetail = JSON.stringify(res4.data);
    const pass5 =
      !rawDetail.includes(staffEmail) &&
      !rawDetail.includes('"authorId"') &&
      !rawDetail.includes('"editorId"') &&
      !rawDetail.includes('"author"') &&
      !rawDetail.includes('"editor"');

    results.push({
      num: 5,
      name: "REGRESSION: detail response has no author/editor identity fields at any depth",
      passed: pass5,
      status: res4.status,
      expectedStatus: 200,
      details: `Contains staff email: ${rawDetail.includes(staffEmail)}`,
    });
    console.log(pass5 ? "✅ Test 5 PASSED" : "❌ Test 5 FAILED: PII leaked into public detail response");

    // ──────────────────────────────────────────────────────────────
    // TEST 6 (REGRESSION): a DRAFT itinerary's slug 404s on the public route
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 6 (REGRESSION): DRAFT itinerary is not reachable by slug ---");
    const res6 = await makeRequest(serverUrl, `/public/itineraries/${draft.slug}`);
    const pass6 = res6.status === 404 && res6.data?.status === "error";

    results.push({
      num: 6,
      name: "REGRESSION: DRAFT itinerary slug returns 404 on the public API",
      passed: pass6,
      status: res6.status,
      expectedStatus: 404,
      details: `Response: ${JSON.stringify(res6.data)}`,
    });
    console.log(pass6 ? "✅ Test 6 PASSED" : `❌ Test 6 FAILED: DRAFT content is publicly reachable!`);

    // ──────────────────────────────────────────────────────────────
    // TEST 7: a nonexistent slug returns the SAME 404 shape as a
    // non-published slug — no enumeration signal.
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 7: nonexistent slug returns identical 404 shape (no enumeration) ---");
    const res7 = await makeRequest(serverUrl, `/public/itineraries/does-not-exist-${suffix}`);
    const pass7 =
      res7.status === res6.status && JSON.stringify(res7.data) === JSON.stringify(res6.data);

    results.push({
      num: 7,
      name: "Nonexistent slug and non-published slug are indistinguishable (both 404, same body)",
      passed: pass7,
      status: res7.status,
      expectedStatus: 404,
      details: `Bodies match: ${JSON.stringify(res7.data) === JSON.stringify(res6.data)}`,
    });
    console.log(pass7 ? "✅ Test 7 PASSED" : `❌ Test 7 FAILED: ${JSON.stringify(res7.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 8: GET /public/destinations only returns destinations linked to
    // at least one PUBLISHED itinerary.
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 8: destinations list excludes destinations with no published itinerary ---");
    const res8 = await makeRequest(serverUrl, "/public/destinations");
    const destIds: string[] = (res8.data?.data || []).map((d: any) => d.id);
    const pass8 =
      res8.status === 200 &&
      destIds.includes(linkedDestination.id) &&
      !destIds.includes(unlinkedDestination.id);

    results.push({
      num: 8,
      name: "GET /public/destinations includes only destinations with a published itinerary",
      passed: pass8,
      status: res8.status,
      expectedStatus: 200,
      details: `Linked included: ${destIds.includes(linkedDestination.id)}, unlinked excluded: ${!destIds.includes(unlinkedDestination.id)}`,
    });
    console.log(pass8 ? "✅ Test 8 PASSED" : `❌ Test 8 FAILED: ${JSON.stringify(res8.data)}`);

    // ──────────────────────────────────────────────────────────────
    // TEST 9: no Authorization header is required for any of the above
    // (implicit in every request above, but assert explicitly here that
    // an itinerariesRouter-style 401 never appears on /public/*).
    // ──────────────────────────────────────────────────────────────
    console.log("\n--- Test 9: none of the public routes ever demanded authentication ---");
    const allStatuses = [res1.status, res4.status, res6.status, res7.status, res8.status];
    const pass9 = !allStatuses.includes(401);

    results.push({
      num: 9,
      name: "No /public/* route returned 401 across the whole suite",
      passed: pass9,
      status: allStatuses.includes(401) ? 401 : 200,
      expectedStatus: 200,
      details: `Statuses observed: ${allStatuses.join(", ")}`,
    });
    console.log(pass9 ? "✅ Test 9 PASSED" : "❌ Test 9 FAILED: a public route required auth");
  } catch (err: any) {
    console.error("❌ Unexpected test execution error:", err);
  } finally {
    console.log("\n🧹 Cleaning up seeded test data & stopping test server...");
    for (const itineraryId of seededIds.itineraryIds) {
      await prisma.itinerary.delete({ where: { id: itineraryId } }).catch(() => {});
    }
    for (const destinationId of seededIds.destinationIds) {
      await prisma.destination.delete({ where: { id: destinationId } }).catch(() => {});
    }
    if (seededIds.userId) {
      await prisma.user.delete({ where: { id: seededIds.userId } }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("✅ Cleanup complete.\n");
  }

  console.log("==================================================");
  console.log("SUMMARY REPORT: PUBLIC ITINERARIES API TEST SUITE");
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
    console.log(`🎉 ALL ${results.length}/${TOTAL_TESTS} PUBLIC API TESTS PASSED`);
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
