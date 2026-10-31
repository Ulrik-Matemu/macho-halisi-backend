import "dotenv/config";
import { prisma } from "../src/db/prisma.js";
import { placesVisited } from "./data/itinerary-places.js";

/**
 * Adds the missing "Destinations visited" links to the five client
 * itineraries already in the database (e.g. Tarangire and Ngorongoro on the
 * 7-day safari), judged from each itinerary's own daily programme.
 *
 * Additive and idempotent: it only inserts links that are missing, and never
 * deletes or edits itineraries, days, or anything saved from the dashboard.
 * Unlike seed-client-packages.ts it is safe to run against production.
 *
 * Run with: npx tsx scripts/link-itinerary-destinations.ts
 * Against any non-local database it runs as a DRY RUN; add
 * --confirm-production to actually write.
 */

const DESTINATION_NAMES: Record<string, string> = {
  tarangire: "Tarangire National Park",
  ngorongoro: "Ngorongoro Conservation Area",
  eyasi: "Lake Eyasi",
  natron: "Lake Natron",
  arusha_np: "Arusha National Park",
  serengeti: "Serengeti National Park",
  kili: "Mount Kilimanjaro",
  zanzibar: "Zanzibar",
};

function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function main() {
  const write = isLocalDatabase() || process.argv.includes("--confirm-production");
  if (!write) console.log("🔎 DRY RUN against a remote database — nothing will be written.");

  const itineraries = await prisma.itinerary.findMany({
    where: { status: "PUBLISHED", slug: { contains: "-day-" } },
    include: { days: true, destinations: true },
  });

  let added = 0;
  for (const it of itineraries) {
    const have = new Set(it.destinations.map((d) => d.destinationId));
    const missing: { key: string; id: string; name: string }[] = [];
    for (const key of placesVisited(it.days.map((d) => ({ title: d.title ?? "", description: d.description ?? "" })))) {
      const dest = await prisma.destination.findFirst({
        where: { name: { equals: DESTINATION_NAMES[key]!, mode: "insensitive" } },
      });
      if (!dest) {
        console.log(`   ! ${it.title}: destination "${DESTINATION_NAMES[key]}" not in the database — skipped`);
        continue;
      }
      if (!have.has(dest.id)) missing.push({ key, id: dest.id, name: dest.name });
    }
    console.log(`${it.title}: ${missing.length ? "adding " + missing.map((m) => m.name).join(", ") : "already complete"}`);
    if (write && missing.length) {
      await prisma.itineraryDestination.createMany({
        data: missing.map((m) => ({ itineraryId: it.id, destinationId: m.id })),
        skipDuplicates: true,
      });
    }
    added += missing.length;
  }
  console.log(write ? `✅ Added ${added} link(s).` : `Would add ${added} link(s). Re-run with --confirm-production to apply.`);
}

main()
  .catch((err) => {
    console.error("❌ Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
