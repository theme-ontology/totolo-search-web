import { pipeline } from '@huggingface/transformers';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 64;
export const EMBED_DIMS = 384;

// The transformers pipeline return type is a union too complex for tsc to represent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = any;

let extractor: Extractor | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractor) {
    console.log(`Loading embedding model: ${EMBED_MODEL}`);
    extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' });
    console.log('Embedding model loaded.');
  }
  return extractor;
}

export async function embedTexts(texts: string[]): Promise<Float32Array> {
  const ext = await getExtractor();
  const allVecs: Float32Array[] = [];

  const LOG_INTERVAL_MS = 30_000;
  let lastLog = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const output = await ext(batch, { pooling: 'mean', normalize: true });

    // output.data is Float32Array of shape [batch * dims]
    const data = output.data as Float32Array;
    allVecs.push(data);

    const done = Math.min(i + BATCH_SIZE, texts.length);
    const now = Date.now();
    // Log at most every 30s (plus the final batch) to keep CI logs readable.
    if (now - lastLog >= LOG_INTERVAL_MS || done === texts.length) {
      console.log(`  Embedding ${done}/${texts.length}...`);
      lastLog = now;
    }
  }

  const total = texts.length * EMBED_DIMS;
  const result = new Float32Array(total);
  let offset = 0;
  for (const vec of allVecs) {
    result.set(vec, offset);
    offset += vec.length;
  }
  return result;
}

export function packEmbeddings(embeddings: Float32Array, nDocs: number): Buffer {
  const buf = Buffer.alloc(8 + nDocs * EMBED_DIMS * 4);
  buf.writeUInt32LE(nDocs, 0);
  buf.writeUInt32LE(EMBED_DIMS, 4);
  const floatView = new Float32Array(buf.buffer, buf.byteOffset + 8, nDocs * EMBED_DIMS);
  floatView.set(embeddings);
  return buf;
}
