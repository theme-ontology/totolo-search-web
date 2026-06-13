# totolo-search-web

Client-side hybrid search over the [Theme Ontology](https://www.themeontology.org)
corpus — themes, stories, collections, and story-theme annotations. Everything runs
in the browser: lexical search (MiniSearch / BM25), semantic search (MiniLM sentence
embeddings), and cross-encoder reranking, with no search backend.

## How it works

A search runs in progressive phases, each refining the last:

1. **Keyword** — MiniSearch BM25 over stemmed `search_title` / `search_body` /
   `search_misc` fields, with phrase and `+`/`-` operator support. Synchronous, instant,
   and rendered on every keystroke.
2. **Semantic** — the query is embedded (Xenova/all-MiniLM-L6-v2) in a web worker and
   compared by cosine similarity against precomputed document embeddings. Lexical and
   semantic candidate lists are merged with Reciprocal Rank Fusion. Runs automatically
   (debounced) for short queries.
3. **Reranked** — a cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2) scores the query
   against passages of each candidate and picks the best-matching passage as the
   preview snippet. Triggered explicitly by **Enter** or the **Search** button.

The three phases are shown as pills beside the result count; each darkens once it has
applied to the current results.

### Progressive loading

The semantic model and its embeddings are treated as **optional enhancements**. The
keyword index (`minisearch.json` + `corpus.json`) loads first behind the main progress
bar; as soon as it is ready the search box accepts debounced keyword queries. The
embeddings and the two models then load in the background — surfaced by a small spinner
and "Loading semantic search… NN%" — and semantic search / reranking light up when
ready, automatically upgrading whatever query is on screen. If the model never loads
(slow network, unsupported environment), keyword search keeps working. Regex search runs
in the worker too, so it becomes available once the worker has spawned.

### Architecture

Monorepo (npm workspaces):

- **`packages/core`** — pure, DOM-free search logic: query parsing (`parseOperators`),
  lexical search + pool filtering (`lexicalSearch`, `applyPoolFilter`), rank fusion
  (`unionDedup`, `rrfScores`, `sortByRrf`), passage windowing (`makePassages`),
  tokenizer/stemmer, and the shared MiniSearch options. Unit-tested with Vitest.
- **`packages/indexer`** — builds the artifact set from a corpus JSON: the MiniSearch
  index, the corpus, the embeddings, and the manifest. Optional S3 upload.
- **`packages/web`** — the Vite single-page app. The main thread owns the UI, lexical
  search, and result hydration; a web worker owns model loading, query embedding,
  vector search, reranking, and regex search.
- **`scripts/dev.mjs`** — local orchestrator: generates the corpus via Python, builds
  the artifacts, and starts the Vite dev server.

### Artifacts

The indexer emits four files, served as static assets:

| File                         | Contents                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `minisearch.json`            | Serialized MiniSearch keyword index                         |
| `corpus.json`                | All documents (display fields + search fields + page slugs) |
| `embeddings.bin`             | Title embeddings: themes/stories/collections, `[n, dims]` + header |
| `embeddings-annotations.bin` | Annotation embeddings: story-theme motivations (large; lazy-loaded) |
| `latest.json`                | Manifest: version key, `index_prefix`, both doc-id lists, dims, hashes |
| `theme/<slug>.html`          | Static detail page per theme                                |
| `story/<slug>.html`          | Static detail page per story and collection                 |

The browser caches artifacts in IndexedDB keyed by the manifest's `version_key`; a new
build invalidates the cache automatically. If IndexedDB is unavailable (e.g. private
browsing), the app downloads fresh each load instead of failing.

Artifact URLs are resolved **relative to the manifest's own URL**, so `index_prefix`
defaults to `"."` and the same build works under any path — `/test-data/` in dev,
`/totolo-search-web/` on GitHub Pages, or an absolute S3 URL — with no path patching.

## Local development

Prerequisites: Node 20+, Python 3.12+ with the `totolo` package (`pip install totolo`).

```bash
npm install
npm run dev:local                 # generate corpus, build indexes, serve
npm run dev:local:skip-corpus     # reuse existing corpus.json (skip Python step)
npm run dev:local:skip-index      # reuse existing indexes, serve only
node scripts/dev.mjs v2025.10     # pin a specific ontology version
```

Other scripts:

```bash
npm test          # run the core unit tests
npm run lint      # ESLint across all packages
npm run format    # Prettier write
npm run build     # build core, indexer, and web for production
```

## Query syntax

| Syntax          | Meaning                                                          |
| --------------- | --------------------------------------------------------------- |
| `dark forest`   | Free text — lexical + semantic match                            |
| `"dark forest"` | Phrase — boosts contiguous matches                              |
| `+dragon`       | Required — results must contain this term (all phases)          |
| `+"dark wood"`  | Required phrase                                                  |
| `-goblin`       | Excluded — results must not contain this term (all phases)      |
| regex mode      | Toggle **Regex**; the query is a JS regular expression          |

Type filters (All / Themes / Stories / Annotations) and the **Debug** panel (also via
the `?debug` URL param) sit beside the search box. "Stories" includes collections.

**Excluded-phrase semantics:** `-"dark forest"` excludes any document containing *all*
of the words (stemmed, anywhere in the doc), not only the contiguous phrase. This is a
deliberate simplification — exclusion uses stem-set membership, so it cannot distinguish
"a dark and ancient forest" from "the dark forest." Required phrases, by contrast, are
boosted toward contiguous matches by the lexical phrase query.

### Detail pages

The indexer generates a static detail page for every theme, story, and collection
(`packages/indexer/src/pages.ts`) — the local equivalent of themeontology.org's pages,
styled to match the search app. Theme pages show description, aliases, references,
parent/child themes, and a table of every story featuring the theme (story, level,
motivation). Story and collection pages show metadata, description, references,
collection membership / component stories, and the full annotation table. Pages contain
no JavaScript and render their tables at build time, so the content arrives in a single
request; the only shared assets are one cacheable stylesheet (`pages.css`) and the
favicon. Search results link to these pages via the `slug` field carried in
`corpus.json`, falling back to themeontology.org for unknown names.

## Deployment

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on push to `main`:
generate corpus → install → test → build indexes → build the web app → bundle the
artifacts into the site → deploy. `.github/workflows/ci.yml` runs lint, type-checks,
and tests on every pull request (no corpus/embedding build, so it stays fast).

GitHub Pages must be set to **Build and deployment → Source: GitHub Actions**.

## Design notes

- **Title-only embeddings.** The indexer embeds `search_title` only (name + aliases for
  themes; name/aliases/title/date/authors for stories), not descriptions. This keeps
  build time and `embeddings.bin` small and matches title-centric queries well; recall
  over description *text* is recovered at the rerank stage, where the cross-encoder reads
  full passages. Embedding descriptions too is a reasonable future experiment — the
  binding cost is embedding *text length* at build time, not artifact size. See the
  comment at the embed site in `packages/indexer/src/build.ts`.
- **Annotations have a separate, lazily-loaded semantic index.** Story-theme
  annotations are embedded on `theme name + motivation` into `embeddings-annotations.bin`,
  kept apart from the title index. There are tens of thousands of annotations, so this
  index is large and is downloaded only when the **Annotations** filter is first used;
  until then (and in **All** mode) annotations surface through keyword/regex search only.
- **Type filters restrict before the result limit.** Selecting Themes / Stories /
  Annotations restricts both the keyword and semantic candidate pools to that type
  before the top-20 cut, so a rare type still fills the results rather than being
  squeezed out by a mixed-type candidate list. Annotations additionally switch the
  semantic search to the annotation embedding index.
- **Models are self-hosted.** `scripts/fetch-models.mjs` downloads the embedder and
  reranker files at build time into `packages/web/public/models/` (git-ignored), Vite
  ships them with the site, and the worker points transformers.js there via
  `env.localModelPath` / `env.allowRemoteModels = false`. This avoids the CORS failures
  of fetching from `huggingface.co` at runtime. Run `npm run fetch-models` locally; CI
  caches the directory. Per-model download sizes are written to `models/models.json` and
  shown in the Debug panel.
- **WebGPU with WASM fallback.** When available, inference uses WebGPU; otherwise it
  falls back to quantized WASM. The active backend is shown in the Debug panel.
