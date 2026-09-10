import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🔍 Verifying schema relations...\n");

  // 1. Create a User
  const user = await prisma.user.create({
    data: {
      email: `verify-${Date.now()}@test.local`,
      passwordHash: "not-a-real-hash",
      role: "AUTHOR",
    },
  });
  console.log("✅ Created User:", user.id, `(${user.email})`);

  // 2. Create a Destination
  const destination = await prisma.destination.create({
    data: {
      name: "Ngorongoro Crater",
      slug: `ngorongoro-crater-${Date.now()}`,
    },
  });
  console.log("✅ Created Destination:", destination.id, `(${destination.slug})`);

  // 3. Create an Itinerary with nested days, images, and destination link
  const itinerary = await prisma.itinerary.create({
    data: {
      title: "Crater Rim Explorer",
      slug: `crater-rim-explorer-${Date.now()}`,
      status: "DRAFT",
      authorId: user.id,
      overview: "A two-night luxury immersion into the Ngorongoro Crater.",
      nights: 2,
      priceOnRequest: true,
      inclusions: ["Park fees", "Game drives", "All meals"],
      exclusions: ["International flights", "Travel insurance"],
      availabilityStatus: "AVAILABLE",
      days: {
        create: [
          {
            dayNumber: 1,
            title: "Arrival & Crater Rim",
            description: "Arrive at Kilimanjaro and transfer to the crater rim lodge.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Airport transfer", "Sunset at crater rim"],
          },
          {
            dayNumber: 2,
            title: "Full-Day Crater Descent",
            description: "Descend into the crater for a full day of game viewing.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Crater game drive", "Picnic lunch", "Hippo pool visit"],
          },
        ],
      },
      images: {
        create: [
          {
            url: "https://example.com/crater-view.jpg",
            sortOrder: 1,
            altText: "Panoramic view of Ngorongoro Crater",
          },
        ],
      },
      destinations: {
        create: [
          {
            destinationId: destination.id,
          },
        ],
      },
    },
  });
  console.log("✅ Created Itinerary:", itinerary.id, `(${itinerary.slug})`);

  // 4. Read back with ALL relations
  const full = await prisma.itinerary.findUnique({
    where: { id: itinerary.id },
    include: {
      author: true,
      editor: true,
      days: { orderBy: { dayNumber: "asc" } },
      images: { orderBy: { sortOrder: "asc" } },
      destinations: { include: { destination: true } },
      enquiries: true,
    },
  });

  console.log("\n📦 Full Itinerary with relations retrieved from Postgres:\n");
  console.log(JSON.stringify(full, null, 2));

  // 5. Clean up (FK-safe order: children first, then parents)
  console.log("\n🧹 Cleaning up test data...");
  await prisma.itineraryDestination.deleteMany({ where: { itineraryId: itinerary.id } });
  await prisma.itineraryImage.deleteMany({ where: { itineraryId: itinerary.id } });
  await prisma.itineraryDay.deleteMany({ where: { itineraryId: itinerary.id } });
  await prisma.itinerary.delete({ where: { id: itinerary.id } });
  await prisma.destination.delete({ where: { id: destination.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("✅ Cleanup complete — all test data removed, database left clean.\n");
}

main()
  .catch((e) => {
    console.error("❌ Verification failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
