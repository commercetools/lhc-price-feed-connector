import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { logger } from '../utils/logger.utils.js';
import { parseCsv } from './csv.parser.js';

/** One row of the nightly price feed, as an ERP would send it. */
export interface FeedRow {
  sku: string;
  currencyCode: string;
  centAmount: number;
  country?: string;
}

/** A row the feed contained but that cannot be imported — reported, never silently dropped. */
export interface RejectedRow {
  line: number;
  reason: string;
  raw: string;
}

export interface FeedBatch {
  rows: FeedRow[];
  rejected: RejectedRow[];
  /** Where the feed came from, for the logs ("https://…/prices.csv", "file:./samples/prices.csv"). */
  source: string;
  /** sha256 of the feed's bytes — lets the job skip a file it already imported. */
  fingerprint: string;
}

/**
 * Where the feed comes from — an interface, so the job's logic neither knows nor cares.
 *
 * The real one is a **CSV file**, the way ERPs and PIMs actually hand over prices: fetched over HTTPS
 * (an S3 / Azure Blob / GCS object, an SFTP gateway, or a raw file in a Git repo for the course) or read
 * from disk when running locally. The Custom Object source is kept for classrooms with no file host.
 */
export interface FeedSource {
  read(): Promise<FeedBatch>;
}

// ---------------------------------------------------------------- CSV

/**
 * Expected columns (header row required, names case-insensitive, order free, extra columns ignored):
 *
 *   sku, currency, country, amount
 *
 * - `currency` (alias `currencyCode`): ISO 4217, e.g. `EUR`.
 * - `country`: optional ISO 3166-1 alpha-2, e.g. `DE`; empty = a price for every country.
 * - `amount`: a DECIMAL in major units, e.g. `449.00`, which is what an ERP exports. Converted exactly
 *   (string arithmetic, the currency's own fraction digits) to commercetools `centAmount`.
 *   Alternatively a `centAmount` column with integer minor units.
 */
export function rowsFromCsv(text: string): { rows: FeedRow[]; rejected: RejectedRow[] } {
  const doc = parseCsv(text);
  const col = indexColumns(doc.header);
  const missing = ['sku', 'currency'].filter((c) => col[c] === undefined);
  if (col.amount === undefined && col.centAmount === undefined) missing.push('amount (or centAmount)');
  if (missing.length) {
    throw new Error(`The feed's header row is missing: ${missing.join(', ')} (found: ${doc.header.join(', ') || 'nothing'})`);
  }

  const rows: FeedRow[] = [];
  const rejected: RejectedRow[] = [];
  const lineByKey = new Map<string, number>();

  for (const record of doc.records) {
    const get = (name: string) => (col[name] === undefined ? '' : (record.cells[col[name]!] ?? '').trim());
    const raw = record.cells.join(',');
    const reject = (reason: string) => rejected.push({ line: record.line, reason, raw });

    const sku = get('sku');
    const currencyCode = get('currency').toUpperCase();
    const country = get('country').toUpperCase();
    if (!sku) { reject('sku is empty'); continue; }
    if (!/^[A-Z]{3}$/.test(currencyCode)) { reject(`currency "${currencyCode}" is not an ISO 4217 code`); continue; }
    if (country && !/^[A-Z]{2}$/.test(country)) { reject(`country "${country}" is not an ISO 3166-1 alpha-2 code`); continue; }

    let centAmount: number | null;
    if (col.centAmount !== undefined && get('centAmount') !== '') {
      const v = get('centAmount');
      centAmount = /^\d+$/.test(v) ? Number(v) : null;
      if (centAmount === null) { reject(`centAmount "${v}" is not a non-negative integer`); continue; }
    } else {
      const v = get('amount');
      centAmount = decimalToCents(v, currencyCode);
      if (centAmount === null) {
        reject(`amount "${v}" is not a decimal with at most ${fractionDigits(currencyCode)} fraction digits`);
        continue;
      }
    }

    const row: FeedRow = { sku, currencyCode, centAmount, ...(country ? { country } : {}) };
    const key = priceKeyFor(row);
    const earlier = lineByKey.get(key);
    if (earlier !== undefined) {
      // Same price twice in one file: the later line wins, as it would in the ERP. Not a failure.
      logger.warn('Duplicate price in the feed — the later line wins', { priceKey: key, line: record.line, supersedes: earlier });
      rows.splice(rows.findIndex((r) => priceKeyFor(r) === key), 1);
    }
    lineByKey.set(key, record.line);
    rows.push(row);
  }
  return { rows, rejected };
}

function indexColumns(header: string[]): Record<string, number | undefined> {
  const aliases: Record<string, string> = {
    sku: 'sku', currency: 'currency', currencycode: 'currency', country: 'country',
    amount: 'amount', price: 'amount', centamount: 'centAmount',
  };
  const out: Record<string, number | undefined> = {};
  header.forEach((h, i) => {
    const name = aliases[h.toLowerCase().replace(/[\s_-]/g, '')];
    if (name && out[name] === undefined) out[name] = i;
  });
  return out;
}

export function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "449.5" EUR → 44950. Exact (no floating point); rejects negatives, thousands separators and excess digits. */
export function decimalToCents(value: string, currency: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const digits = fractionDigits(currency);
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  return Number(m[1]) * 10 ** digits + Number((frac + '0'.repeat(digits)).slice(0, digits) || '0');
}

export const MAX_FEED_BYTES_DEFAULT = 5 * 1024 * 1024;

export class CsvFeedSource implements FeedSource {
  /**
   * @param location an `https://` URL (deployed) or a file path (local development only)
   * @param authHeader optional `Authorization` header value for a protected file host — secured config
   */
  constructor(
    private readonly location: string,
    private readonly options: { authHeader?: string; timeoutSeconds: number; maxBytes: number }
  ) {}

  async read(): Promise<FeedBatch> {
    const { text, source } = /^https?:\/\//i.test(this.location) ? await this.fetchText() : await this.readFile();
    const fingerprint = createHash('sha256').update(text).digest('hex');
    const { rows, rejected } = rowsFromCsv(text);
    logger.info('Feed read', { source, rows: rows.length, rejected: rejected.length, fingerprint: fingerprint.slice(0, 12) });
    return { rows, rejected, source, fingerprint };
  }

  private async fetchText(): Promise<{ text: string; source: string }> {
    if (!this.location.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.location)) {
      throw new Error('FEED_URL must be https:// (plain http is allowed only for localhost)');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.options.timeoutSeconds * 1000);
    try {
      const res = await fetch(this.location, {
        signal: ac.signal,
        headers: { accept: 'text/csv, text/plain;q=0.9, */*;q=0.1', ...(this.options.authHeader ? { authorization: this.options.authHeader } : {}) },
      });
      if (!res.ok) throw new Error(`Fetching the feed failed: HTTP ${res.status} from ${redact(this.location)}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > this.options.maxBytes) throw new Error(`The feed is ${declared} bytes; the limit is ${this.options.maxBytes} (MAX_FEED_BYTES)`);
      const text = await res.text();
      if (Buffer.byteLength(text) > this.options.maxBytes) throw new Error(`The feed exceeds MAX_FEED_BYTES (${this.options.maxBytes})`);
      return { text, source: redact(this.location) };
    } catch (error) {
      if (ac.signal.aborted) throw new Error(`Fetching the feed timed out after ${this.options.timeoutSeconds}s (FEED_TIMEOUT_SECONDS)`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readFile(): Promise<{ text: string; source: string }> {
    const text = await readFile(this.location, 'utf8');
    if (Buffer.byteLength(text) > this.options.maxBytes) throw new Error(`The feed exceeds MAX_FEED_BYTES (${this.options.maxBytes})`);
    return { text, source: `file:${this.location}` };
  }
}

/** Never log a pre-signed URL's signature. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    return u.search ? `${u.origin}${u.pathname}?…` : `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- Custom Object (no file host available)

export class CustomObjectFeedSource implements FeedSource {
  constructor(
    private readonly apiRoot: ByProjectKeyRequestBuilder,
    private readonly container: string,
    private readonly key: string
  ) {}

  async read(): Promise<FeedBatch> {
    const source = `custom-object:${this.container}/${this.key}`;
    try {
      const { body } = await this.apiRoot
        .customObjects()
        .withContainerAndKey({ container: this.container, key: this.key })
        .get()
        .execute();
      const fingerprint = createHash('sha256').update(JSON.stringify(body.value)).digest('hex');
      const rows = (body.value as { rows?: unknown })?.rows;
      if (!Array.isArray(rows)) {
        logger.warn('Feed document has no `rows` array — treating as empty', { source });
        return { rows: [], rejected: [], source, fingerprint };
      }
      const rejected: RejectedRow[] = [];
      const valid = rows.filter((r, i) => {
        if (isFeedRow(r)) return true;
        rejected.push({ line: i + 1, reason: 'not a { sku, currencyCode, centAmount, country? } row', raw: JSON.stringify(r) });
        return false;
      });
      return { rows: valid, rejected, source, fingerprint };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) {
        logger.info('No feed document today — nothing to import', { source });
        return { rows: [], rejected: [], source, fingerprint: '' };
      }
      throw error;
    }
  }
}

function isFeedRow(value: unknown): value is FeedRow {
  const row = value as FeedRow;
  return (
    typeof row?.sku === 'string' &&
    typeof row?.currencyCode === 'string' &&
    typeof row?.centAmount === 'number' &&
    Number.isInteger(row.centAmount) &&
    row.centAmount >= 0 &&
    (row.country === undefined || typeof row.country === 'string')
  );
}

/**
 * The feed's price key — the identity the Import API upserts on. Same convention the seeder stamps
 * onto the catalogue's prices, which is what makes this an UPDATE rather than an ever-growing pile of
 * new prices the storefront never shows.
 */
export function priceKeyFor(row: FeedRow): string {
  return `${row.sku}-${row.currencyCode}${row.country ? `-${row.country}` : ''}`;
}
