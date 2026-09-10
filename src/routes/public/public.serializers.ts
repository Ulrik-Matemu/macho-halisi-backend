// Explicit field allowlists for anonymous, public consumption of
// PUBLISHED itineraries — used as Prisma `select` clauses, not applied by
// stripping fields off an already-fetched internal object.
//
// This is deliberate: the dashboard's `include` blocks (see
// itineraries.router.ts) pull `authorId`, `editorId`, and the full
// `author`/`editor` relations, which carry staff **email addresses**.
// Selecting explicitly here means a future field added to those dashboard
// includes can never silently leak into the public API — it would have to
// be added to this allowlist on purpose.

export const publicItinerarySummarySelect = {
  id: true,
  title: true,
  slug: true,
  overview: true,
  nights: true,
  startingPrice: true,
  priceOnRequest: true,
  availabilityStatus: true,
  publishedAt: true,
  updatedAt: true,
  images: {
    orderBy: { sortOrder: "asc" as const },
    take: 1,
    select: { id: true, url: true, altText: true },
  },
  destinations: {
    select: {
      destination: { select: { id: true, name: true, slug: true } },
    },
  },
} as const;

export const publicItineraryDetailSelect = {
  id: true,
  title: true,
  slug: true,
  status: true,
  overview: true,
  nights: true,
  startingPrice: true,
  priceOnRequest: true,
  inclusions: true,
  exclusions: true,
  travelInfo: true,
  routeMapUrl: true,
  availabilityStatus: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  days: {
    orderBy: { dayNumber: "asc" as const },
    select: {
      id: true,
      dayNumber: true,
      title: true,
      description: true,
      accommodation: true,
      activities: true,
    },
  },
  images: {
    orderBy: { sortOrder: "asc" as const },
    select: { id: true, url: true, altText: true, sortOrder: true },
  },
  destinations: {
    select: {
      destination: { select: { id: true, name: true, slug: true } },
    },
  },
  // Detail-page-only supplementary calendar detail — deliberately not on
  // publicItinerarySummarySelect above, so the list/card endpoint never
  // carries it.
  availabilityPeriods: {
    orderBy: { startDate: "asc" as const },
    select: { id: true, startDate: true, endDate: true, status: true, note: true },
  },
} as const;
