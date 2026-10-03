/**
 * Tiny promise wrapper over IndexedDB.
 *
 * We persist reference images and generated results here so a 200-image run
 * survives a page refresh, an accidental tab close or a crash.
 */

const DB_NAME = 'styleforge-bulk';
const DB_VERSION = 1;
const STORES = ['refs', 'results', 'meta'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'results') store.createIndex('order', 'order', { unique: false });
          if (name === 'refs') store.createIndex('order', 'order', { unique: false });
        }
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        try {
          out = fn(s);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
      }),
  );
}

export const idb = {
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  putAll: (store, values) =>
    tx(store, 'readwrite', (s) => {
      values.forEach((v) => s.put(v));
    }),
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  count: (store) => tx(store, 'readonly', (s) => s.count()),
  async clearAll() {
    await Promise.all(STORES.map((name) => idb.clear(name).catch(() => {})));
  },
};

export const STORE_NAMES = { REFS: 'refs', RESULTS: 'results', META: 'meta' };
