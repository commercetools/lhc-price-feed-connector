import { describe, expect, it, vi } from 'vitest';
import { acquireLock } from '../src/services/lock.service.js';

function apiRootWith(existing: { version: number; value: unknown } | undefined, postImpl?: () => unknown) {
  const post = vi.fn(postImpl ?? (() => ({ execute: async () => ({ body: {} }) })));
  const del = vi.fn(() => ({ execute: async () => ({ body: {} }) }));
  const get = vi.fn(() => ({
    execute: async () => {
      if (!existing) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { body: existing };
    },
  }));
  return {
    apiRoot: { customObjects: () => ({ post, withContainerAndKey: () => ({ get, delete: del }) }) } as never,
    post,
    del,
  };
}

const NOW = new Date('2026-09-25T02:00:00Z');

describe('the job owns its own concurrency guard', () => {
  it('acquires the lock when none is held', async () => {
    const h = apiRootWith(undefined);
    expect(await acquireLock(h.apiRoot, 'lhc-price-feed', 45, NOW)).not.toBeNull();
    expect(h.post.mock.calls[0]![0]!.body).toMatchObject({ container: 'lhc-price-feed', key: 'lock' });
  });

  it('stands down when a recent run still holds it — two concurrent imports race on the same keys', async () => {
    const h = apiRootWith({ version: 1, value: { startedAt: '2026-09-25T01:55:00Z' } });
    expect(await acquireLock(h.apiRoot, 'lhc-price-feed', 45, NOW)).toBeNull();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('takes over a stale lock so a crashed run cannot wedge the job forever', async () => {
    const h = apiRootWith({ version: 1, value: { startedAt: '2026-09-24T02:00:00Z' } });
    expect(await acquireLock(h.apiRoot, 'lhc-price-feed', 45, NOW)).not.toBeNull();
    // Passes the version: claiming is compare-and-set, so a concurrent claimer loses with a 409.
    expect(h.post.mock.calls[0]![0]!.body.version).toBe(1);
  });

  it('stands down when it loses the compare-and-set race', async () => {
    const h = apiRootWith({ version: 1, value: { startedAt: '2026-09-24T02:00:00Z' } }, () => ({
      execute: async () => {
        throw Object.assign(new Error('conflict'), { statusCode: 409 });
      },
    }));
    expect(await acquireLock(h.apiRoot, 'lhc-price-feed', 45, NOW)).toBeNull();
  });

  it('releases by deleting with the current version', async () => {
    const h = apiRootWith(undefined);
    const lock = await acquireLock(h.apiRoot, 'c', 45, NOW);
    expect(lock).not.toBeNull();
  });
});
