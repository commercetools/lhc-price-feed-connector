import type { ByProjectKeyRequestBuilder as ImportApiRoot } from '@commercetools/importapi-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { logger } from '../utils/logger.utils.js';
import { priceKeyFor, type FeedRow } from './feed.service.js';

/** The Import API accepts at most 20 resources per request. */
export const MAX_ROWS_PER_REQUEST = 20;

export interface RowOutcome {
  sku: string;
  priceKey: string;
  state: string;
  errors: string[];
}

export interface ImportReport {
  containerKey: string;
  total: number;
  imported: number;
  failed: number;
  pending: number;
  rows: RowOutcome[];
}

const TERMINAL_FAILURE = new Set(['validationFailed', 'rejected', 'canceled']);

/**
 * Resolve each SKU to the KEYS the Import API identifies by.
 *
 * The Import API does not know about SKUs: a PriceImport names its product and variant by `key`, and
 * upserts the price by the price's own `key`. Get this wrong and the import silently ADDS prices the
 * storefront never selects, instead of updating the ones it shows.
 */
export async function resolveKeys(
  apiRoot: ByProjectKeyRequestBuilder,
  skus: string[]
): Promise<Map<string, { productKey: string; variantKey: string }>> {
  const resolved = new Map<string, { productKey: string; variantKey: string }>();
  if (skus.length === 0) return resolved;

  const { body } = await apiRoot
    .productProjections()
    .get({
      queryArgs: {
        where: `masterVariant(sku in (${skus.map(quote).join(',')})) or variants(sku in (${skus.map(quote).join(',')}))`,
        limit: 500,
      },
    })
    .execute();

  for (const product of body.results) {
    if (!product.key) continue;
    for (const variant of [product.masterVariant, ...(product.variants ?? [])]) {
      if (variant?.sku && skus.includes(variant.sku)) {
        // The seeder stamps variant key = SKU; fall back to that convention when the key is absent.
        resolved.set(variant.sku, { productKey: product.key, variantKey: variant.key ?? variant.sku });
      }
    }
  }
  return resolved;
}

/** Submit the feed in batches, then poll until every operation settles (or the budget runs out). */
export async function importPrices(
  importApiRoot: ImportApiRoot,
  containerKey: string,
  rows: FeedRow[],
  keys: Map<string, { productKey: string; variantKey: string }>,
  poll: { timeoutSeconds: number; intervalSeconds: number; sleep?: (ms: number) => Promise<void> }
): Promise<ImportReport> {
  const unresolved: RowOutcome[] = [];
  const submittable: FeedRow[] = [];

  for (const row of rows) {
    if (keys.has(row.sku)) submittable.push(row);
    else
      unresolved.push({
        sku: row.sku,
        priceKey: priceKeyFor(row),
        state: 'validationFailed',
        errors: [`No product variant with SKU ${row.sku} exists in this Project.`],
      });
  }

  for (const batch of chunk(submittable, MAX_ROWS_PER_REQUEST)) {
    const resources = batch.map((row) => {
      const key = keys.get(row.sku)!;
      return {
        key: priceKeyFor(row),
        product: { typeId: 'product' as const, key: key.productKey },
        productVariant: { typeId: 'product-variant' as const, key: key.variantKey },
        value: {
          type: 'centPrecision' as const,
          currencyCode: row.currencyCode,
          centAmount: row.centAmount,
        },
        ...(row.country ? { country: row.country } : {}),
        // false writes the CURRENT projection, which is what the storefront reads. Omitting this
        // stages the change and the PLP never sees it — a silent no-op that looks like success.
        staged: false,
      };
    });

    await importApiRoot
      .prices()
      .importContainers()
      .withImportContainerKeyValue({ importContainerKey: containerKey })
      .post({ body: { type: 'price', resources } })
      .execute();
    logger.info('Batch submitted', { containerKey, rows: resources.length });
  }

  // A 2xx from the Import API is an ACKNOWLEDGEMENT, not a result: the work happens asynchronously and
  // the ImportOperations carry the outcome. A job that stops at the 2xx reports success it cannot know.
  const settled = await pollOperations(importApiRoot, containerKey, submittable.map(priceKeyFor), poll);
  return report(containerKey, [...unresolved, ...settled]);
}

async function pollOperations(
  importApiRoot: ImportApiRoot,
  containerKey: string,
  expectedKeys: string[],
  poll: { timeoutSeconds: number; intervalSeconds: number; sleep?: (ms: number) => Promise<void> }
): Promise<RowOutcome[]> {
  if (expectedKeys.length === 0) return [];
  const sleep = poll.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + poll.timeoutSeconds * 1000;
  let outcomes: RowOutcome[] = [];

  for (;;) {
    const { body } = await importApiRoot
      .importContainers()
      .withImportContainerKeyValue({ importContainerKey: containerKey })
      .importOperations()
      .get({ queryArgs: { limit: 200 } })
      .execute();

    outcomes = body.results
      .filter((op) => op.resourceKey && expectedKeys.includes(op.resourceKey))
      .map((op) => ({
        sku: skuFromPriceKey(op.resourceKey),
        priceKey: op.resourceKey,
        state: String(op.state),
        errors: (op.errors ?? []).map((e) => e.message ?? String(e.code)),
      }));

    const stillRunning = outcomes.filter((o) => o.state === 'processing' || o.state === 'unresolved');
    if (outcomes.length >= expectedKeys.length && stillRunning.length === 0) return outcomes;
    if (Date.now() >= deadline) {
      logger.warn('Poll budget exhausted; reporting what has settled', {
        settled: outcomes.length - stillRunning.length,
        stillRunning: stillRunning.length,
      });
      return outcomes;
    }
    await sleep(poll.intervalSeconds * 1000);
  }
}

export function report(containerKey: string, rows: RowOutcome[]): ImportReport {
  const imported = rows.filter((r) => r.state === 'imported').length;
  const failed = rows.filter((r) => TERMINAL_FAILURE.has(r.state)).length;
  return { containerKey, total: rows.length, imported, failed, pending: rows.length - imported - failed, rows };
}

/** `CARM-023-EUR-DE` -> `CARM-023`. Drops the currency, and the country when one is present. */
export function skuFromPriceKey(key: string): string {
  const parts = key.split('-');
  const drop = parts.length >= 3 && parts[parts.length - 1]!.length === 2 ? 2 : 1;
  return parts.length <= drop ? key : parts.slice(0, parts.length - drop).join('-');
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
