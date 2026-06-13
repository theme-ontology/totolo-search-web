const DB_NAME = 'totolo-search';
const DB_VERSION = 3;
const ARTIFACTS_STORE = 'artifacts';
const META_STORE = 'meta';

let db: IDBDatabase | null = null;

// IndexedDB can be unavailable (private browsing in Safari/Firefox, storage
// restrictions). All cache operations degrade to no-ops instead of failing the app.
let cacheAvailable = true;
let warned = false;

function cacheUnavailable(err: unknown) {
  cacheAvailable = false;
  if (!warned) {
    warned = true;
    console.warn('IndexedDB unavailable — artifact caching disabled:', err);
  }
}

function openDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(ARTIFACTS_STORE);
      req.result.createObjectStore(META_STORE);
    };
    req.onsuccess = () => { db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  if (!cacheAvailable) return undefined;
  try {
    const d = await openDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = d.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    cacheUnavailable(err);
    return undefined;
  }
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  if (!cacheAvailable) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = d.transaction(store, 'readwrite').objectStore(store).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    cacheUnavailable(err);
  }
}

export async function getCachedVersionKey(): Promise<string | undefined> {
  return idbGet<string>(META_STORE, 'version_key');
}

export async function setCachedVersionKey(key: string): Promise<void> {
  return idbPut(META_STORE, 'version_key', key);
}

export async function getCachedArtifact(name: string): Promise<ArrayBuffer | string | undefined> {
  return idbGet<ArrayBuffer | string>(ARTIFACTS_STORE, name);
}

export async function setCachedArtifact(name: string, data: ArrayBuffer | string): Promise<void> {
  return idbPut(ARTIFACTS_STORE, name, data);
}

export async function deleteCachedArtifact(name: string): Promise<void> {
  if (!cacheAvailable) return;
  try {
    const d = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = d.transaction(ARTIFACTS_STORE, 'readwrite').objectStore(ARTIFACTS_STORE).delete(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    cacheUnavailable(err);
  }
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  name: string;
}

// Aborts only when no bytes arrive for `stallTimeoutMs` — slow but live
// connections keep going; a dead one fails fast enough to show Retry.
export async function fetchWithProgress(
  url: string,
  onProgress: (p: DownloadProgress) => void,
  name: string,
  stallTimeoutMs = 30_000,
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`Download stalled: ${name}`)), stallTimeoutMs);
  };

  armStall();
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) throw new Error(`Expected file but got HTML (is the path correct?): ${url}`);

    const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10);
    const reader = resp.body!.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      chunks.push(value);
      loaded += value.length;
      onProgress({ loaded, total: contentLength || loaded, name });
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.length;
    }
    return buf.buffer;
  } finally {
    if (stallTimer !== null) clearTimeout(stallTimer);
  }
}
