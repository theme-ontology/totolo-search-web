#!/usr/bin/env tsx
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import MiniSearch from 'minisearch';
import { getMiniSearchOptions } from '@totolo-search/core';
import type { Manifest } from '@totolo-search/core';
import { loadCorpus } from './corpus.js';
import { embedTexts, packEmbeddings, EMBED_DIMS } from './embed.js';
import { writePages } from './pages.js';
import { writeAssets } from './page-assets.js';
import { upload } from './upload.js';

const args = process.argv.slice(2);
const corpusPath = args[0] ?? resolve('../python-totolo-search/corpus.json');
const outDir = args[1] ?? resolve('./out');
const doUpload = args.includes('--upload');
// Default "." means artifacts live next to latest.json; the web app resolves
// artifact URLs relative to the manifest's URL, so no deploy-time patching needed.
const prefixFlag = args.indexOf('--index-prefix');
const indexPrefix = prefixFlag >= 0 && args[prefixFlag + 1] ? args[prefixFlag + 1] : '.';
// Regenerate only the static pages (front/versions/docs/robots/css), reusing the
// existing index + embedding artifacts. Skips the slow embedding step — for fast
// local iteration on page markup/styling.
const pagesOnly = args.includes('--pages-only');
// Even faster than --pages-only: write ONLY pages.css + pages.js (CSS/JS live in page-assets.ts).
// No corpus, no page render -- for CSS/JS-only changes. corpusPath arg is ignored in this mode.
const assetsOnly = args.includes('--assets-only');
// Path to the previously deployed latest.json. Embeddings (the slow step) depend only on
// the corpus + model, so when those are unchanged vs this manifest we skip generating them
// and reuse the deployed ones. Missing/mismatched -> full rebuild.
const prevFlag = args.indexOf('--prev-manifest');
const prevManifestPath = prevFlag >= 0 ? args[prevFlag + 1] : undefined;

function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function main() {
  await mkdir(outDir, { recursive: true });

  if (assetsOnly) {
    await writeAssets(outDir);
    console.log('Assets-only: wrote pages.css + pages.js (no corpus, no page render).');
    return;
  }

  console.log(`Loading corpus from: ${corpusPath}`);
  const docs = await loadCorpus(corpusPath);
  console.log(`Loaded ${docs.length} documents.`);

  if (pagesOnly) {
    console.log('Regenerating pages only (reusing existing index/embeddings)...');
    const n = await writePages(corpusPath, docs, outDir);
    console.log(`  ${n} page files (html + overflow json) + front/versions/robots/css/js`);
    return;
  }

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

  // Static site: front page, detail pages, versions page, robots.txt, shared CSS.
  console.log('Generating pages...');
  const nPages = await writePages(corpusPath, docs, outDir);
  console.log(`  ${nPages} page files (html + overflow json) + front/versions/robots/css/js`);

  // Title index: themes/stories/collections, embedded on search_title.
  // Deliberately embed search_title only (name + aliases for themes; name/aliases/
  // title/date/authors for stories), not descriptions. This keeps build time low and
  // matches title-centric queries well; semantic recall on description text relies on
  // the cross-encoder rerank stage instead. See README "Design notes" before changing.
  const modelVersion = 'all-minilm-l6-v2';
  const corpusHash = sha256hex(corpusBuf);
  const miniSearchHash = sha256hex(miniSearchBuf);
  const embeddableDocs = docs.filter(d => d.doc_type !== 'story-theme');
  const annotationDocs = docs.filter(d => d.doc_type === 'story-theme');

  // Reuse the deployed embeddings if the corpus and model are unchanged — this is what makes
  // re-deploys (e.g. for a page/design change) skip the minutes-long embedding step. Their
  // hashes carry over verbatim, so the version_key stays identical and clients keep their cache.
  let prevManifest: Manifest | undefined;
  if (prevManifestPath) {
    try {
      prevManifest = JSON.parse(await readFile(prevManifestPath, 'utf-8')) as Manifest;
    } catch {
      console.log('No usable previous manifest found; doing a full build.');
    }
  }
  const reuse =
    !!prevManifest &&
    prevManifest.model_version === modelVersion &&
    prevManifest.hashes?.['corpus.json'] === corpusHash &&
    !!prevManifest.hashes?.['embeddings.bin'] &&
    !!prevManifest.hashes?.['embeddings-annotations.bin'];

  let embeddingsHash: string;
  let annEmbeddingsHash: string;
  if (reuse) {
    console.log('Corpus + model unchanged — reusing deployed embeddings (skipping generation).');
    embeddingsHash = prevManifest!.hashes['embeddings.bin'];
    annEmbeddingsHash = prevManifest!.hashes['embeddings-annotations.bin'];
    // Marker so the deploy step knows the embedding files were NOT regenerated and must be
    // preserved (not deleted) on the already-deployed target.
    await writeFile(join(outDir, '.reused-embeddings'), '');
  } else {
    console.log('Generating title embeddings...');
    const titles = embeddableDocs.map(d => d.search_title);
    const embeddings = await embedTexts(titles);
    const embeddingsBuf = packEmbeddings(embeddings, embeddableDocs.length);
    await writeFile(join(outDir, 'embeddings.bin'), embeddingsBuf);
    console.log(`  embeddings.bin: ${(embeddingsBuf.length / 1024).toFixed(0)} KB`);

    // Annotation index: story-theme annotations, embedded on theme name + motivation.
    // Downloaded lazily by the web app (large), only when the Annotations filter is used.
    console.log('Generating annotation embeddings...');
    const annTexts = annotationDocs.map(d => `${d.title}. ${d.search_body}`);
    const annEmbeddings = await embedTexts(annTexts);
    const annEmbeddingsBuf = packEmbeddings(annEmbeddings, annotationDocs.length);
    await writeFile(join(outDir, 'embeddings-annotations.bin'), annEmbeddingsBuf);
    console.log(`  embeddings-annotations.bin: ${(annEmbeddingsBuf.length / 1024).toFixed(0)} KB`);

    embeddingsHash = sha256hex(embeddingsBuf);
    annEmbeddingsHash = sha256hex(annEmbeddingsBuf);
  }

  // Build manifest
  const now = new Date().toISOString();
  const hashes = {
    'minisearch.json': miniSearchHash,
    'corpus.json': corpusHash,
    'embeddings.bin': embeddingsHash,
    'embeddings-annotations.bin': annEmbeddingsHash,
  };
  // Content-addressed version key (NOT date-based): identical data produces an
  // identical key, so a client keeps its cached artifacts across rebuilds/days and
  // only re-downloads when content actually changes. The model id is mixed in so an
  // embedding-model change invalidates the cache.
  const versionKey = sha256hex(
    modelVersion + '|' + Object.keys(hashes).sort().map(k => `${k}=${hashes[k as keyof typeof hashes]}`).join('|'),
  ).slice(0, 16);

  const manifest: Manifest = {
    created: now,
    version_key: versionKey,
    index_prefix: indexPrefix,
    model_version: modelVersion,
    n_docs: docs.length,
    dims: EMBED_DIMS,
    doc_ids: embeddableDocs.map(d => d.doc_id),
    annotation_doc_ids: annotationDocs.map(d => d.doc_id),
    hashes,
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  await writeFile(join(outDir, 'latest.json'), manifestBuf);
  console.log(`\nManifest written: ${versionKey}`);

  if (doUpload) {
    const bucket = process.env['S3_BUCKET'];
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    if (!bucket) {
      console.error('S3_BUCKET env var is required for --upload');
      process.exit(1);
    }
    await upload({ bucket, region, prefix: versionKey, outDir, manifest });
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
