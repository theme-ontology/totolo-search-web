// Warm the build-time embedding model into the local HuggingFace cache
// (~/.cache/huggingface) by running a one-string embed with the exact model/dtype that
// embed.ts uses. A prefetch job runs this once so a matrix of release builds restores the
// model from the Actions cache instead of each leg fetching it from the hub (which 429s).
import { embedTexts } from './embed.js';

embedTexts(['warm the embedding model cache'])
  .then(() => console.log('Embedding model cached.'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
