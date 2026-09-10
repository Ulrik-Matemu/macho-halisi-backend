import "dotenv/config";
import http from "node:http";
import { Role } from "@prisma/client";
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
  error?: string;
}

const results: TestCaseResult[] = [];

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
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
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
  console.log("🗺️  Running Destination CRUD Verification Suite...\n");

  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Test server listening on ${serverUrl}\n`);

  let tempAuthorId: string | null = null;
  let tempViewerId: string | null = null;
  const createdDestinationIds: string[] = [];
  const createdItineraryIds: string[] = [];

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 0. Setup Roles & Tokens
    // ──────────────────────────────────────────────────────────────────────────
    const author = await prisma.user.create({
      data: {
        email: `dest-author-${Date.now()}@test.local`,
        passwordHash: await hashPassword("AuthorPass123!"),
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    tempAuthorId = author.id;
    const authorToken = signAccessToken({ userId: author.id, role: Role.AUTHOR });

    const viewer = await prisma.user.create({
      data: {
        email: `dest-viewer-${Date.now()}@test.local`,
        passwordHash: await hashPassword("ViewerPass123!"),
        role: Role.VIEWER,
        mfaEnabled: false,
      },
    });
    tempViewerId = viewer.id;
    const viewerToken = signAccessToken({ userId: viewer.id, role: Role.VIEWER });

    console.log(`✅ Test users created: Author (${author.id}), Viewer (${viewer.id})\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: AUTHOR creates a destination via POST /destinations
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 1: AUTHOR creates destination ---");
    const destName = `Tarangire National Park ${Date.now()}`;
    const createRes = await makeRequest(
      serverUrl,
      "/destinations",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      { name: destName }
    );

    const createdDest = createRes.data?.destination;
    if (createdDest?.id) {
      createdDestinationIds.push(createdDest.id);
    }

    const pass1 =
      createRes.status === 201 &&
      createRes.data?.status === "ok" &&
      createdDest?.name === destName &&
      typeof createdDest?.slug === "string" &&
      createdDest.slug.startsWith("tarangire-national-park");

    results.push({
      num: 1,
      name: "AUTHOR can create a destination with auto-generated slug",
      passed: pass1,
      status: createRes.status,
      expectedStatus: 201,
      details: `Destination ID: ${createdDest?.id}, Name: "${createdDest?.name}", Slug: "${createdDest?.slug}"`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED\n" : `❌ Test 1 FAILED: ${JSON.stringify(createRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: VIEWER attempting POST /destinations is rejected with 403
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 2: VIEWER write attempt rejected with 403 ---");
    const viewerCreateRes = await makeRequest(
      serverUrl,
      "/destinations",
      "POST",
      { Authorization: `Bearer ${viewerToken}` },
      { name: "Forbidden Destination" }
    );

    const pass2 = viewerCreateRes.status === 403 && viewerCreateRes.data?.status === "error";
    results.push({
      num: 2,
      name: "VIEWER attempting to create a destination is rejected with 403 Forbidden",
      passed: pass2,
      status: viewerCreateRes.status,
      expectedStatus: 403,
      details: `Message: "${viewerCreateRes.data?.message}"`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED\n" : `❌ Test 2 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: GET /destinations returns created destinations
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 3: GET /destinations returns list including newly created destination ---");
    const listRes = await makeRequest(
      serverUrl,
      "/destinations",
      "GET",
      { Authorization: `Bearer ${viewerToken}` }
    );

    const destList: any[] = listRes.data?.data || [];
    const foundDest = destList.find((d) => d.id === createdDest?.id);

    const pass3 =
      listRes.status === 200 &&
      listRes.data?.status === "ok" &&
      Array.isArray(destList) &&
      Boolean(foundDest) &&
      foundDest?.name === destName;

    results.push({
      num: 3,
      name: "GET /destinations returns destinations list containing created record",
      passed: pass3,
      status: listRes.status,
      expectedStatus: 200,
      details: `Total destinations returned: ${destList.length}, Found created: ${Boolean(foundDest)}`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED\n" : `❌ Test 3 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: Duplicate destination name returns 409 Conflict
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 4: Duplicate destination name rejected with 409 Conflict ---");
    const dupRes = await makeRequest(
      serverUrl,
      "/destinations",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      { name: destName.toLowerCase() } // test case-insensitive duplicate check
    );

    const pass4 = dupRes.status === 409 && dupRes.data?.status === "error";
    results.push({
      num: 4,
      name: "Duplicate destination name rejected with 409 Conflict (case-insensitive)",
      passed: pass4,
      status: dupRes.status,
      expectedStatus: 409,
      details: `Message: "${dupRes.data?.message}"`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED\n" : `❌ Test 4 FAILED: ${JSON.stringify(dupRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 5: Link created destination to an itinerary via POST /itineraries
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 5: Linking created destination to an itinerary ---");
    const itinRes = await makeRequest(
      serverUrl,
      "/itineraries",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      {
        title: `Tarangire Safari Express ${Date.now()}`,
        nights: 2,
        startingPrice: 1200,
        priceOnRequest: false,
        destinationIds: [createdDest.id],
      }
    );

    const itin = itinRes.data?.itinerary;
    if (itin?.id) {
      createdItineraryIds.push(itin.id);
    }

    const linkedDest = itin?.destinations?.find((d: any) => d.destination?.id === createdDest.id);

    const pass5 =
      itinRes.status === 201 &&
      Boolean(linkedDest) &&
      linkedDest?.destination?.name === destName;

    results.push({
      num: 5,
      name: "Created destination can be linked to Itinerary via POST /itineraries",
      passed: pass5,
      status: itinRes.status,
      expectedStatus: 201,
      details: `Itinerary ID: ${itin?.id}, Linked Destination: "${linkedDest?.destination?.name}"`,
    });
    console.log(pass5 ? "✅ Test 5 PASSED\n" : `❌ Test 5 FAILED: ${JSON.stringify(itinRes.data)}\n`);

  } catch (err: any) {
    console.error("❌ Unexpected test error:", err);
  } finally {
    console.log("🧹 Cleaning up test data...");

    // 1. Delete test itineraries
    for (const id of createdItineraryIds) {
      await prisma.itinerary.delete({ where: { id } }).catch(() => {});
    }

    // 2. Delete test destinations
    for (const id of createdDestinationIds) {
      await prisma.destination.delete({ where: { id } }).catch(() => {});
    }

    // 3. Delete temporary users
    if (tempAuthorId) {
      await prisma.user.delete({ where: { id: tempAuthorId } }).catch(() => {});
    }
    if (tempViewerId) {
      await prisma.user.delete({ where: { id: tempViewerId } }).catch(() => {});
    }

    console.log("✅ Teardown complete.\n");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("🛑 Test server closed.\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary Report
  // ──────────────────────────────────────────────────────────────────────────
  console.log("==================================================");
  console.log("SUMMARY REPORT: DESTINATIONS CRUD SUITE");
  console.log("==================================================");

  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${icon} [Test ${r.num}] ${r.name}`);
    console.log(`   - HTTP Status: ${r.status} (expected ${r.expectedStatus})`);
    console.log(`   - Details: ${r.details}`);
    if (r.error) {
      console.log(`   - Error: ${r.error}`);
    }
    if (!r.passed) {
      allPassed = false;
    }
  }

  console.log("\n--------------------------------------------------");
  if (allPassed && results.length === 5) {
    console.log(`🎉 ALL ${results.length}/5 DESTINATION TESTS PASSED`);
    console.log("--------------------------------------------------\n");
  } else {
    console.error(`🚨 FAILURES DETECTED: Passed ${results.filter((r) => r.passed).length}/${results.length}`);
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
