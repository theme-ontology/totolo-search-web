import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env['APP_BASE'] ?? '/',
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
