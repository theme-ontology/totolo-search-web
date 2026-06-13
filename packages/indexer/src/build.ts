#!/usr/bin/env tsx
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import MiniSearch from 'minisearch';
import { getMiniSearchOptions } from '@totolo-search/core';
import type { Manifest } from '@totolo-search/core';
import { loadCorpus } from './corpus.js';
import { embedTexts, packEmbeddings, EMBED_DIMS } from './embed.js';
import { writePages } from './pages.js';
import { upload } from './upload.js';

const args = process.argv.slice(2);
const corpusPath = args[0] ?? resolve('../python-totolo-search/corpus.json');
const outDir = args[1] ?? resolve('./out');
const doUpload = args.includes('--upload');
// Default "." means artifacts live next to latest.json; the web app resolves
// artifact URLs relative to the manifest's URL, so no deploy-time patching needed.
const prefixFlag = args.indexOf('--index-prefix');
const indexPrefix = prefixFlag >= 0 && args[prefixFlag + 1] ? args[prefixFlag + 1] : '.';

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

  // Static detail pages (theme/<slug>.html, story/<slug>.html) for every document.
  console.log('Generating pages...');
  const nPages = await writePages(corpusPath, docs, outDir);
  console.log(`  ${nPages} pages -> theme/, story/`);

  // Title index: themes/stories/collections, embedded on search_title.
  // Deliberately embed search_title only (name + aliases for themes; name/aliases/
  // title/date/authors for stories), not descriptions. This keeps build time low and
  // matches title-centric queries well; semantic recall on description text relies on
  // the cross-encoder rerank stage instead. See README "Design notes" before changing.
  console.log('Generating title embeddings...');
  const embeddableDocs = docs.filter(d => d.doc_type !== 'story-theme');
  const titles = embeddableDocs.map(d => d.search_title);
  const embeddings = await embedTexts(titles);
  const embeddingsBuf = packEmbeddings(embeddings, embeddableDocs.length);
  await writeFile(join(outDir, 'embeddings.bin'), embeddingsBuf);
  console.log(`  embeddings.bin: ${(embeddingsBuf.length / 1024).toFixed(0)} KB`);

  // Annotation index: story-theme annotations, embedded on theme name + motivation.
  // Downloaded lazily by the web app (large), only when the Annotations filter is used.
  console.log('Generating annotation embeddings...');
  const annotationDocs = docs.filter(d => d.doc_type === 'story-theme');
  const annTexts = annotationDocs.map(d => `${d.title}. ${d.search_body}`);
  const annEmbeddings = await embedTexts(annTexts);
  const annEmbeddingsBuf = packEmbeddings(annEmbeddings, annotationDocs.length);
  await writeFile(join(outDir, 'embeddings-annotations.bin'), annEmbeddingsBuf);
  console.log(`  embeddings-annotations.bin: ${(annEmbeddingsBuf.length / 1024).toFixed(0)} KB`);

  // Build manifest
  const now = new Date().toISOString();
  const dateHash = now.slice(0, 10).replace(/-/g, '') + '-' + sha256hex(miniSearchBuf).slice(0, 8);

  const manifest: Manifest = {
    created: now,
    version_key: dateHash,
    index_prefix: indexPrefix,
    model_version: 'all-minilm-l6-v2',
    n_docs: docs.length,
    dims: EMBED_DIMS,
    doc_ids: embeddableDocs.map(d => d.doc_id),
    annotation_doc_ids: annotationDocs.map(d => d.doc_id),
    hashes: {
      'minisearch.json': sha256hex(miniSearchBuf),
      'corpus.json': sha256hex(corpusBuf),
      'embeddings.bin': sha256hex(embeddingsBuf),
      'embeddings-annotations.bin': sha256hex(annEmbeddingsBuf),
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
