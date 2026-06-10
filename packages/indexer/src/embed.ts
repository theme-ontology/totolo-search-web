import { pipeline } from '@huggingface/transformers';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 64;
export const EMBED_DIMS = 384;

type Extractor = Awaited<ReturnType<typeof pipeline>>;

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

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    process.stdout.write(`\r  Embedding ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}...`);

    // @ts-expect-error transformers pipeline overloads vary
    const output = await ext(batch, { pooling: 'mean', normalize: true });

    // output.data is Float32Array of shape [batch * dims]
    const data = output.data as Float32Array;
    allVecs.push(data);
  }
  process.stdout.write('\n');

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
