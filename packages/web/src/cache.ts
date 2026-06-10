const DB_NAME = 'totolo-search';
const DB_VERSION = 3;
const ARTIFACTS_STORE = 'artifacts';
const META_STORE = 'meta';

let db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(ARTIFACTS_STORE);
      req.result.createObjectStore(META_STORE);
    };
    req.onsuccess = () => { db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return openDb().then(d => new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(d => new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readwrite').objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
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

export interface DownloadProgress {
  loaded: number;
  total: number;
  name: string;
}

export async function fetchWithProgress(
  url: string,
  onProgress: (p: DownloadProgress) => void,
  name: string,
): Promise<ArrayBuffer> {
  const resp = await fetch(url);
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
}
