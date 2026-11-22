// Small helpers shared by bridge/, zalo/, matrix/ and tools/. Kept at the src root, next to
// error-message.ts, so zalo/ can use them without importing from bridge/.

/** Loosely typed JSON object, as Zalo payloads arrive. */
export type Loose = Record<string, unknown>;

/** Resolves after `ms` milliseconds (works with fake timers). */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True for a plain object; arrays and null are not records. */
export const isRecord = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value as an object, or null. Arrays pass: callers only read named keys from them. */
export const asRecord = (value: unknown): Loose | null =>
  typeof value === 'object' && value !== null ? (value as Loose) : null;

/** Zalo ids arrive as strings or numbers; anything else (or an empty string) is no id. */
export const asId = (value: unknown): string | undefined =>
  (typeof value === 'string' && value !== '') || typeof value === 'number' ? String(value) : undefined;

/**
 * Zalo `params` (and a template's `msg`): zca-js parses some events and leaves others as a
 * JSON string, so both shapes reach us.
 *
 * @returns the object, or null when absent, malformed or not an object. Callers whose fields
 *   are all optional use `parseParams(x) ?? {}`.
 */
export function parseParams(params: unknown): Loose | null {
  if (typeof params !== 'string') return asRecord(params);
  try {
    return asRecord(JSON.parse(params));
  } catch {
    return null;
  }
}

/** True for an http(s) URL (Zalo also uses placeholders like "www.zaloapp.com"). */
export const isHttpUrl = (url: string): boolean => /^https?:\/\//.test(url);

/** Joins the non-blank parts with newlines (undefined and whitespace-only parts are skipped). */
export const joinLines = (...parts: Array<string | undefined>): string =>
  parts.filter((part) => part && part.trim()).join('\n');

/** Positive numeric value (number or numeric string); undefined for 0, negatives and non-numbers. */
export const positiveNumber = (value: unknown): number | undefined => (Number(value) > 0 ? Number(value) : undefined);
