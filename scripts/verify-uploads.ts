import "dotenv/config";
import http from "node:http";
import { Role, ItineraryStatus } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { signAccessToken } from "../src/lib/tokens.js";
import { hashPassword } from "../src/lib/password.js";
import { cloudinary } from "../src/lib/cloudinary.js";

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

// Helper: 1x1 transparent PNG buffer
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

async function main() {
  console.log("☁️  Running Cloudinary Upload & Asset Management Verification Suite...\n");

  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Test server listening on ${serverUrl}\n`);

  let tempAuthorId: string | null = null;
  let tempViewerId: string | null = null;
  let tempItineraryId: string | null = null;
  let uploadedPublicId: string | null = null;

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 0. Setup Roles & Tokens
    // ──────────────────────────────────────────────────────────────────────────
    const author = await prisma.user.create({
      data: {
        email: `upload-author-${Date.now()}@test.local`,
        passwordHash: await hashPassword("AuthorPass123!"),
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    tempAuthorId = author.id;
    const authorToken = signAccessToken({ userId: author.id, role: Role.AUTHOR });

    const viewer = await prisma.user.create({
      data: {
        email: `upload-viewer-${Date.now()}@test.local`,
        passwordHash: await hashPassword("ViewerPass123!"),
        role: Role.VIEWER,
        mfaEnabled: false,
      },
    });
    tempViewerId = viewer.id;
    const viewerToken = signAccessToken({ userId: viewer.id, role: Role.VIEWER });

    console.log(`✅ Test users created: Author (${author.id}), Viewer (${viewer.id})\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: POST /uploads/image with real PNG buffer -> 201 Created & URL works
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 1: Upload real PNG image to Cloudinary ---");
    const formData = new FormData();
    formData.append("image", new Blob([TINY_PNG_BUFFER], { type: "image/png" }), "test-image.png");

    const uploadRes = await fetch(`${serverUrl}/uploads/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorToken}`,
      },
      body: formData,
    });

    const uploadData: any = await uploadRes.json();
    uploadedPublicId = uploadData?.publicId || null;

    // Verify Cloudinary asset is reachable
    let assetReachable = false;
    if (uploadData?.url) {
      const ping = await fetch(uploadData.url);
      assetReachable = ping.status === 200;
    }

    const pass1 =
      uploadRes.status === 201 &&
      uploadData?.status === "ok" &&
      typeof uploadData?.url === "string" &&
      uploadData.url.startsWith("https://res.cloudinary.com/") &&
      typeof uploadData?.publicId === "string" &&
      uploadData.publicId.startsWith("macho-halisi/itineraries/") &&
      assetReachable;

    results.push({
      num: 1,
      name: "POST /uploads/image uploads real image to Cloudinary and returns reachable URL",
      passed: pass1,
      status: uploadRes.status,
      expectedStatus: 201,
      details: `URL: ${uploadData?.url}, Public ID: ${uploadData?.publicId}, Reachable HTTP: ${assetReachable ? 200 : "Failed"}`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED\n" : `❌ Test 1 FAILED: ${JSON.stringify(uploadData)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: Upload non-image file (.txt) -> 400 Bad Request
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 2: Upload non-image file rejected with 400 ---");
    const txtFormData = new FormData();
    txtFormData.append("image", new Blob(["Hello world text"], { type: "text/plain" }), "test.txt");

    const txtRes = await fetch(`${serverUrl}/uploads/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorToken}`,
      },
      body: txtFormData,
    });
    const txtData: any = await txtRes.json();

    const pass2 = txtRes.status === 400 && txtData?.status === "error";
    results.push({
      num: 2,
      name: "Non-image file (text/plain) rejected with 400 Bad Request",
      passed: pass2,
      status: txtRes.status,
      expectedStatus: 400,
      details: `Message: "${txtData?.message}"`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED\n" : `❌ Test 2 FAILED: ${JSON.stringify(txtData)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: VIEWER role cannot upload -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 3: VIEWER role upload attempt rejected with 403 ---");
    const viewerFormData = new FormData();
    viewerFormData.append("image", new Blob([TINY_PNG_BUFFER], { type: "image/png" }), "viewer-test.png");

    const viewerRes = await fetch(`${serverUrl}/uploads/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${viewerToken}`,
      },
      body: viewerFormData,
    });
    const viewerData: any = await viewerRes.json();

    const pass3 = viewerRes.status === 403 && viewerData?.status === "error";
    results.push({
      num: 3,
      name: "VIEWER role upload attempt rejected with 403 Forbidden",
      passed: pass3,
      status: viewerRes.status,
      expectedStatus: 403,
      details: `Message: "${viewerData?.message}"`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED\n" : `❌ Test 3 FAILED: ${JSON.stringify(viewerData)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: Full flow: Attach uploaded image to itinerary, then delete and verify Cloudinary deletion
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 4: End-to-end attach and delete with Cloudinary asset destruction ---");

    // 1. Create temporary itinerary
    const itin = await prisma.itinerary.create({
      data: {
        title: `Upload Test Itinerary ${Date.now()}`,
        slug: `upload-test-${Date.now()}`,
        status: ItineraryStatus.DRAFT,
        authorId: author.id,
        priceOnRequest: true,
      },
    });
    tempItineraryId = itin.id;

    // 2. Attach uploaded image with cloudinaryPublicId
    const attachRes = await fetch(`${serverUrl}/itineraries/${itin.id}/images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authorToken}`,
      },
      body: JSON.stringify({
        url: uploadData.url,
        cloudinaryPublicId: uploadData.publicId,
        sortOrder: 0,
        altText: "Serengeti luxury tented camp",
      }),
    });
    const attachData: any = await attachRes.json();
    const imageRecordId = attachData?.image?.id;

    const passAttach =
      attachRes.status === 201 &&
      attachData?.image?.cloudinaryPublicId === uploadData.publicId;

    console.log(`   Attached Image ID: ${imageRecordId}, PublicId in DB: ${attachData?.image?.cloudinaryPublicId}`);

    // 3. Delete image via DELETE /itineraries/:id/images/:imageId
    const deleteRes = await fetch(`${serverUrl}/itineraries/${itin.id}/images/${imageRecordId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authorToken}`,
      },
    });
    const deleteData: any = await deleteRes.json();

    // 4. Verify DB row deleted
    const dbImageAfter = await prisma.itineraryImage.findUnique({ where: { id: imageRecordId } });

    // 5. Verify asset is destroyed in Cloudinary
    let assetDestroyed = false;
    try {
      await cloudinary.api.resource(uploadData.publicId);
      assetDestroyed = false; // If resource was found, it was NOT destroyed
    } catch (err: any) {
      // Cloudinary throws 404 / Not Found when resource does not exist
      if (err?.error?.http_code === 404 || err?.http_code === 404) {
        assetDestroyed = true;
      }
    }

    const pass4 =
      passAttach &&
      deleteRes.status === 200 &&
      dbImageAfter === null &&
      assetDestroyed;

    results.push({
      num: 4,
      name: "Attaching image saves cloudinaryPublicId; deleting image destroys asset in Cloudinary",
      passed: pass4,
      status: deleteRes.status,
      expectedStatus: 200,
      details: `Attach OK: ${passAttach}, DB row removed: ${dbImageAfter === null}, Cloudinary asset destroyed (404 confirmed): ${assetDestroyed}`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED\n" : `❌ Test 4 FAILED: DB row: ${dbImageAfter}, Cloudinary destroyed: ${assetDestroyed}\n`);

  } catch (err: any) {
    console.error("❌ Unexpected error during test execution:", err);
  } finally {
    console.log("🧹 Cleaning up test data...");

    // Clean up temporary itinerary
    if (tempItineraryId) {
      await prisma.itinerary.delete({ where: { id: tempItineraryId } }).catch(() => {});
    }

    // Clean up temporary users
    if (tempAuthorId) {
      await prisma.user.delete({ where: { id: tempAuthorId } }).catch(() => {});
    }
    if (tempViewerId) {
      await prisma.user.delete({ where: { id: tempViewerId } }).catch(() => {});
    }

    // Double check Cloudinary cleanup if publicId still exists
    if (uploadedPublicId) {
      try {
        await cloudinary.uploader.destroy(uploadedPublicId);
      } catch {}
    }

    console.log("✅ Teardown complete.\n");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("🛑 Test server closed.\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary Report
  // ──────────────────────────────────────────────────────────────────────────
  console.log("==================================================");
  console.log("SUMMARY REPORT: CLOUDINARY UPLOAD & ASSET MANAGEMENT");
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
  if (allPassed && results.length === 4) {
    console.log(`🎉 ALL ${results.length}/4 CLOUDINARY UPLOAD TESTS PASSED`);
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
