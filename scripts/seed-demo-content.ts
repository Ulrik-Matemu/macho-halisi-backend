import "dotenv/config";
import { prisma } from "../src/db/prisma.js";
import { generateUniqueItinerarySlug, generateUniqueDestinationSlug } from "../src/lib/slug.js";
import { AvailabilityStatus, ItineraryStatus } from "@prisma/client";

/**
 * Wipes the obvious placeholder/test content (itineraries and destinations
 * created during development/E2E testing) and replaces it with three
 * realistic, fully-fleshed Tanzania safari itineraries — images, day-by-day
 * coordinates, signature-moment days, inclusions/exclusions, and
 * availability periods — so the site can be previewed with real-looking
 * content. Every image URL is a verified, publicly hosted Unsplash photo
 * (images.unsplash.com is already whitelisted in next.config.ts).
 *
 * Run with: npx tsx scripts/seed-demo-content.ts
 */

// ─── Verified stock imagery (photo, description) ───────────────────────
const IMG = {
  jeepSunset: img("1516426122078-c23e76319801", "Safari vehicle crossing the plains at sunset"),
  acaciaSunset: img("1547471080-7cc2caa01a7e", "Lone acacia tree silhouetted against an African sunset"),
  beachPalms: img("1509233725247-49e657c54213", "Palm-fringed beach on Zanzibar's coast"),
  rhinos: img("1547970810-dc1eac37d174", "White rhino and calf crossing a bush track"),
  giraffeSilhouette: img("1523805009345-7448845a9e53", "Giraffe silhouetted against the dusk sky"),
  elephantPlains: img("1535941339077-2dd1c7963098", "Bull elephant walking across open grassland"),
  giraffePortrait: img("1547721064-da6cfb341d50", "Close portrait of a giraffe against a clear sky"),
  lagoonBoat: img("1516815231560-8f41ec531527", "Traditional boat anchored in a turquoise lagoon"),
  antelopeZebras: img("1466721591366-2d5fba72006d", "Hartebeest leaping past a grazing zebra herd"),
  kingfisher: img("1470114716159-e389f8712fda", "Kingfisher perched above a river"),
  lionessPair: img("1504173010664-32509aeebb62", "Two lionesses resting in tall grass"),
  elephantCalf: img("1521651201144-634f700b36ef", "Elephant mother and calf in golden grass"),
  coastAerial: img("1547036967-23d11aacaee0", "Aerial view of a turquoise coastline"),
} as const;

function img(photoId: string, alt: string) {
  return { url: `https://images.unsplash.com/photo-${photoId}?w=1920&q=80`, alt };
}

// ─── Destinations (shared catalog) ──────────────────────────────────────
const DESTINATIONS = [
  {
    key: "arusha",
    name: "Arusha",
    latitude: -3.3869,
    longitude: 36.683,
    blurb: "Gateway city beneath Mount Meru, the starting point for every northern safari.",
  },
  {
    key: "tarangire",
    name: "Tarangire National Park",
    latitude: -3.833,
    longitude: 35.95,
    blurb: "Land of giants — ancient baobabs and Tanzania's largest elephant herds.",
  },
  {
    key: "ngorongoro",
    name: "Ngorongoro Conservation Area",
    latitude: -3.1608,
    longitude: 35.5885,
    blurb: "A collapsed volcanic caldera teeming with wildlife — Africa's Garden of Eden.",
  },
  {
    key: "serengeti",
    name: "Serengeti National Park",
    latitude: -2.3333,
    longitude: 34.8333,
    blurb: "Home to the Great Migration and endless golden plains stretching to the horizon.",
  },
  {
    key: "zanzibar",
    name: "Zanzibar",
    latitude: -6.1659,
    longitude: 39.2026,
    blurb: "Spice-scented alleys and Swahili coast history on the Indian Ocean.",
  },
  {
    key: "ruaha",
    name: "Ruaha National Park",
    latitude: -7.5,
    longitude: 34.6667,
    blurb: "Tanzania's largest national park — remote, lion-dense wilderness along the Great Ruaha River.",
  },
  {
    key: "nyerere",
    name: "Nyerere National Park",
    latitude: -7.7667,
    longitude: 37.9333,
    blurb: "Africa's largest game reserve, explored by boat along the wildlife-rich Rufiji River.",
  },
] as const;

async function main() {
  console.log("🧹 Clearing placeholder/test content...");

  const testItineraries = await prisma.itinerary.findMany({
    where: { OR: [{ title: { contains: "test", mode: "insensitive" } }, { title: { contains: "E2E", mode: "insensitive" } }] },
    select: { id: true, title: true },
  });
  if (testItineraries.length > 0) {
    await prisma.itinerary.deleteMany({ where: { id: { in: testItineraries.map((i) => i.id) } } });
    console.log(`   Deleted ${testItineraries.length} test itinerary(ies): ${testItineraries.map((i) => i.title).join(", ")}`);
  }

  const testDestinations = await prisma.destination.findMany({
    where: { OR: [{ name: { contains: "E2E", mode: "insensitive" } }, { name: "csdv" }] },
    select: { id: true, name: true },
  });
  if (testDestinations.length > 0) {
    await prisma.destination.deleteMany({ where: { id: { in: testDestinations.map((d) => d.id) } } });
    console.log(`   Deleted ${testDestinations.length} test destination(s): ${testDestinations.map((d) => d.name).join(", ")}`);
  }

  const editor = await prisma.user.findUnique({ where: { email: "editor@machohalisi.com" } });
  const admin = await prisma.user.findUnique({ where: { email: "admin@machohalisi.com" } });
  if (!editor || !admin) {
    throw new Error("Expected both editor@machohalisi.com and admin@machohalisi.com to exist — run npm run seed:admin first.");
  }

  console.log("🌍 Creating destinations catalog...");
  const destByKey: Record<string, { id: string }> = {};
  for (const d of DESTINATIONS) {
    const slug = await generateUniqueDestinationSlug(d.name);
    const destination = await prisma.destination.create({
      data: { name: d.name, slug, latitude: d.latitude, longitude: d.longitude, blurb: d.blurb },
    });
    destByKey[d.key] = destination;
    console.log(`   + ${d.name}`);
  }

  console.log("🏕️  Creating itineraries...");
  await createNorthernCircuit(editor.id, admin.id, destByKey);
  await createMigrationAndZanzibar(admin.id, editor.id, destByKey);
  await createSouthernWilderness(editor.id, admin.id, destByKey);

  console.log("✅ Demo content seeded. Visit /itineraries on the public site.");
}

async function createNorthernCircuit(authorId: string, editorId: string, dest: Record<string, { id: string }>) {
  const title = "Classic Northern Circuit Safari";
  const slug = await generateUniqueItinerarySlug(title);

  const itinerary = await prisma.itinerary.create({
    data: {
      title,
      slug,
      status: ItineraryStatus.PUBLISHED,
      publishedAt: new Date(),
      authorId,
      editorId,
      overview:
        "Tanzania's most celebrated safari route, woven through four of its greatest wildlife strongholds. You'll track elephant herds beneath ancient baobabs in Tarangire, drop into the wildlife-packed amphitheatre of Ngorongoro Crater, and lose the horizon entirely on the endless plains of the Serengeti.\n\nEach night ends at a hand-picked lodge or tented camp chosen for its setting as much as its comfort, and every game drive is led by a professional guide who knows exactly where the pride denned last week.",
      nights: 7,
      startingPrice: 4200,
      priceOnRequest: false,
      inclusions: [
        "All park entry and conservation fees",
        "Private 4x4 safari vehicle with pop-up roof",
        "Professional English-speaking driver-guide",
        "Full-board accommodation throughout",
        "Airport and airstrip transfers",
        "Bottled water on all game drives",
      ],
      exclusions: [
        "International flights",
        "Tanzania visa fees",
        "Travel insurance",
        "Gratuities for guides and camp staff",
        "Optional hot air balloon safari",
        "Alcoholic beverages",
      ],
      travelInfo:
        "Light, neutral-coloured clothing (khaki, olive, beige) is recommended for game drives; avoid dark blue and black, which attract tsetse flies in wooded areas. Internal flights are not used on this circuit, so luggage limits are relaxed, but a soft-sided bag still packs more easily into a safari vehicle.",
      routeMapUrl: null,
      showRouteMap: true,
      availabilityStatus: AvailabilityStatus.AVAILABLE,
      days: {
        create: [
          {
            dayNumber: 1,
            title: "Arrive in Arusha",
            description:
              "Land at Kilimanjaro International Airport and transfer to a coffee farm lodge on the outskirts of Arusha, where the safari begins tomorrow. Settle in, meet your guide over dinner, and run through the days ahead.",
            accommodation: "Arusha Coffee Lodge",
            activities: ["Airport pickup", "Welcome briefing with your guide", "Rest & acclimatise"],
            latitude: -3.3869,
            longitude: 36.683,
            highlight: false,
          },
          {
            dayNumber: 2,
            title: "Arusha to Tarangire National Park",
            description:
              "Drive south-west into Tarangire, a park defined by its swollen baobabs and the Tarangire River, the region's only permanent water source in the dry season — which draws one of Africa's densest elephant populations.",
            accommodation: "Tarangire Treetops",
            activities: ["Afternoon game drive", "Sundowners over the river valley"],
            latitude: -3.8,
            longitude: 35.92,
            highlight: false,
          },
          {
            dayNumber: 3,
            title: "Full Day in Tarangire",
            description:
              "A full day among Tarangire's elephant herds — some over a hundred strong — alongside baobab-studded ridgelines, tree-climbing pythons, and one of the highest concentrations of breeding birds in the country.",
            accommodation: "Tarangire Treetops",
            activities: ["Morning game drive", "Picnic lunch in the bush", "Evening game drive"],
            latitude: -3.8,
            longitude: 35.92,
            highlight: false,
          },
          {
            dayNumber: 4,
            title: "Tarangire to the Ngorongoro Highlands",
            description:
              "A scenic drive up onto the rim of the Ngorongoro Crater, climbing through highland forest as the temperature drops. Your lodge sits directly on the crater edge, with the caldera floor visible from the terrace.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Scenic highland drive", "Crater rim viewpoint walk", "Maasai village visit"],
            latitude: -3.19,
            longitude: 35.53,
            highlight: false,
          },
          {
            dayNumber: 5,
            title: "Ngorongoro Crater Floor",
            description:
              "Descend before sunrise onto the crater floor — a self-contained ecosystem of grassland, swamp, and soda lake holding one of the densest concentrations of predators on Earth. This is Tanzania's best single day for the Big Five.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Full-day crater floor game drive", "Picnic lunch by the hippo pool"],
            latitude: -3.1608,
            longitude: 35.5885,
            highlight: true,
          },
          {
            dayNumber: 6,
            title: "Ngorongoro to Central Serengeti",
            description:
              "Cross the Ngorongoro Highlands into the Serengeti proper, watching the landscape flatten into open plains as you descend. Game viewing begins the moment you enter the park boundary.",
            accommodation: "Serengeti Serena Safari Lodge",
            activities: ["Game drive en route", "Sundowners on the Seronera plains"],
            latitude: -2.6,
            longitude: 34.75,
            highlight: false,
          },
          {
            dayNumber: 7,
            title: "Full Day in the Serengeti",
            description:
              "A full day on the plains that gave the Serengeti its name — 'the place where the land runs on forever' in Maa. Depending on the season, this is prime territory for the Great Migration's wildebeest and zebra columns.",
            accommodation: "Serengeti Serena Safari Lodge",
            activities: ["Morning game drive", "Optional hot air balloon safari", "Evening game drive"],
            latitude: -2.45,
            longitude: 34.83,
            highlight: true,
          },
          {
            dayNumber: 8,
            title: "Serengeti to Arusha & Departure",
            description:
              "One last game drive before the drive back to Arusha, with a stop at Olduvai Gorge — the 'Cradle of Mankind' — en route. Transfer to Kilimanjaro International Airport for your departure flight.",
            accommodation: null,
            activities: ["Final game drive", "Olduvai Gorge museum stop", "Transfer to airport"],
            latitude: -3.3869,
            longitude: 36.683,
            highlight: false,
          },
        ],
      },
      images: {
        create: [
          { url: IMG.jeepSunset.url, altText: IMG.jeepSunset.alt, sortOrder: 0 },
          { url: IMG.giraffeSilhouette.url, altText: IMG.giraffeSilhouette.alt, sortOrder: 1 },
          { url: IMG.elephantPlains.url, altText: IMG.elephantPlains.alt, sortOrder: 2 },
          { url: IMG.elephantCalf.url, altText: IMG.elephantCalf.alt, sortOrder: 3 },
          { url: IMG.lionessPair.url, altText: IMG.lionessPair.alt, sortOrder: 4 },
          { url: IMG.antelopeZebras.url, altText: IMG.antelopeZebras.alt, sortOrder: 5 },
        ],
      },
      destinations: {
        create: [
          { destinationId: dest.arusha!.id },
          { destinationId: dest.tarangire!.id },
          { destinationId: dest.ngorongoro!.id },
          { destinationId: dest.serengeti!.id },
        ],
      },
      availabilityPeriods: {
        create: [
          {
            startDate: new Date("2026-06-01"),
            endDate: new Date("2026-10-31"),
            status: AvailabilityStatus.AVAILABLE,
            note: "Peak dry season — best wildlife viewing",
          },
          {
            startDate: new Date("2026-11-01"),
            endDate: new Date("2026-12-20"),
            status: AvailabilityStatus.LIMITED,
            note: "Short rains — fewer crowds, occasional afternoon showers",
          },
        ],
      },
    },
    include: { images: true, days: true },
  });

  await setHeroImages(itinerary.id, itinerary.images, [
    { dayNumber: 5, alt: IMG.lionessPair.alt },
    { dayNumber: 7, alt: IMG.antelopeZebras.alt },
  ]);
  console.log(`   + ${title}`);
}

async function createMigrationAndZanzibar(authorId: string, editorId: string, dest: Record<string, { id: string }>) {
  const title = "Migration & Zanzibar Beach Escape";
  const slug = await generateUniqueItinerarySlug(title);

  const itinerary = await prisma.itinerary.create({
    data: {
      title,
      slug,
      status: ItineraryStatus.PUBLISHED,
      publishedAt: new Date(),
      authorId,
      editorId,
      overview:
        "Six days chasing the Great Migration across the northern circuit, followed by four days doing absolutely nothing on a powder-white Zanzibar beach. It's the pairing most first-time visitors to Tanzania ask for, and for good reason — the contrast between dust and ocean air is part of the appeal.\n\nA short scenic flight links the two halves of the trip, so there's no long overland transfer eating into either the safari or the sand.",
      nights: 9,
      startingPrice: 5600,
      priceOnRequest: false,
      inclusions: [
        "All park entry and conservation fees",
        "Private 4x4 safari vehicle with driver-guide",
        "Domestic flight, Arusha to Zanzibar",
        "Full-board safari lodges, breakfast-only beach resort",
        "Sunset dhow cruise in Zanzibar",
        "All airport and airstrip transfers",
      ],
      exclusions: [
        "International flights",
        "Tanzania visa fees",
        "Travel insurance",
        "Gratuities",
        "Spa treatments",
        "Alcoholic beverages and beach excursions not listed",
      ],
      travelInfo:
        "The Arusha–Zanzibar flight has a 15kg luggage limit in a soft-sided bag; excess safari clothing can be left at the lodge and collected on a return trip. Reef shoes are recommended for the beach leg — much of Zanzibar's shoreline is exposed coral at low tide.",
      routeMapUrl: null,
      showRouteMap: true,
      availabilityStatus: AvailabilityStatus.AVAILABLE,
      days: {
        create: [
          {
            dayNumber: 1,
            title: "Arrive in Arusha",
            description: "Land in Arusha and transfer to a coffee farm lodge to rest before the safari begins.",
            accommodation: "Arusha Coffee Lodge",
            activities: ["Airport pickup", "Welcome dinner"],
            latitude: -3.3869,
            longitude: 36.683,
            highlight: false,
          },
          {
            dayNumber: 2,
            title: "Arusha to Tarangire National Park",
            description: "Head into Tarangire, home to Tanzania's largest concentration of elephants and its iconic baobab-lined ridges.",
            accommodation: "Tarangire Treetops",
            activities: ["Afternoon game drive", "Sundowners"],
            latitude: -3.8,
            longitude: 35.92,
            highlight: false,
          },
          {
            dayNumber: 3,
            title: "Tarangire to Ngorongoro Highlands",
            description: "Climb to the crater rim, stopping at a Maasai village en route to learn about life on the highland plains.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Crater rim walk", "Maasai village visit"],
            latitude: -3.19,
            longitude: 35.53,
            highlight: false,
          },
          {
            dayNumber: 4,
            title: "Ngorongoro Crater Floor",
            description:
              "A full day on the crater floor — grassland, swamp, and soda lake packed into a single collapsed caldera, with one of Africa's best chances of a Big Five day.",
            accommodation: "Ngorongoro Serena Safari Lodge",
            activities: ["Full-day crater floor game drive", "Picnic lunch by the hippo pool"],
            latitude: -3.1608,
            longitude: 35.5885,
            highlight: true,
          },
          {
            dayNumber: 5,
            title: "Ngorongoro to Central Serengeti",
            description: "Descend onto the endless Serengeti plains, with game viewing starting the moment you cross the park boundary.",
            accommodation: "Serengeti Serena Safari Lodge",
            activities: ["Game drive en route", "Sundowners on the plains"],
            latitude: -2.6,
            longitude: 34.75,
            highlight: false,
          },
          {
            dayNumber: 6,
            title: "Serengeti — Searching for the Migration",
            description:
              "A full day tracking the wildebeest and zebra columns of the Great Migration, with an optional dawn hot air balloon safari for a bird's-eye view of the plains.",
            accommodation: "Serengeti Serena Safari Lodge",
            activities: ["Morning game drive", "Optional hot air balloon safari", "Evening game drive"],
            latitude: -2.45,
            longitude: 34.83,
            highlight: true,
          },
          {
            dayNumber: 7,
            title: "Serengeti to Zanzibar",
            description:
              "Fly from the Serengeti via Arusha to Zanzibar's Indian Ocean coast — the dust of the plains traded for white sand and warm water within a single afternoon.",
            accommodation: "Zanzi Resort, Kiwengwa",
            activities: ["Scenic flight", "Beach arrival", "Sunset stroll on the shore"],
            latitude: -5.9,
            longitude: 39.35,
            highlight: false,
          },
          {
            dayNumber: 8,
            title: "Zanzibar — Beach Day",
            description: "A free day on the beach, with an optional snorkelling trip out to the reef for those who want a break from doing nothing.",
            accommodation: "Zanzi Resort, Kiwengwa",
            activities: ["Optional snorkelling trip", "Spa treatment", "Free time at leisure"],
            latitude: -5.9,
            longitude: 39.35,
            highlight: false,
          },
          {
            dayNumber: 9,
            title: "Stone Town & Spice Tour",
            description:
              "A guided walk through Stone Town's UNESCO-listed alleyways, followed by a spice farm tour and a sunset dhow cruise along the coast — Zanzibar's other side, beyond the beach.",
            accommodation: "Zanzi Resort, Kiwengwa",
            activities: ["Stone Town walking tour", "Spice farm visit", "Sunset dhow cruise"],
            latitude: -6.1659,
            longitude: 39.2026,
            highlight: true,
          },
          {
            dayNumber: 10,
            title: "Departure",
            description: "A final morning on the beach before transferring to Zanzibar International Airport for onward or international flights.",
            accommodation: null,
            activities: ["Final beach morning", "Transfer to airport"],
            latitude: -6.1659,
            longitude: 39.2026,
            highlight: false,
          },
        ],
      },
      images: {
        create: [
          { url: IMG.lagoonBoat.url, altText: IMG.lagoonBoat.alt, sortOrder: 0 },
          { url: IMG.beachPalms.url, altText: IMG.beachPalms.alt, sortOrder: 1 },
          { url: IMG.giraffePortrait.url, altText: IMG.giraffePortrait.alt, sortOrder: 2 },
          { url: IMG.coastAerial.url, altText: IMG.coastAerial.alt, sortOrder: 3 },
          { url: IMG.jeepSunset.url, altText: IMG.jeepSunset.alt, sortOrder: 4 },
        ],
      },
      destinations: {
        create: [
          { destinationId: dest.arusha!.id },
          { destinationId: dest.tarangire!.id },
          { destinationId: dest.ngorongoro!.id },
          { destinationId: dest.serengeti!.id },
          { destinationId: dest.zanzibar!.id },
        ],
      },
      availabilityPeriods: {
        create: [
          {
            startDate: new Date("2026-07-01"),
            endDate: new Date("2026-09-30"),
            status: AvailabilityStatus.AVAILABLE,
            note: "Dry season safari paired with calm Zanzibar seas",
          },
          {
            startDate: new Date("2027-02-01"),
            endDate: new Date("2027-03-15"),
            status: AvailabilityStatus.LIMITED,
            note: "Calving season overlap — book early",
          },
        ],
      },
    },
    include: { images: true, days: true },
  });

  await setHeroImages(itinerary.id, itinerary.images, [
    { dayNumber: 4, alt: IMG.giraffePortrait.alt },
    { dayNumber: 6, alt: IMG.jeepSunset.alt },
    { dayNumber: 7, alt: IMG.beachPalms.alt },
    { dayNumber: 9, alt: IMG.lagoonBoat.alt },
  ]);
  console.log(`   + ${title}`);
}

async function createSouthernWilderness(authorId: string, editorId: string, dest: Record<string, { id: string }>) {
  const title = "Southern Tanzania Wilderness — Ruaha & Nyerere";
  const slug = await generateUniqueItinerarySlug(title);

  const itinerary = await prisma.itinerary.create({
    data: {
      title,
      slug,
      status: ItineraryStatus.PUBLISHED,
      publishedAt: new Date(),
      authorId,
      editorId,
      overview:
        "A fly-in circuit through Tanzania's least-visited wilderness, for travellers who've already done the northern circuit — or who never wanted to share a sighting with a dozen other vehicles. Ruaha is Tanzania's largest national park and one of its most lion-dense; Nyerere, once part of the vast Selous, is explored as much by boat as by road.\n\nThere are no crowds here, no radio chatter between guides, and camps small enough that the whole circuit rarely sees more than a handful of vehicles a day.",
      nights: 6,
      startingPrice: null,
      priceOnRequest: true,
      inclusions: [
        "All park entry and conservation fees",
        "Light aircraft charter flights between camps",
        "Private guide throughout",
        "Full-board luxury tented camps",
        "Boat safaris on the Rufiji River",
        "Guided walking safaris with an armed ranger",
      ],
      exclusions: [
        "International flights to Dar es Salaam",
        "Tanzania visa fees",
        "Travel insurance",
        "Gratuities",
        "Premium spirits and imported wine",
      ],
      travelInfo:
        "Light aircraft charters enforce a strict 15kg limit in soft-sided bags only — no rigid suitcases. Camps in both parks are unfenced; guests are always escorted after dark, which is a normal part of the experience rather than a cause for concern.",
      routeMapUrl: null,
      showRouteMap: true,
      availabilityStatus: AvailabilityStatus.LIMITED,
      days: {
        create: [
          {
            dayNumber: 1,
            title: "Dar es Salaam to Ruaha National Park",
            description:
              "A light aircraft flight west from Dar es Salaam into Ruaha, Tanzania's largest national park, straddling the boundary between eastern and southern African wildlife. Arrive in time for an afternoon game drive along the Great Ruaha River.",
            accommodation: "Ruaha River Lodge",
            activities: ["Bush flight to Ruaha", "Afternoon game drive along the river"],
            latitude: -7.5,
            longitude: 34.6667,
            highlight: false,
          },
          {
            dayNumber: 2,
            title: "Full Day in Ruaha",
            description:
              "Ruaha holds one of East Africa's largest lion populations and a rare overlap of species from both the Serengeti ecosystem and the miombo woodlands further south. A full day of game drives along the riverbanks.",
            accommodation: "Ruaha River Lodge",
            activities: ["Morning game drive", "Riverbank picnic lunch", "Evening game drive"],
            latitude: -7.48,
            longitude: 34.65,
            highlight: true,
          },
          {
            dayNumber: 3,
            title: "Ruaha — Baobab Valley & Walking Safari",
            description:
              "A guided walking safari through Ruaha's baobab valley with an armed ranger, followed by a game drive through some of the park's oldest and largest baobab trees.",
            accommodation: "Ruaha River Lodge",
            activities: ["Guided walking safari", "Baobab valley game drive"],
            latitude: -7.4,
            longitude: 34.75,
            highlight: false,
          },
          {
            dayNumber: 4,
            title: "Ruaha to Nyerere National Park",
            description:
              "A scenic charter flight east to Nyerere National Park, Africa's largest game reserve, where the Rufiji River and its lakes make boat safaris as central to the experience as game drives.",
            accommodation: "Rufiji River Camp",
            activities: ["Scenic flight to Nyerere", "Afternoon boat safari on the Rufiji River"],
            latitude: -7.7667,
            longitude: 37.9333,
            highlight: false,
          },
          {
            dayNumber: 5,
            title: "Nyerere — Boat Safari & Game Drive",
            description:
              "A sunrise boat safari along the Rufiji for hippo pods, crocodiles, and some of the best birdlife in Tanzania, followed by an afternoon game drive through the surrounding woodland.",
            accommodation: "Rufiji River Camp",
            activities: ["Sunrise boat safari", "Afternoon game drive"],
            latitude: -7.8,
            longitude: 37.9,
            highlight: true,
          },
          {
            dayNumber: 6,
            title: "Nyerere — Walking Safari & Fly Camp",
            description:
              "A guided bush walk through Nyerere's woodland with an armed ranger, ending with sundowners on the riverbank as hippos surface for the evening.",
            accommodation: "Rufiji River Camp",
            activities: ["Guided walking safari", "Sundowners on the river"],
            latitude: -7.75,
            longitude: 37.95,
            highlight: false,
          },
          {
            dayNumber: 7,
            title: "Nyerere to Dar es Salaam — Departure",
            description: "A final boat cruise before the charter flight back to Dar es Salaam and onward connections.",
            accommodation: null,
            activities: ["Final boat cruise", "Scenic flight to Dar es Salaam", "Transfer to international airport"],
            latitude: -7.7667,
            longitude: 37.9333,
            highlight: false,
          },
        ],
      },
      images: {
        create: [
          { url: IMG.acaciaSunset.url, altText: IMG.acaciaSunset.alt, sortOrder: 0 },
          { url: IMG.rhinos.url, altText: IMG.rhinos.alt, sortOrder: 1 },
          { url: IMG.kingfisher.url, altText: IMG.kingfisher.alt, sortOrder: 2 },
          { url: IMG.elephantPlains.url, altText: IMG.elephantPlains.alt, sortOrder: 3 },
          { url: IMG.antelopeZebras.url, altText: IMG.antelopeZebras.alt, sortOrder: 4 },
        ],
      },
      destinations: {
        create: [{ destinationId: dest.ruaha!.id }, { destinationId: dest.nyerere!.id }],
      },
      availabilityPeriods: {
        create: [
          {
            startDate: new Date("2026-06-01"),
            endDate: new Date("2026-10-31"),
            status: AvailabilityStatus.AVAILABLE,
            note: "Prime dry season game viewing",
          },
          {
            startDate: new Date("2026-11-01"),
            endDate: new Date("2026-12-31"),
            status: AvailabilityStatus.FULLY_BOOKED,
            note: "High-demand shoulder season — waitlist only",
          },
        ],
      },
    },
    include: { images: true, days: true },
  });

  await setHeroImages(itinerary.id, itinerary.images, [
    { dayNumber: 2, alt: IMG.rhinos.alt },
    { dayNumber: 5, alt: IMG.kingfisher.alt },
  ]);
  console.log(`   + ${title}`);
}

async function setHeroImages(
  itineraryId: string,
  images: { id: string; altText: string | null }[],
  assignments: { dayNumber: number; alt: string }[]
) {
  for (const { dayNumber, alt } of assignments) {
    const image = images.find((i) => i.altText === alt);
    if (!image) continue;
    await prisma.itineraryDay.updateMany({
      where: { itineraryId, dayNumber },
      data: { heroImageId: image.id },
    });
  }
}

main()
  .catch((err) => {
    console.error("❌ Seeding failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
