import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { logger } from '../utils/logger.utils.js';

/**
 * What the last run imported, kept next to the lock in the feed's Custom Object container.
 *
 * A nightly job reading a file that only changes when someone edits it would otherwise re-submit the
 * same prices every night. Re-importing is SAFE (the Import API upserts by key), just wasteful and noisy,
 * so a run whose file is byte-identical to the last fully successful one stands down.
 */
export const LAST_RUN_KEY = 'last-run';

export interface LastRun {
  fingerprint: string;
  source: string;
  finishedAt: string;
  imported: number;
  failed: number;
}

export async function readLastRun(apiRoot: ByProjectKeyRequestBuilder, container: string): Promise<LastRun | undefined> {
  try {
    const { body } = await apiRoot.customObjects().withContainerAndKey({ container, key: LAST_RUN_KEY }).get().execute();
    return body.value as LastRun;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
}

export async function recordLastRun(apiRoot: ByProjectKeyRequestBuilder, container: string, run: LastRun): Promise<void> {
  try {
    // No version: last writer wins, which is right for a record only one (locked) run ever writes.
    await apiRoot.customObjects().post({ body: { container, key: LAST_RUN_KEY, value: run } }).execute();
  } catch (error) {
    // Bookkeeping must never turn a successful import into a failed run.
    logger.warn('Could not record the run — tomorrow will re-import the same file (harmless)', {
      reason: (error as Error).message,
    });
  }
}

/** Skip only when the file is identical AND that earlier run fully succeeded. */
export function isUnchanged(last: LastRun | undefined, fingerprint: string): boolean {
  return Boolean(last && fingerprint && last.fingerprint === fingerprint && last.failed === 0);
}
