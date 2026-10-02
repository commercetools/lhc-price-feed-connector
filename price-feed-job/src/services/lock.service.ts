import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { logger } from '../utils/logger.utils.js';

/**
 * A job has NO concurrency guard from the platform — the scheduler will happily start tonight's run
 * while last night's is still going, and two concurrent price imports racing on the same keys is a
 * genuinely bad time. Locking is yours to own.
 *
 * A Custom Object with optimistic concurrency is enough: the `version` makes "claim the lock" a single
 * atomic operation, so two runs starting together cannot both win. A stale lock (a run that crashed
 * without releasing) expires, so a bad night does not wedge the job forever.
 */
export const LOCK_KEY_SUFFIX = 'lock';

export interface Lock {
  release(): Promise<void>;
}

export async function acquireLock(
  apiRoot: ByProjectKeyRequestBuilder,
  container: string,
  staleMinutes: number,
  now: Date = new Date()
): Promise<Lock | null> {
  const key = LOCK_KEY_SUFFIX;
  const existing = await read(apiRoot, container, key);

  if (existing) {
    const startedAt = Date.parse(String((existing.value as { startedAt?: string })?.startedAt ?? ''));
    const ageMinutes = Number.isNaN(startedAt) ? Infinity : (now.getTime() - startedAt) / 60_000;
    if (ageMinutes < staleMinutes) {
      logger.warn('Another run holds the lock — standing down', {
        heldForMinutes: Math.round(ageMinutes),
        staleAfterMinutes: staleMinutes,
      });
      return null;
    }
    logger.warn('Taking over a stale lock — the previous run did not release it', {
      heldForMinutes: Math.round(ageMinutes),
    });
  }

  try {
    await apiRoot
      .customObjects()
      .post({
        body: {
          container,
          key,
          value: { startedAt: now.toISOString() },
          // The version makes this a compare-and-set: if another run claimed the lock between our read
          // and this write, the platform rejects us with a 409 and that run keeps it.
          ...(existing ? { version: existing.version } : {}),
        },
      })
      .execute();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) {
      logger.warn('Lost the race for the lock to a concurrent run — standing down');
      return null;
    }
    throw error;
  }

  return {
    async release() {
      const current = await read(apiRoot, container, key);
      if (!current) return;
      await apiRoot
        .customObjects()
        .withContainerAndKey({ container, key })
        .delete({ queryArgs: { version: current.version } })
        .execute()
        .catch((error: unknown) => {
          // Releasing is best-effort: a lock we fail to delete simply expires. Never fail a successful
          // run because the cleanup did.
          logger.warn('Could not release the lock — it will expire', { reason: (error as Error).message });
        });
    },
  };
}

async function read(apiRoot: ByProjectKeyRequestBuilder, container: string, key: string) {
  try {
    const { body } = await apiRoot.customObjects().withContainerAndKey({ container, key }).get().execute();
    return body;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
}
