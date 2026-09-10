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
  console.log("🦁 Running Itineraries CRUD & Workflow Verification Suite...\n");

  const app = createApp();
  const server = http.createServer(app);

  // Bind to dynamic port to avoid collisions
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Test server listening on ${serverUrl}\n`);

  // Track created entities for cleanup
  const createdItineraryIds: string[] = [];
  let tempAuthorId: string | null = null;
  let tempViewerId: string | null = null;
  let tempDestinationId: string | null = null;

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // Setup Test Users & Destination
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 0. Setup Test Roles & Destination ---");

    // 1. Get or create Admin user
    let admin = await prisma.user.findUnique({ where: { email: "admin@machohalisi.com" } });
    if (!admin) {
      admin = await prisma.user.create({
        data: {
          email: "admin@machohalisi.com",
          passwordHash: await hashPassword("AdminPassword123!"),
          role: Role.ADMIN,
          mfaEnabled: false,
        },
      });
    }
    const adminToken = signAccessToken({ userId: admin.id, role: Role.ADMIN });

    // 2. Get or create Editor user
    let editor = await prisma.user.findUnique({ where: { email: "editor@machohalisi.com" } });
    if (!editor) {
      editor = await prisma.user.create({
        data: {
          email: "editor@machohalisi.com",
          passwordHash: await hashPassword("EditorPassword123!"),
          role: Role.EDITOR,
          mfaEnabled: false,
        },
      });
    }
    const editorToken = signAccessToken({ userId: editor.id, role: Role.EDITOR });

    // 3. Create temporary Author
    const author = await prisma.user.create({
      data: {
        email: `test-author-${Date.now()}@test.local`,
        passwordHash: await hashPassword("AuthorPassword123!"),
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    tempAuthorId = author.id;
    const authorToken = signAccessToken({ userId: author.id, role: Role.AUTHOR });

    // 4. Create temporary Viewer
    const viewer = await prisma.user.create({
      data: {
        email: `test-viewer-${Date.now()}@test.local`,
        passwordHash: await hashPassword("ViewerPassword123!"),
        role: Role.VIEWER,
        mfaEnabled: false,
      },
    });
    tempViewerId = viewer.id;
    const viewerToken = signAccessToken({ userId: viewer.id, role: Role.VIEWER });

    // 5. Create test Destination
    const destination = await prisma.destination.create({
      data: {
        name: "Serengeti National Park",
        slug: `serengeti-${Date.now()}`,
      },
    });
    tempDestinationId = destination.id;

    console.log(`✅ Roles ready: Admin (${admin.id}), Editor (${editor.id}), Author (${author.id}), Viewer (${viewer.id})`);
    console.log(`✅ Destination ready: ${destination.name} (${destination.id})\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: AUTHOR creates DRAFT itinerary with days and destination
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 1: AUTHOR creates DRAFT itinerary ---");
    const createRes = await makeRequest(
      serverUrl,
      "/itineraries",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      {
        title: "Northern Safari Circuit",
        overview: "An incredible 5-day safari across Tanzania.",
        nights: 4,
        startingPrice: 2800,
        priceOnRequest: false,
        inclusions: ["Park fees", "Meals", "Transport"],
        exclusions: ["International flights", "Tips"],
        destinationIds: [destination.id],
        days: [
          {
            dayNumber: 2,
            title: "Serengeti Game Drive",
            description: "Full day game drive in central Serengeti.",
            accommodation: "Serengeti Safari Lodge",
            activities: ["Morning game drive", "Sunset bush dinner"],
          },
          {
            dayNumber: 1,
            title: "Arrival in Arusha",
            description: "Arrive at JRO airport and transfer to hotel.",
            accommodation: "Arusha Planet Lodge",
            activities: ["Airport transfer", "Trip briefing"],
          },
        ],
      }
    );

    const createdItinerary = createRes.data?.itinerary;
    if (createdItinerary?.id) {
      createdItineraryIds.push(createdItinerary.id);
    }

    const pass1 =
      createRes.status === 201 &&
      createdItinerary?.status === ItineraryStatus.DRAFT &&
      createdItinerary?.author?.id === author.id &&
      createdItinerary?.days?.length === 2 &&
      createdItinerary?.destinations?.length === 1 &&
      createdItinerary?.destinations[0]?.destination?.id === destination.id;

    results.push({
      num: 1,
      name: "AUTHOR can create DRAFT itinerary with days and destinations",
      passed: pass1,
      status: createRes.status,
      expectedStatus: 201,
      details: `Status: "${createdItinerary?.status}", Author: ${createdItinerary?.author?.email}, Days count: ${createdItinerary?.days?.length}`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED\n" : `❌ Test 1 FAILED: ${JSON.stringify(createRes.data)}\n`);

    const itineraryId = createdItinerary?.id;

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: No ownership restriction: EDITOR edits AUTHOR's itinerary
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 2: EDITOR edits AUTHOR's itinerary (no ownership restriction) ---");
    const editRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}`,
      "PUT",
      { Authorization: `Bearer ${editorToken}` },
      {
        title: "Northern Safari Circuit (Editor Revised)",
        nights: 5,
        days: [
          {
            dayNumber: 1,
            title: "Arusha Welcome",
            description: "Updated description by editor.",
            accommodation: "Gran Melia Arusha",
            activities: ["Welcome cocktail"],
          },
          {
            dayNumber: 2,
            title: "Tarangire National Park",
            description: "Elephant viewing.",
            accommodation: "Tarangire Safari Lodge",
            activities: ["Game drive"],
          },
          {
            dayNumber: 3,
            title: "Serengeti Plains",
            description: "Central Serengeti transit.",
            accommodation: "Serengeti Serena",
            activities: ["Afternoon game drive"],
          },
        ],
      }
    );

    const updatedItinerary = editRes.data?.itinerary;
    const pass2 =
      editRes.status === 200 &&
      updatedItinerary?.title === "Northern Safari Circuit (Editor Revised)" &&
      updatedItinerary?.editor?.id === editor.id &&
      updatedItinerary?.author?.id === author.id &&
      updatedItinerary?.days?.length === 3 &&
      updatedItinerary?.nights === 5;

    results.push({
      num: 2,
      name: "EDITOR edits AUTHOR's itinerary successfully (no ownership restriction)",
      passed: pass2,
      status: editRes.status,
      expectedStatus: 200,
      details: `Editor: ${updatedItinerary?.editor?.email}, Author: ${updatedItinerary?.author?.email}, New days count: ${updatedItinerary?.days?.length}`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED\n" : `❌ Test 2 FAILED: ${JSON.stringify(editRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: AUTHOR attempting PATCH /itineraries/:id/publish -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 3: AUTHOR attempting to publish is REJECTED (403) ---");
    const authorPublishRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}/publish`,
      "PATCH",
      { Authorization: `Bearer ${authorToken}` }
    );

    const pass3 = authorPublishRes.status === 403;
    results.push({
      num: 3,
      name: "AUTHOR attempting PATCH /publish is rejected with 403",
      passed: pass3,
      status: authorPublishRes.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(authorPublishRes.data)}`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED\n" : `❌ Test 3 FAILED: ${JSON.stringify(authorPublishRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: EDITOR attempting PATCH /itineraries/:id/publish -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 4: EDITOR attempting to publish is REJECTED (403) ---");
    const editorPublishRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}/publish`,
      "PATCH",
      { Authorization: `Bearer ${editorToken}` }
    );

    const pass4 = editorPublishRes.status === 403;
    results.push({
      num: 4,
      name: "EDITOR attempting PATCH /publish is rejected with 403",
      passed: pass4,
      status: editorPublishRes.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(editorPublishRes.data)}`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED\n" : `❌ Test 4 FAILED: ${JSON.stringify(editorPublishRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 5: ADMIN calls PATCH /itineraries/:id/publish -> 200 OK & publishedAt set
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 5: ADMIN calls PATCH /publish -> SUCCEEDS & sets publishedAt ---");
    const adminPublishRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}/publish`,
      "PATCH",
      { Authorization: `Bearer ${adminToken}` }
    );

    const publishedItinerary = adminPublishRes.data?.itinerary;
    const pass5 =
      adminPublishRes.status === 200 &&
      publishedItinerary?.status === ItineraryStatus.PUBLISHED &&
      publishedItinerary?.publishedAt !== null &&
      typeof publishedItinerary?.publishedAt === "string";

    results.push({
      num: 5,
      name: "ADMIN calls PATCH /publish successfully and sets publishedAt",
      passed: pass5,
      status: adminPublishRes.status,
      expectedStatus: 200,
      details: `Status: "${publishedItinerary?.status}", publishedAt: "${publishedItinerary?.publishedAt}"`,
    });
    console.log(pass5 ? "✅ Test 5 PASSED\n" : `❌ Test 5 FAILED: ${JSON.stringify(adminPublishRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 6: Gallery images: POST & DELETE image
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 6: Gallery image attach and remove ---");
    const addImageRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}/images`,
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      {
        url: "https://example.com/serengeti-sunset.jpg",
        sortOrder: 1,
        altText: "Serengeti sunset over acacia tree",
      }
    );

    const createdImage = addImageRes.data?.image;
    const imageId = createdImage?.id;

    const deleteImageRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}/images/${imageId}`,
      "DELETE",
      { Authorization: `Bearer ${editorToken}` }
    );

    const pass6 =
      addImageRes.status === 201 &&
      createdImage?.url === "https://example.com/serengeti-sunset.jpg" &&
      deleteImageRes.status === 200;

    results.push({
      num: 6,
      name: "Gallery image attach (POST) and remove (DELETE) succeed",
      passed: pass6,
      status: deleteImageRes.status,
      expectedStatus: 200,
      details: `Added Image ID: ${imageId}, Delete response: "${deleteImageRes.data?.message}"`,
    });
    console.log(pass6 ? "✅ Test 6 PASSED\n" : `❌ Test 6 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 7: Ordering invariant: GET /itineraries/:id orders days & images
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 7: GET /itineraries/:id verifies ordering of days & images ---");
    // Add two images out of order
    await makeRequest(serverUrl, `/itineraries/${itineraryId}/images`, "POST", { Authorization: `Bearer ${adminToken}` }, {
      url: "https://example.com/img-2.jpg",
      sortOrder: 2,
      altText: "Image 2",
    });
    await makeRequest(serverUrl, `/itineraries/${itineraryId}/images`, "POST", { Authorization: `Bearer ${adminToken}` }, {
      url: "https://example.com/img-1.jpg",
      sortOrder: 0,
      altText: "Image 1",
    });

    const getDetailRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}`,
      "GET",
      { Authorization: `Bearer ${viewerToken}` }
    );

    const detail = getDetailRes.data?.itinerary;
    const daysAsc =
      detail?.days?.length === 3 &&
      detail.days[0].dayNumber === 1 &&
      detail.days[1].dayNumber === 2 &&
      detail.days[2].dayNumber === 3;

    const imagesAsc =
      detail?.images?.length === 2 &&
      detail.images[0].sortOrder === 0 &&
      detail.images[1].sortOrder === 2;

    const pass7 = getDetailRes.status === 200 && daysAsc && imagesAsc;
    results.push({
      num: 7,
      name: "GET /itineraries/:id returns days sorted by dayNumber ASC and images by sortOrder ASC",
      passed: pass7,
      status: getDetailRes.status,
      expectedStatus: 200,
      details: `Days ordering: [${detail?.days?.map((d: any) => d.dayNumber).join(", ")}], Images sortOrder: [${detail?.images?.map((i: any) => i.sortOrder).join(", ")}]`,
    });
    console.log(pass7 ? "✅ Test 7 PASSED\n" : `❌ Test 7 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 8: Unique Slug auto-generation on duplicate title
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 8: Duplicate title auto-generates unique slug with suffix ---");
    const dupTitle = "Unique Wildlife Safari";

    const resSlug1 = await makeRequest(
      serverUrl,
      "/itineraries",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      {
        title: dupTitle,
        nights: 3,
        startingPrice: 1500,
        priceOnRequest: false,
      }
    );
    if (resSlug1.data?.itinerary?.id) {
      createdItineraryIds.push(resSlug1.data.itinerary.id);
    }

    const resSlug2 = await makeRequest(
      serverUrl,
      "/itineraries",
      "POST",
      { Authorization: `Bearer ${authorToken}` },
      {
        title: dupTitle,
        nights: 3,
        startingPrice: 1500,
        priceOnRequest: false,
      }
    );
    if (resSlug2.data?.itinerary?.id) {
      createdItineraryIds.push(resSlug2.data.itinerary.id);
    }

    const slug1 = resSlug1.data?.itinerary?.slug;
    const slug2 = resSlug2.data?.itinerary?.slug;

    const pass8 =
      resSlug1.status === 201 &&
      resSlug2.status === 201 &&
      slug1 === "unique-wildlife-safari" &&
      slug2 === "unique-wildlife-safari-1";

    results.push({
      num: 8,
      name: "Creating itinerary with duplicate title auto-generates unique slug with suffix",
      passed: pass8,
      status: resSlug2.status,
      expectedStatus: 201,
      details: `Slug 1: "${slug1}", Slug 2: "${slug2}"`,
    });
    console.log(pass8 ? "✅ Test 8 PASSED\n" : `❌ Test 8 FAILED: slug1=${slug1}, slug2=${slug2}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 9: VIEWER role cannot write: POST /itineraries -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 9: VIEWER write attempt is REJECTED (403) ---");
    const viewerCreateRes = await makeRequest(
      serverUrl,
      "/itineraries",
      "POST",
      { Authorization: `Bearer ${viewerToken}` },
      {
        title: "Viewer Safari",
        startingPrice: 1000,
        priceOnRequest: false,
      }
    );

    const pass9 = viewerCreateRes.status === 403;
    results.push({
      num: 9,
      name: "VIEWER attempting POST /itineraries is rejected with 403 Forbidden",
      passed: pass9,
      status: viewerCreateRes.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(viewerCreateRes.data)}`,
    });
    console.log(pass9 ? "✅ Test 9 PASSED\n" : `❌ Test 9 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 10: AUTHOR attempting DELETE /itineraries/:id -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 10: AUTHOR attempting DELETE is REJECTED (403) ---");
    const authorDeleteRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}`,
      "DELETE",
      { Authorization: `Bearer ${authorToken}` }
    );

    const pass10 = authorDeleteRes.status === 403;
    results.push({
      num: 10,
      name: "AUTHOR attempting DELETE /itineraries/:id is rejected with 403 Forbidden",
      passed: pass10,
      status: authorDeleteRes.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(authorDeleteRes.data)}`,
    });
    console.log(pass10 ? "✅ Test 10 PASSED\n" : `❌ Test 10 FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 11: ADMIN calls DELETE /itineraries/:id -> SUCCEEDS & cascades
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 11: ADMIN calls DELETE -> SUCCEEDS and cascades child records ---");
    // Verify children exist before delete
    const daysBefore = await prisma.itineraryDay.count({ where: { itineraryId } });
    const imagesBefore = await prisma.itineraryImage.count({ where: { itineraryId } });
    const destBefore = await prisma.itineraryDestination.count({ where: { itineraryId } });

    const adminDeleteRes = await makeRequest(
      serverUrl,
      `/itineraries/${itineraryId}`,
      "DELETE",
      { Authorization: `Bearer ${adminToken}` }
    );

    // Verify children count after delete
    const daysAfter = await prisma.itineraryDay.count({ where: { itineraryId } });
    const imagesAfter = await prisma.itineraryImage.count({ where: { itineraryId } });
    const destAfter = await prisma.itineraryDestination.count({ where: { itineraryId } });
    const itineraryInDb = await prisma.itinerary.findUnique({ where: { id: itineraryId } });

    const pass11 =
      adminDeleteRes.status === 200 &&
      itineraryInDb === null &&
      daysBefore > 0 &&
      daysAfter === 0 &&
      imagesBefore > 0 &&
      imagesAfter === 0 &&
      destBefore > 0 &&
      destAfter === 0;

    results.push({
      num: 11,
      name: "ADMIN calling DELETE /itineraries/:id succeeds and cascades child records",
      passed: pass11,
      status: adminDeleteRes.status,
      expectedStatus: 200,
      details: `Itinerary deleted: ${itineraryInDb === null}. Days cascade: ${daysBefore} -> ${daysAfter}, Images cascade: ${imagesBefore} -> ${imagesAfter}, Destinations cascade: ${destBefore} -> ${destAfter}`,
    });
    console.log(pass11 ? "✅ Test 11 PASSED\n" : `❌ Test 11 FAILED\n`);

    // Remove from tracking since already deleted
    const idx = createdItineraryIds.indexOf(itineraryId);
    if (idx !== -1) {
      createdItineraryIds.splice(idx, 1);
    }
  } catch (err: any) {
    console.error("❌ Unexpected test execution error:", err);
  } finally {
    console.log("🧹 Cleaning up test data...");
    // 1. Delete any remaining test itineraries
    for (const id of createdItineraryIds) {
      await prisma.itinerary.delete({ where: { id } }).catch(() => {});
    }

    // 2. Delete test destination
    if (tempDestinationId) {
      await prisma.destination.delete({ where: { id: tempDestinationId } }).catch(() => {});
    }

    // 3. Delete temporary author and viewer accounts
    if (tempAuthorId) {
      await prisma.user.delete({ where: { id: tempAuthorId } }).catch(() => {});
    }
    if (tempViewerId) {
      await prisma.user.delete({ where: { id: tempViewerId } }).catch(() => {});
    }

    console.log("✅ Teardown complete — test itineraries and temporary test users removed.\n");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("🛑 Test server closed.\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary Report
  // ──────────────────────────────────────────────────────────────────────────
  console.log("==================================================");
  console.log("SUMMARY REPORT: ITINERARIES CRUD & WORKFLOW SUITE");
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
  if (allPassed && results.length === 11) {
    console.log(`🎉 ALL ${results.length}/11 ITINERARY TESTS PASSED`);
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
