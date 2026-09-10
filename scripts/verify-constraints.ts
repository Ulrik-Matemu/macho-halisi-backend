import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

interface TestResult {
  name: string;
  passed: boolean;
  details: string[];
  error?: string;
}

const results: TestResult[] = [];

async function runTestA(): Promise<void> {
  const details: string[] = [];
  console.log("\n==================================================");
  console.log("TEST A: Cascade Deletes & SetNull on Itinerary");
  console.log("==================================================");

  let userId: string | null = null;
  let destinationId: string | null = null;
  let itineraryId: string | null = null;
  let enquiryId: string | null = null;

  try {
    // 1. Setup entities
    const user = await prisma.user.create({
      data: {
        email: `test-cascade-${Date.now()}@test.local`,
        passwordHash: "dummy-hash",
        role: "AUTHOR",
      },
    });
    userId = user.id;

    const destination = await prisma.destination.create({
      data: {
        name: `Test Destination ${Date.now()}`,
        slug: `test-destination-${Date.now()}`,
      },
    });
    destinationId = destination.id;

    const itinerary = await prisma.itinerary.create({
      data: {
        title: "Cascade Test Safari",
        slug: `cascade-test-safari-${Date.now()}`,
        authorId: user.id,
        priceOnRequest: true,
      },
    });
    itineraryId = itinerary.id;

    // 2. Attach children: 2 days, 1 image, 1 destination join
    await prisma.itineraryDay.createMany({
      data: [
        { itineraryId: itinerary.id, dayNumber: 1, title: "Day 1 Arrival" },
        { itineraryId: itinerary.id, dayNumber: 2, title: "Day 2 Safari" },
      ],
    });

    await prisma.itineraryImage.create({
      data: {
        itineraryId: itinerary.id,
        url: "https://example.com/test.jpg",
        sortOrder: 0,
      },
    });

    await prisma.itineraryDestination.create({
      data: {
        itineraryId: itinerary.id,
        destinationId: destination.id,
      },
    });

    // 3. Attach enquiry pointing to itinerary
    const enquiry = await prisma.enquiry.create({
      data: {
        name: "Safari Inquirer",
        email: "inquirer@test.local",
        phone: "+255700000000",
        itineraryId: itinerary.id,
        message: "Interested in this safari package.",
      },
    });
    enquiryId = enquiry.id;

    // 4. Query counts BEFORE deletion
    const daysBefore = await prisma.itineraryDay.count({ where: { itineraryId: itinerary.id } });
    const imagesBefore = await prisma.itineraryImage.count({ where: { itineraryId: itinerary.id } });
    const destinationsBefore = await prisma.itineraryDestination.count({ where: { itineraryId: itinerary.id } });
    const enquiryBefore = await prisma.enquiry.findUnique({ where: { id: enquiry.id } });

    console.log("\nCounts BEFORE deleting Itinerary:");
    console.log(`  ItineraryDay:         ${daysBefore} (expected: 2)`);
    console.log(`  ItineraryImage:       ${imagesBefore} (expected: 1)`);
    console.log(`  ItineraryDestination: ${destinationsBefore} (expected: 1)`);
    console.log(`  Enquiry.itineraryId:  ${enquiryBefore?.itineraryId} (expected: ${itinerary.id})`);

    const beforeValid =
      daysBefore === 2 &&
      imagesBefore === 1 &&
      destinationsBefore === 1 &&
      enquiryBefore?.itineraryId === itinerary.id;

    if (!beforeValid) {
      throw new Error(
        `Pre-condition failed: expected counts (2, 1, 1, ${itinerary.id}), got (${daysBefore}, ${imagesBefore}, ${destinationsBefore}, ${enquiryBefore?.itineraryId})`
      );
    }

    // 5. Delete Itinerary directly
    console.log(`\nDeleting Itinerary ${itinerary.id}...`);
    await prisma.itinerary.delete({ where: { id: itinerary.id } });
    itineraryId = null; // marked as deleted

    // 6. Query counts AFTER deletion
    const daysAfter = await prisma.itineraryDay.count({ where: { itineraryId: itinerary.id } });
    const imagesAfter = await prisma.itineraryImage.count({ where: { itineraryId: itinerary.id } });
    const destinationsAfter = await prisma.itineraryDestination.count({ where: { itineraryId: itinerary.id } });
    const enquiryAfter = await prisma.enquiry.findUnique({ where: { id: enquiry.id } });

    console.log("\nCounts AFTER deleting Itinerary:");
    console.log(`  ItineraryDay:         ${daysAfter} (expected: 0)`);
    console.log(`  ItineraryImage:       ${imagesAfter} (expected: 0)`);
    console.log(`  ItineraryDestination: ${destinationsAfter} (expected: 0)`);
    console.log(`  Enquiry row exists:   ${enquiryAfter !== null} (expected: true)`);
    console.log(`  Enquiry.itineraryId:  ${enquiryAfter?.itineraryId} (expected: null)`);

    // 7. Assertions
    let passed = true;

    if (daysAfter === 0) {
      details.push("PASS: ItineraryDay rows cascade-deleted (count = 0)");
    } else {
      passed = false;
      details.push(`FAIL: ItineraryDay rows NOT cascade-deleted (expected: 0, actual: ${daysAfter})`);
    }

    if (imagesAfter === 0) {
      details.push("PASS: ItineraryImage rows cascade-deleted (count = 0)");
    } else {
      passed = false;
      details.push(`FAIL: ItineraryImage rows NOT cascade-deleted (expected: 0, actual: ${imagesAfter})`);
    }

    if (destinationsAfter === 0) {
      details.push("PASS: ItineraryDestination rows cascade-deleted (count = 0)");
    } else {
      passed = false;
      details.push(`FAIL: ItineraryDestination rows NOT cascade-deleted (expected: 0, actual: ${destinationsAfter})`);
    }

    if (enquiryAfter !== null && enquiryAfter.itineraryId === null) {
      details.push("PASS: Enquiry row preserved with itineraryId set to null (SetNull worked)");
    } else if (enquiryAfter === null) {
      passed = false;
      details.push("FAIL: Enquiry row was unexpectedly deleted (cascade occurred instead of SetNull)");
    } else {
      passed = false;
      details.push(`FAIL: Enquiry.itineraryId was not set to null (actual: ${enquiryAfter.itineraryId})`);
    }

    results.push({
      name: "TEST A — Cascade Delete & SetNull Constraints",
      passed,
      details,
    });
  } catch (err: any) {
    results.push({
      name: "TEST A — Cascade Delete & SetNull Constraints",
      passed: false,
      details,
      error: err.message || String(err),
    });
  } finally {
    // Cleanup remaining entities
    console.log("\nCleaning up Test A data...");
    if (enquiryId) {
      await prisma.enquiry.delete({ where: { id: enquiryId } }).catch(() => {});
    }
    if (itineraryId) {
      await prisma.itinerary.delete({ where: { id: itineraryId } }).catch(() => {});
    }
    if (destinationId) {
      await prisma.destination.delete({ where: { id: destinationId } }).catch(() => {});
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    console.log("Cleanup Test A complete.");
  }
}

async function runTestB(): Promise<void> {
  const details: string[] = [];
  console.log("\n==================================================");
  console.log("TEST B: Unique Constraint on (itineraryId, dayNumber)");
  console.log("==================================================");

  let userId: string | null = null;
  let itineraryId: string | null = null;

  try {
    // 1. Setup entities
    const user = await prisma.user.create({
      data: {
        email: `test-unique-${Date.now()}@test.local`,
        passwordHash: "dummy-hash",
        role: "AUTHOR",
      },
    });
    userId = user.id;

    const itinerary = await prisma.itinerary.create({
      data: {
        title: "Unique Constraint Test Safari",
        slug: `unique-test-safari-${Date.now()}`,
        authorId: user.id,
        priceOnRequest: true,
      },
    });
    itineraryId = itinerary.id;

    // 2. Insert first day with dayNumber: 1
    const day1 = await prisma.itineraryDay.create({
      data: {
        itineraryId: itinerary.id,
        dayNumber: 1,
        title: "First Day 1",
      },
    });
    console.log(`Successfully created first ItineraryDay (id: ${day1.id}, dayNumber: ${day1.dayNumber})`);
    details.push("PASS: First ItineraryDay with dayNumber 1 created successfully");

    // 3. Attempt duplicate insert with dayNumber: 1
    console.log("Attempting to insert second ItineraryDay with SAME dayNumber: 1...");
    let duplicateInserted = false;
    let caughtError: any = null;

    try {
      await prisma.itineraryDay.create({
        data: {
          itineraryId: itinerary.id,
          dayNumber: 1,
          title: "Duplicate Day 1",
        },
      });
      duplicateInserted = true;
    } catch (err) {
      caughtError = err;
    }

    let passed = false;
    if (duplicateInserted) {
      details.push("FAIL: Duplicate insert unexpectedly SUCCEEDED — unique constraint is NOT enforced!");
    } else if (
      caughtError instanceof Prisma.PrismaClientKnownRequestError &&
      caughtError.code === "P2002"
    ) {
      passed = true;
      console.log(
        `Caught expected Prisma error P2002: Unique constraint violation on target: ${JSON.stringify(
          caughtError.meta?.target
        )}`
      );
      details.push(
        `PASS: Duplicate insert rejected with Prisma P2002 (Unique constraint violation on target: ${JSON.stringify(
          caughtError.meta?.target
        )})`
      );
    } else {
      details.push(`FAIL: Duplicate insert failed, but NOT with Prisma P2002 (error: ${caughtError?.message})`);
    }

    results.push({
      name: "TEST B — Unique Constraint on (itineraryId, dayNumber)",
      passed,
      details,
    });
  } catch (err: any) {
    results.push({
      name: "TEST B — Unique Constraint on (itineraryId, dayNumber)",
      passed: false,
      details,
      error: err.message || String(err),
    });
  } finally {
    // Cleanup: deleting itinerary cascades to day1
    console.log("\nCleaning up Test B data...");
    if (itineraryId) {
      await prisma.itinerary.delete({ where: { id: itineraryId } }).catch(() => {});
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    console.log("Cleanup Test B complete.");
  }
}

async function main() {
  console.log("🔬 Running database constraints verification suite...\n");

  await runTestA();
  await runTestB();

  console.log("\n==================================================");
  console.log("SUMMARY REPORT");
  console.log("==================================================");

  let allPassed = true;

  for (const res of results) {
    const statusLabel = res.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${statusLabel}: ${res.name}`);
    for (const d of res.details) {
      console.log(`   - ${d}`);
    }
    if (res.error) {
      console.log(`   - Exception: ${res.error}`);
    }
    if (!res.passed) {
      allPassed = false;
    }
  }

  console.log("\n--------------------------------------------------");
  if (allPassed) {
    console.log("🎉 ALL CONSTRAINT TESTS PASSED SUCCESSFULLY");
    console.log("--------------------------------------------------\n");
  } else {
    console.error("🚨 ONE OR MORE CONSTRAINT TESTS FAILED");
    console.log("--------------------------------------------------\n");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("Fatal error running test suite:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
