/**
 * Which destination catalog entries (keys of DESTINATIONS in
 * seed-client-packages.ts) an itinerary actually visits, judged from its
 * own day titles and descriptions. The "Destinations visited" summary on
 * the public site comes from these links, so it has to agree with the
 * daily programme — not only with the overnight stops.
 */
export const PLACE_PATTERNS: [key: string, pattern: RegExp][] = [
  ["tarangire", /Tarangire/],
  ["ngorongoro", /Ngorongoro/],
  ["eyasi", /Lake Eyasi/],
  ["natron", /Lake Natron/],
  ["arusha_np", /Arusha National Park/],
  ["serengeti", /Serengeti/],
  ["kili", /Marangu Gate|Mandara Hut|Uhuru Peak/],
  ["zanzibar", /Zanzibar/],
];

export function placesVisited(days: { title: string; description: string }[]): string[] {
  const keys = new Set<string>();
  for (const day of days) {
    const text = `${day.title} ${day.description}`;
    for (const [key, pattern] of PLACE_PATTERNS) if (pattern.test(text)) keys.add(key);
  }
  return [...keys];
}
