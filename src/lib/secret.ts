import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison for shared-secret headers. */
export function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
