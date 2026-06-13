import { defineConfig } from 'vite';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(ROOT, '../../dist-data'); // index artifacts + generated static pages
const MODELS_DIR = resolve(ROOT, 'public/models'); // shared model files

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.txt': 'text/plain', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Dev-only: serve the generated static site (front page, /versions, /theme, /story,
// index artifacts, /models) so the dev server hosts the SAME structure as production.
// Vite still owns the search SPA at its base (/search/) with full HMR; everything else
// is served from dist-data / public/models, mirroring how S3 + CloudFront serve it.
function staticSitePlugin(searchBase: string) {
  return {
    name: 'totolo-static-site',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '/').split('?')[0];
        // Let Vite handle the SPA, its modules, and HMR (all under the base or /@…).
        if (!searchBase || url === searchBase || url.startsWith(searchBase + '/')
          || url.startsWith('/@') || url.startsWith('/node_modules/') || url.startsWith('/src/')) {
          return next();
        }
        let baseDir: string;
        let rel: string;
        if (url.startsWith('/models/')) { baseDir = MODELS_DIR; rel = url.slice('/models/'.length); }
        else { baseDir = DATA_DIR; rel = url.replace(/^\//, ''); }
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        else if (!extname(rel)) rel += '/index.html';
        const file = normalize(join(baseDir, rel));
        if (!file.startsWith(baseDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache'); // dev: always revalidate so page edits show on reload
        (createReadStream(file) as unknown as { pipe: (d: unknown) => void; }).pipe(res);
      });
    },
  };
}

const base = process.env['APP_BASE'] ?? '/';

export default defineConfig({
  base,
  plugins: [staticSitePlugin(base.replace(/\/$/, ''))],
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
});
