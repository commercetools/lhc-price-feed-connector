/**
 * Fail fast, at startup, on missing configuration — never at the first request, when the caller is a
 * shopper's cart write and the symptom is a 502 nobody can explain.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return value.trim();
}

export function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Configuration ${key} must be a number, got "${raw}"`);
  return parsed;
}
