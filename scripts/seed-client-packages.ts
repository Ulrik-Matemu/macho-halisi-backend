import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AvailabilityStatus, ItineraryStatus } from "@prisma/client";
import { prisma } from "../src/db/prisma.js";
import { generateUniqueDestinationSlug } from "../src/lib/slug.js";

/**
 * Loads the client's five supplied safari packages (7, 9, 10, 12 and 15
 * days — source: scripts/data/client-packages.json, parsed from the
 * client's itinerary documents) as PUBLISHED itineraries, and archives every
 * other itinerary so /itineraries shows only real client content.
 *
 * Idempotent: each package has a fixed slug and is deleted + recreated on
 * every run (days, images and destination links cascade). Archived demo
 * itineraries are left archived, never deleted.
 *
 * Prices: none supplied, so every package is "price on request"
 * (the public site shows "Enquire" instead of a price).
 *
 * Run with: npx tsx scripts/seed-client-packages.ts
 *
 * Against any non-local database (e.g. production on Render) it runs as a
 * DRY RUN that only reports what it would archive/replace. Add
 * --confirm-production to actually write.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageDay {
  dayNumber: number;
  title: string;
  description: string;
  meal: string;
  accommodation: string | null;
  dest: string | null;
  lat: number | null;
  lng: number | null;
}
interface PackageSource {
  days: number;
  items: PackageDay[];
}

const sources: PackageSource[] = JSON.parse(
  readFileSync(join(__dirname, "data", "client-packages.json"), "utf8")
);

// Destination catalog entries the packages link to. `kia` (airport) is
// deliberately absent — arrival days are pinned on the map but not linked.
const DESTINATIONS: Record<string, { name: string; lat: number; lng: number; blurb: string }> = {
  arusha: { name: "Arusha", lat: -3.3869, lng: 36.683, blurb: "Gateway city beneath Mount Meru, the starting point for every northern safari." },
  arusha_np: { name: "Arusha National Park", lat: -3.2333, lng: 36.8833, blurb: "Forest, savannah and the Momella Lakes beneath Mount Meru." },
  karatu: { name: "Karatu", lat: -3.3333, lng: 35.6667, blurb: "Highland farming town on the road to Ngorongoro, and Macho Halisi's home." },
  tarangire: { name: "Tarangire National Park", lat: -3.833, lng: 35.95, blurb: "Land of giants — ancient baobabs and Tanzania's largest elephant herds." },
  manyara: { name: "Lake Manyara", lat: -3.6, lng: 35.75, blurb: "Rift Valley soda lake below a forested escarpment." },
  eyasi: { name: "Lake Eyasi", lat: -3.6, lng: 35.0, blurb: "Home of the Hadzabe hunter-gatherers." },
  ngorongoro: { name: "Ngorongoro Conservation Area", lat: -3.1608, lng: 35.5885, blurb: "A collapsed volcanic caldera teeming with wildlife — Africa's Garden of Eden." },
  serengeti: { name: "Serengeti National Park", lat: -2.3333, lng: 34.8333, blurb: "Home to the Great Migration and endless golden plains stretching to the horizon." },
  natron: { name: "Lake Natron", lat: -2.4167, lng: 36.0, blurb: "Flamingo-fringed soda lake beneath the volcano Ol Doinyo Lengai." },
  kili: { name: "Mount Kilimanjaro", lat: -3.0674, lng: 37.3556, blurb: "Africa's highest peak, climbed by the Marangu route." },
  zanzibar: { name: "Zanzibar", lat: -6.1659, lng: 39.2026, blurb: "Spice-scented alleys and Swahili coast history on the Indian Ocean." },
};

interface PackageMeta {
  days: number;
  slug: string;
  title: string;
  overview: string;
  /** Existing site photography (public/media), first image is the cover. */
  images: { path: string; alt: string }[];
  /** Day numbers that get the "signature moment" treatment. */
  highlights: number[];
}

const PACKAGES: PackageMeta[] = [
  {
    days: 7,
    slug: "7-day-northern-circuit-safari",
    title: "7-Day Northern Circuit Safari",
    overview:
      "Tanzania's classic northern circuit in a week: elephant country in Tarangire, a game drive on the floor of Ngorongoro Crater, and two full days on the Serengeti plains. The journey ends with Olduvai Gorge, the Shifting Sands and a visit to a traditional Maasai boma.\n\nYour professional Macho Halisi guide meets you at Kilimanjaro International Airport (or the Namanga border) and stays with you throughout.",
    images: [
      { path: "/media/serengeti/macho-serengeti.jpg", alt: "A Macho Halisi safari vehicle on the Serengeti plains" },
      { path: "/media/serengeti/sere-lion-couple.jpg", alt: "A pair of lions resting in the Serengeti" },
      { path: "/media/tarangire/tara-river.jpg", alt: "The Tarangire River in the dry season" },
      { path: "/media/ngorongoro/ngorongoro-hero.jpg", alt: "The Ngorongoro Crater floor" },
      { path: "/media/ngorongoro/ngoro-maasai.jpg", alt: "A Maasai herder near Ngorongoro" },
    ],
    highlights: [3, 4],
  },
  {
    days: 9,
    slug: "9-day-arusha-tarangire-serengeti-safari",
    title: "9-Day Arusha, Tarangire & Serengeti Safari",
    overview:
      "A fuller northern safari that begins gently with Arusha National Park and a guided walk with an armed ranger, then moves through Tarangire and the Rift Valley to three nights in the Serengeti. The return leg takes in Olduvai Gorge and the Shifting Sands.\n\nStaying at Arusha Gran Meliá, Tarangire Sopa Lodge and the Serena lodges, this is the comfortable option for travellers who want more time on the plains.",
    images: [
      { path: "/media/serengeti/southern-plains.jpg", alt: "Golden grassland plains in the southern Serengeti" },
      { path: "/media/tarangire/tara-hero.jpg", alt: "Baobab trees in Tarangire National Park" },
      { path: "/media/serengeti/sere-lion.jpg", alt: "A lion in the Serengeti" },
      { path: "/media/tarangire/tara-cheetah.jpg", alt: "A cheetah in Tarangire" },
      { path: "/media/manyara/manyara-hero.jpg", alt: "Lake Manyara beneath the Rift escarpment" },
    ],
    highlights: [2, 6],
  },
  {
    days: 10,
    slug: "10-day-serengeti-lake-eyasi-lake-natron-safari",
    title: "10-Day Serengeti, Lake Eyasi & Lake Natron Safari",
    overview:
      "Three nights in the central Serengeti, then two cultural and landscape detours few visitors make: a day with the Hadzabe hunter-gatherers at Lake Eyasi, and a night at Lake Natron beneath the volcano Ol Doinyo Lengai.\n\nThe return takes in Mto wa Mbu village for a guided cultural tour before the transfer back to Kilimanjaro International Airport or the Namanga border.",
    images: [
      { path: "/media/serengeti/northern-river-country.jpg", alt: "River country in the northern Serengeti" },
      { path: "/media/experiences/elephant-vehicle.jpg", alt: "Elephants beside a safari vehicle" },
      { path: "/media/manyara/flamingo.jpg", alt: "Flamingos wading in a soda lake" },
      { path: "/media/serengeti/seronera-valley.jpg", alt: "The Seronera valley in the Serengeti" },
      { path: "/media/ngorongoro/ngoro-ariel.jpg", alt: "A road across the plains near Olduvai Gorge" },
    ],
    highlights: [3, 7, 8],
  },
  {
    days: 12,
    slug: "12-day-kilimanjaro-marangu-climb-and-lake-natron",
    title: "12-Day Kilimanjaro Marangu Climb & Lake Natron",
    overview:
      "Seven days on the Marangu route — the only Kilimanjaro route with hut accommodation — from the rainforest at Mandara to Uhuru Peak. After the descent you transfer to Arusha, then head north through Ngorongoro to Lake Natron and Ol Doinyo Lengai.\n\nThe journey finishes with a visit to a Maasai cultural boma and a morning in Arusha National Park before your departure.",
    images: [
      { path: "/media/kilimanjaro/kili-ariel.jpg", alt: "Mount Kilimanjaro above the highland plateau" },
      { path: "/media/kilimanjaro/lemosho.jpg", alt: "A trekker on Kilimanjaro's mountain trail" },
      { path: "/media/manyara/flamingo.jpg", alt: "Flamingos on a soda lake near Lake Natron" },
      { path: "/media/ngorongoro/ngoro-maasai.jpg", alt: "A Maasai herder near Ngorongoro" },
    ],
    highlights: [5, 10],
  },
  {
    days: 15,
    slug: "15-day-northern-safari-cultural-tours-and-zanzibar",
    title: "15-Day Northern Safari, Cultural Tours & Zanzibar",
    overview:
      "The complete Tanzania journey: Tarangire, the Ngorongoro Crater and the Serengeti, then cultural days with the Hadzabe at Lake Eyasi, the Maasai and the village of Mto wa Mbu, followed by a canoe on Lake Duluti and a walk in Arusha National Park.\n\nA short flight from Arusha takes you to Zanzibar for four nights in Stone Town to finish.",
    images: [
      { path: "/media/serengeti/sere-baloon.jpg", alt: "A hot air balloon over the Serengeti at dawn" },
      { path: "/media/ngorongoro/ngorongoro-hero.jpg", alt: "The Ngorongoro Crater floor" },
      { path: "/media/zanzibar/stone-town.jpg", alt: "Historic Stone Town on Zanzibar" },
      { path: "/media/zanzibar/mnemba-atoll.jpg", alt: "Turquoise water off Zanzibar" },
      { path: "/media/experiences/game-drive-guests.jpg", alt: "Guests on a game drive" },
    ],
    highlights: [3, 5, 7, 11],
  },
];

// TODO(client): the packages came without inclusions/exclusions. These lines
// only restate what the client's own day-by-day documents already say; the
// client must supply the full lists (park fees, vehicle, insurance, tips,
// visas, flights) before they are published as commitments.
function inclusionsFor(pkg: PackageSource): string[] {
  const lines = [
    "Welcome at Kilimanjaro International Airport or the Namanga border by your professional safari guide",
    "Accommodation as listed in the day-by-day programme",
    "Meals as listed in the day-by-day programme",
  ];
  if (pkg.items.some((d) => /game drive/i.test(d.description))) lines.push("Game drives with your professional safari guide");
  if (pkg.items.some((d) => /picnic lunch/i.test(d.description))) lines.push("Picnic lunches on game-drive days");
  if (pkg.items.some((d) => /flight to zanzibar/i.test(d.title))) lines.push("Domestic flight from Arusha to Zanzibar");
  if (pkg.items.some((d) => /Marangu Gate/i.test(d.title))) lines.push("Marangu route climb with park formalities completed at the gate");
  return lines;
}

async function ensureDestination(key: string): Promise<{ id: string }> {
  const d = DESTINATIONS[key]!;
  const existing = await prisma.destination.findFirst({ where: { name: { equals: d.name, mode: "insensitive" } } });
  if (existing) return existing;
  return prisma.destination.create({
    data: { name: d.name, slug: await generateUniqueDestinationSlug(d.name), latitude: d.lat, longitude: d.lng, blurb: d.blurb },
  });
}

function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function main() {
  const dryRun = !isLocalDatabase() && !process.argv.includes("--confirm-production");
  if (dryRun) {
    const host = new URL(process.env.DATABASE_URL ?? "postgresql://unknown").hostname;
    console.log(`🔎 DRY RUN against remote database host "${host}" — nothing will be written.`);
    const slugsToKeep = PACKAGES.map((p) => p.slug);
    const existing = await prisma.itinerary.findMany({
      select: { slug: true, title: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    console.log(`\nExisting itineraries (${existing.length}):`);
    for (const i of existing) {
      const action = slugsToKeep.includes(i.slug)
        ? "WILL BE DELETED & RECREATED"
        : i.status === "ARCHIVED"
        ? "stays archived"
        : "WILL BE ARCHIVED";
      console.log(`   [${i.status}] ${i.title} (${i.slug}) -> ${action}`);
    }
    console.log("\nWill be created & published:");
    for (const p of PACKAGES) console.log(`   + ${p.title} (${p.slug})`);
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    console.log(`\nADMIN users available as author: ${admins}`);
    console.log("\nRe-run with --confirm-production to apply.");
    return;
  }

  const admin = await prisma.user.findUnique({ where: { email: "admin@machohalisi.com" } });
  const author = admin ?? (await prisma.user.findFirst({ where: { role: "ADMIN" } }));
  if (!author) throw new Error("No ADMIN user found — run npm run seed:admin first.");

  const slugs = PACKAGES.map((p) => p.slug);

  console.log("📦 Archiving existing non-client itineraries...");
  const archived = await prisma.itinerary.updateMany({
    where: { slug: { notIn: slugs }, status: { not: ItineraryStatus.ARCHIVED } },
    data: { status: ItineraryStatus.ARCHIVED },
  });
  console.log(`   Archived ${archived.count} itinerary(ies).`);

  const destCache = new Map<string, { id: string }>();
  const now = Date.now();

  for (const [i, meta] of PACKAGES.entries()) {
    const source = sources.find((s) => s.days === meta.days);
    if (!source) throw new Error(`No source data for ${meta.days}-day package`);

    await prisma.itinerary.deleteMany({ where: { slug: meta.slug } });

    const destKeys = [...new Set(source.items.map((d) => d.dest).filter((k): k is string => !!k && k in DESTINATIONS))];
    for (const key of destKeys) {
      if (!destCache.has(key)) destCache.set(key, await ensureDestination(key));
    }

    const itinerary = await prisma.itinerary.create({
      data: {
        title: meta.title,
        slug: meta.slug,
        status: ItineraryStatus.PUBLISHED,
        // Staggered so the newest-first public list (and the homepage's
        // first four) read 7, 9, 10, 12, 15 days.
        publishedAt: new Date(now - i * 60_000),
        authorId: author.id,
        editorId: author.id,
        overview: meta.overview,
        nights: meta.days - 1,
        startingPrice: null,
        priceOnRequest: true,
        inclusions: inclusionsFor(source),
        exclusions: [],
        availabilityStatus: AvailabilityStatus.AVAILABLE,
        showRouteMap: true,
        days: {
          create: source.items.map((d) => ({
            dayNumber: d.dayNumber,
            title: d.title,
            description: d.description,
            accommodation: d.accommodation,
            activities: d.meal ? [`Meals: ${d.meal}`] : [],
            latitude: d.lat,
            longitude: d.lng,
            highlight: meta.highlights.includes(d.dayNumber),
          })),
        },
        images: {
          create: meta.images.map((img, idx) => ({ url: img.path, altText: img.alt, sortOrder: idx })),
        },
        destinations: { create: destKeys.map((k) => ({ destinationId: destCache.get(k)!.id })) },
      },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });

    await prisma.itinerary.update({ where: { id: itinerary.id }, data: { heroImageId: itinerary.images[0]!.id } });
    console.log(`   + ${meta.title} (${meta.days} days, ${destKeys.length} destinations)`);
  }

  console.log("✅ Client packages seeded and published. Visit /itineraries on the public site.");
}

main()
  .catch((err) => {
    console.error("❌ Seeding failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
