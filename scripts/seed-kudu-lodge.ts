import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AccommodationType, ItineraryStatus, Role, ServiceTier } from "@prisma/client";
import { prisma } from "../src/db/prisma.js";
import { generateUniqueAccommodationSlug } from "../src/lib/slug.js";
import { updateAccommodationSchema } from "../src/routes/accommodations/accommodations.schemas.js";

/**
 * Loads the client's "About Kudu Lodge" content (scripts/data/kudu-lodge.json)
 * onto the Kudu Lodge accommodation. Only fields the client document covers
 * are written; tier, stars, price, coordinates, images, hero and status are
 * never touched.
 *
 * Finds the row by --slug=<slug>, otherwise by a name containing "kudu". If
 * there is no row it creates a DRAFT, which needs --tier=BUDGET|MID_RANGE|
 * PREMIUM|LUXURY because serviceTier is required and the document doesn't
 * state one.
 *
 * A PUBLISHED row is not edited live: the content is staged as an
 * AccommodationRevision so an admin reviews it via "Publish changes" in the
 * dashboard. Pass --direct to write straight to the live row instead.
 *
 * Idempotent. The previous values are saved to scripts/data/backups/ before
 * any write.
 *
 * Run with: npx tsx scripts/seed-kudu-lodge.ts [--slug=..] [--tier=..] [--direct]
 *
 * Against any non-local database (e.g. production on Render) it runs as a
 * DRY RUN that only reports the diff. Add --confirm-production to write.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONTENT_FIELDS = [
  "description",
  "amenities",
  "tagline",
  "elevationMeters",
  "maxGuests",
  "spaces",
  "nearbyPlaces",
  "activities",
] as const;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function main() {
  const dryRun = !isLocalDatabase() && !process.argv.includes("--confirm-production");
  const direct = process.argv.includes("--direct");
  const host = new URL(process.env.DATABASE_URL ?? "postgresql://unknown").hostname;
  console.log(`Database: ${host}${dryRun ? " (DRY RUN — pass --confirm-production to write)" : ""}`);

  const raw = JSON.parse(readFileSync(join(__dirname, "data", "kudu-lodge.json"), "utf8"));
  const { name, locationText, ...rest } = raw;
  // Same schema the API validates against, so a bad content file fails here
  // rather than leaving a revision that can't be published.
  const content = updateAccommodationSchema.parse(rest);

  const slugArg = arg("slug");
  const matches = await prisma.accommodation.findMany({
    where: slugArg ? { slug: slugArg } : { name: { contains: "kudu", mode: "insensitive" } },
  });
  if (matches.length > 1) {
    console.error("Several accommodations match — re-run with --slug=<slug>:");
    for (const m of matches) console.error(`  ${m.slug}  (${m.name}, ${m.status})`);
    process.exit(1);
  }
  const existing = matches[0];

  if (!existing) {
    const tier = arg("tier") as ServiceTier | undefined;
    if (!tier || !(tier in ServiceTier)) {
      console.error("No Kudu Lodge row found. To create a DRAFT, pass --tier=BUDGET|MID_RANGE|PREMIUM|LUXURY.");
      process.exit(1);
    }
    const author = await prisma.user.findFirst({ where: { role: Role.ADMIN, isActive: true } });
    if (!author) throw new Error("No active ADMIN user to author the accommodation");
    console.log(`Would create DRAFT "${name}" (${tier}) with ${CONTENT_FIELDS.length} content fields.`);
    if (dryRun) return;
    const created = await prisma.accommodation.create({
      data: {
        name,
        slug: await generateUniqueAccommodationSlug(name),
        status: ItineraryStatus.DRAFT,
        authorId: author.id,
        type: AccommodationType.LODGE,
        serviceTier: tier,
        locationText,
        priceOnRequest: true,
        ...(content as object),
      },
    });
    console.log(`Created ${created.slug} (DRAFT).`);
    return;
  }

  console.log(`Found: ${existing.slug} (${existing.name}, ${existing.status})`);

  const changed = CONTENT_FIELDS.filter((f) => !same(existing[f], (content as any)[f]));
  if (changed.length === 0) {
    console.log("Already up to date — nothing to do.");
    return;
  }
  for (const f of changed) {
    console.log(`  ~ ${f}: ${JSON.stringify(existing[f] ?? null).slice(0, 70)} -> ${JSON.stringify((content as any)[f]).slice(0, 70)}`);
  }

  const staged = existing.status === ItineraryStatus.PUBLISHED && !direct;
  console.log(staged ? "Published row: will stage as a pending revision for admin review." : "Will write directly to the row.");
  if (dryRun) return;

  mkdirSync(join(__dirname, "data", "backups"), { recursive: true });
  const backup = join(__dirname, "data", "backups", `kudu-${existing.slug}-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify(Object.fromEntries(CONTENT_FIELDS.map((f) => [f, existing[f]])), null, 2));
  console.log(`Backup: ${backup}`);

  const patch = Object.fromEntries(changed.map((f) => [f, (content as any)[f]]));
  if (staged) {
    const editor = await prisma.user.findFirst({ where: { role: Role.ADMIN, isActive: true } });
    if (!editor) throw new Error("No active ADMIN user to attribute the revision to");
    const pending = await prisma.accommodationRevision.findUnique({ where: { accommodationId: existing.id } });
    // Merge over any edit already awaiting review rather than clobbering it.
    const data = { ...((pending?.data as object | null) ?? {}), ...patch };
    await prisma.accommodationRevision.upsert({
      where: { accommodationId: existing.id },
      create: { accommodationId: existing.id, data, editorId: editor.id },
      update: { data, editorId: editor.id },
    });
    console.log("Staged. An admin can review and apply it with 'Publish changes' in the dashboard.");
  } else {
    await prisma.accommodation.update({ where: { id: existing.id }, data: patch });
    console.log("Updated.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
