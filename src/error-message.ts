/**
 * Readable message of anything thrown or rejected. JavaScript can throw non-Error values
 * (strings, plain objects from some libraries), where `(err as Error).message` logs
 * `undefined`.
 */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
