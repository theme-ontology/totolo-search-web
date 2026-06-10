#!/usr/bin/env tsx
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import MiniSearch from 'minisearch';
import { getMiniSearchOptions } from '@totolo-search/core';
import type { Manifest } from '@totolo-search/core';
import { loadCorpus } from './corpus.js';
import { embedTexts, packEmbeddings, EMBED_DIMS } from './embed.js';
import { upload } from './upload.js';

const args = process.argv.slice(2);
const corpusPath = args[0] ?? resolve('../python-totolo-search/corpus.json');
const outDir = args[1] ?? resolve('./out');
const doUpload = args.includes('--upload');

function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function main() {
  await mkdir(outDir, { recursive: true });

  console.log(`Loading corpus from: ${corpusPath}`);
  const docs = await loadCorpus(corpusPath);
  console.log(`Loaded ${docs.length} documents.`);

  // Build MiniSearch index
  console.log('Building keyword index...');
  const ms = new MiniSearch(getMiniSearchOptions());
  ms.addAll(docs);
  const miniSearchJson = JSON.stringify(ms);
  const miniSearchBuf = Buffer.from(miniSearchJson, 'utf-8');
  await writeFile(join(outDir, 'minisearch.json'), miniSearchBuf);
  console.log(`  minisearch.json: ${(miniSearchBuf.length / 1024).toFixed(0)} KB`);

  // Write corpus
  console.log('Writing corpus...');
  const corpusOut = JSON.stringify(docs);
  const corpusBuf = Buffer.from(corpusOut, 'utf-8');
  await writeFile(join(outDir, 'corpus.json'), corpusBuf);
  console.log(`  corpus.json: ${(corpusBuf.length / 1024).toFixed(0)} KB`);

  // Build embeddings for embeddable docs only (story-theme excluded — lexical search only)
  console.log('Generating embeddings...');
  const embeddableDocs = docs.filter(d => d.doc_type !== 'story-theme');
  const titles = embeddableDocs.map(d => d.search_title);
  const embeddings = await embedTexts(titles);
  const embeddingsBuf = packEmbeddings(embeddings, embeddableDocs.length);
  await writeFile(join(outDir, 'embeddings.bin'), embeddingsBuf);
  console.log(`  embeddings.bin: ${(embeddingsBuf.length / 1024).toFixed(0)} KB`);

  // Build manifest
  const now = new Date().toISOString();
  const dateHash = now.slice(0, 10).replace(/-/g, '') + '-' + sha256hex(miniSearchBuf).slice(0, 8);

  const manifest: Manifest = {
    created: now,
    version_key: dateHash,
    index_prefix: doUpload ? `s3://${process.env['S3_BUCKET'] ?? 'your-bucket'}/${dateHash}` : `./${dateHash}`,
    model_version: 'all-minilm-l6-v2',
    n_docs: docs.length,
    dims: EMBED_DIMS,
    doc_ids: embeddableDocs.map(d => d.doc_id),
    hashes: {
      'minisearch.json': sha256hex(miniSearchBuf),
      'corpus.json': sha256hex(corpusBuf),
      'embeddings.bin': sha256hex(embeddingsBuf),
    },
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  await writeFile(join(outDir, 'latest.json'), manifestBuf);
  console.log(`\nManifest written: ${dateHash}`);

  if (doUpload) {
    const bucket = process.env['S3_BUCKET'];
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    if (!bucket) {
      console.error('S3_BUCKET env var is required for --upload');
      process.exit(1);
    }
    await upload({ bucket, region, prefix: dateHash, outDir, manifest });
    console.log('Upload complete.');
  } else {
    console.log('\nSkipping upload (pass --upload to push to S3).');
    console.log(`Output in: ${outDir}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
