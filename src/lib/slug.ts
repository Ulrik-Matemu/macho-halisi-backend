import { prisma } from "../db/prisma.js";

/**
 * Basic slugify function to normalize a title into a URL-friendly slug.
 */
export function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .normalize("NFD") // separate accent marks from letters
    .replace(/[\u0300-\u036f]/g, "") // remove accent marks
    .replace(/[^a-z0-9\s-]/g, "") // remove non-alphanumeric except whitespace and hyphens
    .replace(/[\s_-]+/g, "-") // collapse whitespace/underscores into single hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}

/**
 * Generates a unique slug for an Itinerary.
 * If the slug collides with an existing record (other than currentItineraryId),
 * a numeric suffix is appended: e.g. "safari-adventure-1", "safari-adventure-2".
 */
export async function generateUniqueItinerarySlug(
  title: string,
  currentItineraryId?: string
): Promise<string> {
  const baseSlug = slugify(title) || "itinerary";
  let candidateSlug = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await prisma.itinerary.findUnique({
      where: { slug: candidateSlug },
      select: { id: true },
    });

    if (!existing || existing.id === currentItineraryId) {
      return candidateSlug;
    }

    candidateSlug = `${baseSlug}-${counter}`;
    counter++;
  }
}

/**
 * Generates a unique slug for a Destination.
 * If the slug collides with an existing record (other than currentDestinationId),
 * a numeric suffix is appended: e.g. "serengeti-1", "serengeti-2".
 */
export async function generateUniqueDestinationSlug(
  name: string,
  currentDestinationId?: string
): Promise<string> {
  const baseSlug = slugify(name) || "destination";
  let candidateSlug = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await prisma.destination.findUnique({
      where: { slug: candidateSlug },
      select: { id: true },
    });

    if (!existing || existing.id === currentDestinationId) {
      return candidateSlug;
    }

    candidateSlug = `${baseSlug}-${counter}`;
    counter++;
  }
}

