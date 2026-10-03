/**
 * Browser storage helpers.
 *
 * A 200-image 2K run is hundreds of megabytes of generated PNGs sitting in
 * IndexedDB. Two things matter:
 *
 *  1. `navigator.storage.persist()` — ask the browser not to evict us. Without
 *     it, a "best effort" origin can have its storage cleared under disk
 *     pressure, taking an hour of generation with it.
 *  2. `navigator.storage.estimate()` — know the quota up front so we can warn
 *     before a batch is bigger than the space available.
 */

let persistPromise = null;

export function requestPersistence() {
  if (persistPromise) return persistPromise;
  persistPromise = (async () => {
    try {
      if (!navigator.storage?.persist) return { supported: false, persisted: false };
      if (await navigator.storage.persisted?.()) return { supported: true, persisted: true };
      const persisted = await navigator.storage.persist();
      return { supported: true, persisted };
    } catch {
      return { supported: false, persisted: false };
    }
  })();
  return persistPromise;
}

export async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, free: Math.max(0, quota - usage) };
  } catch {
    return null;
  }
}

export function formatQuota(bytes) {
  if (!bytes && bytes !== 0) return 'unknown';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
