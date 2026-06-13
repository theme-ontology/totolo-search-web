#!/usr/bin/env node
/**
 * Downloads the transformers.js model files at build time so the web app can serve
 * them from its own origin instead of fetching from huggingface.co at runtime (which
 * trips CORS). Files land in packages/web/public/models/<modelId>/… , which Vite
 * copies into the deployed site; transformers.js is pointed there via env.localModelPath.
 *
 * Idempotent: existing files are skipped. A models.json with per-file byte sizes is
 * written for the debug panel. Missing optional files (404) are skipped with a warning;
 * the q8 ONNX variant is the critical fallback and must be present.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/web/public/models');
const HF = 'https://huggingface.co';

// ONNX variants requested by the worker's pipelineOpts():
//   embedder — fp32 (WebGPU) / q8 (WASM fallback)
//   reranker — fp16 (WebGPU) / q8 (WASM fallback)
const MODELS = [
  {
    key: 'embedder',
    id: 'Xenova/all-MiniLM-L6-v2',
    files: [
      'config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt',
      'onnx/model.onnx', 'onnx/model_quantized.onnx',
    ],
  },
  {
    key: 'reranker',
    id: 'Xenova/ms-marco-MiniLM-L-6-v2',
    files: [
      'config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt',
      'onnx/model_fp16.onnx', 'onnx/model_quantized.onnx',
    ],
  },
];

async function fetchFile(id, file) {
  const dest = join(OUT, id, file);
  if (existsSync(dest)) {
    return (await stat(dest)).size;
  }
  const url = `${HF}/${id}/resolve/main/${file}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) { console.warn(`  skip (404): ${file}`); return 0; }
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  const manifest = {};
  for (const model of MODELS) {
    console.log(`Fetching ${model.id}…`);
    const files = {};
    for (const file of model.files) {
      const size = await fetchFile(model.id, file);
      if (size > 0) {
        files[file] = size;
        console.log(`  ${file}: ${(size / 1024 / 1024).toFixed(1)} MB`);
      }
    }
    if (files['onnx/model_quantized.onnx'] === undefined) {
      throw new Error(`${model.id}: missing onnx/model_quantized.onnx (required fallback)`);
    }
    manifest[model.key] = { id: model.id, files };
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'models.json'), JSON.stringify(manifest, null, 2));
  console.log('\nmodels.json written.');
}

main().catch(err => { console.error(err); process.exit(1); });
