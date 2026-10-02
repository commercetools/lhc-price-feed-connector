import { numberEnv, optionalEnv, requireEnv } from '../validators/env.validators.js';
import { MAX_FEED_BYTES_DEFAULT } from '../services/feed.service.js';

export type FeedSourceKind = 'csv' | 'custom-object';

export interface Configuration {
  projectKey: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  authUrl: string;
  importUrl: string;
  scopes?: string[];
  importContainerKey: string;
  /** `csv` (default): a CSV file at FEED_URL. `custom-object`: `{ rows: [...] }` in FEED_CONTAINER/FEED_KEY. */
  feedSource: FeedSourceKind;
  /** https:// URL of the CSV (deployed), or a file path (local development). */
  feedUrl?: string;
  /** Optional `Authorization` header value for a protected file host (secured configuration). */
  feedAuthHeader?: string;
  feedTimeoutSeconds: number;
  maxFeedBytes: number;
  /** Custom Object container for the run lock and the last-run record (and the feed doc, for `custom-object`). */
  feedContainer: string;
  feedKey: string;
  /** Skip a run whose file is byte-identical to the last fully successful import. */
  skipUnchangedFeed: boolean;
  /** Read, validate and resolve keys, then report — submit nothing. */
  dryRun: boolean;
  /** A run that started less than this ago is assumed still alive; this one stands down. */
  lockStaleMinutes: number;
  /** How long to wait for every ImportOperation to settle before reporting what is still pending. */
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
}

let cached: Configuration | undefined;

const bool = (key: string, fallback: boolean) => {
  const v = optionalEnv(key, String(fallback)).toLowerCase();
  if (!['true', 'false'].includes(v)) throw new Error(`Configuration ${key} must be true or false, got "${v}"`);
  return v === 'true';
};

export function readConfiguration(): Configuration {
  if (cached) return cached;
  const apiUrl = requireEnv('CTP_API_URL');
  const scope = process.env.CTP_SCOPE;
  const feedSource = optionalEnv('FEED_SOURCE', 'csv') as FeedSourceKind;
  if (!['csv', 'custom-object'].includes(feedSource)) {
    throw new Error(`Configuration FEED_SOURCE must be csv or custom-object, got "${feedSource}"`);
  }
  const feedUrl = process.env.FEED_URL?.trim() || undefined;
  // Fail at startup, not at 02:00: a CSV job with nowhere to read from is a misconfiguration.
  if (feedSource === 'csv' && !feedUrl) throw new Error('Missing required configuration: FEED_URL (FEED_SOURCE=csv)');
  const feedAuthHeader = process.env.FEED_AUTH_HEADER?.trim() || undefined;

  cached = {
    projectKey: requireEnv('CTP_PROJECT_KEY'),
    clientId: requireEnv('CTP_CLIENT_ID'),
    clientSecret: requireEnv('CTP_CLIENT_SECRET'),
    apiUrl,
    authUrl: requireEnv('CTP_AUTH_URL'),
    // The Import API is a separate service on its own host. Derive it from the API URL so one region
    // setting drives everything, but allow an override.
    importUrl: optionalEnv('CTP_IMPORT_URL', apiUrl.replace('://api.', '://import.')),
    ...(scope ? { scopes: scope.split(' ').filter(Boolean) } : {}),
    importContainerKey: optionalEnv('IMPORT_CONTAINER_KEY', 'lhc-price-feed'),
    feedSource,
    ...(feedUrl ? { feedUrl } : {}),
    ...(feedAuthHeader ? { feedAuthHeader } : {}),
    feedTimeoutSeconds: numberEnv('FEED_TIMEOUT_SECONDS', 30),
    maxFeedBytes: numberEnv('MAX_FEED_BYTES', MAX_FEED_BYTES_DEFAULT),
    feedContainer: optionalEnv('FEED_CONTAINER', 'lhc-price-feed'),
    feedKey: optionalEnv('FEED_KEY', 'pending'),
    skipUnchangedFeed: bool('SKIP_UNCHANGED_FEED', true),
    dryRun: bool('DRY_RUN', false),
    lockStaleMinutes: numberEnv('LOCK_STALE_MINUTES', 45),
    pollTimeoutSeconds: numberEnv('POLL_TIMEOUT_SECONDS', 120),
    pollIntervalSeconds: numberEnv('POLL_INTERVAL_SECONDS', 5),
  };
  return cached;
}

export function resetConfiguration(): void {
  cached = undefined;
}
