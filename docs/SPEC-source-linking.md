# Spec: Citation Source Linking

## Goal

Every citation the assistant emits — e.g. `[Book of Heaven Volume 4 - Number 7 (01:23:45)]` — renders as a pill with two small action links:

- A PDF link that opens our React PDF viewer at `/pdf/4?page=N&q=<snippet>` in a new tab, jumping to the page that contains the passage and highlighting the first few words of that passage in the text layer.
- A YouTube link that opens `https://www.youtube.com/watch?v=<videoId>&t=5025s` at the exact timestamp.

Both links are best-effort. When we can't resolve a page, the PDF link opens the volume at page 1. When there's no source chunk (e.g. older messages), no search snippet is passed and the viewer simply loads the page. When we don't have a video ID for that transcript number yet, the YouTube icon is hidden rather than broken.

---

## Data flow

```
AnythingLLM /stream-chat SSE
   ├── textResponseChunk { textResponse: "..." }
   └── finalizeResponseStream { sources: [ { title, chunkSource, text, ... } ] }
          ↓
chat-proxy — captures `sources`, persists it as chat_messages.sources (jsonb),
             returns it in the HTTP response body
          ↓
ChatWindow.tsx — per-message renders `<AssistantMarkdown content sources youtubeMap pdfPages />`
          ↓
CitationBadge — scans markdown text for [Volume X - Number Y (hh:mm:ss)] spans,
                 parses them, looks up matching source chunks + pdf page index
                 + youtube map, renders pill with PDF + YouTube action anchors
```

---

## Citation grammar

`frontend/src/lib/citations.ts` exports the regex and the field parser. Accepted shapes:

- Lead: `Book of Heaven Volume`, `Volume`, `Vol.`, or `Vol`
- Separator: any of `-`, `–`, `—`
- Number marker (optional): `Number`, `Num.`, `No.`, `#`, or bare digits
- Timestamp (optional): `hh:mm:ss` or `mm:ss`, with or without surrounding parentheses

Examples that parse:

```
[Book of Heaven Volume 4 - Number 7 (01:23:45)]
[Volume 17 – Number 13]
[Vol. 2 - 42 (5:30)]
[Volume 12 — No. 3]
```

`parseCitation(raw)` returns `{ raw, volume, number, timestampSec }` or `null`. `CITATION_PATTERN` is the discovery regex used by the highlighter to find citation-shaped spans inside markdown text.

---

## PDF page resolution

Inputs:
- `cite.volume`, `cite.number` (from `parseCitation`)
- `sources` (the AnythingLLM retrieval chunks for this assistant turn)
- `pdfPages` (pre-built `{ volume: { number: page } }` index, loaded once from `/data/pdf-pages.json`)

Algorithm (`resolveCitationLinks` in `frontend/src/lib/sources.ts`):

1. Filter `sources` to chunks that (a) look like PDFs (`title` ends in `.pdf` or `chunkSource` contains `.pdf`) and (b) refer to this volume — we accept padded (`Volume_04`), unpadded (`Volume 4`), and `Vol 4` variants, with a word-boundary guard so "Volume 4" doesn't match "Volume 40".
2. Sort candidates by retrieval quality — higher `score`, or lower `_distance`, first.
3. Take the top chunk and try to pull a page number from it, in order:
   - `metadata.page` / `metadata.pageNumber` (if AnythingLLM added them)
   - `pageNumber:\s*(\d+)` or `page:\s*(\d+)` anywhere in `chunkSource`, `text`, or `title`
   - `#page=N` / `?page=N` in `chunkSource`
   - `page_N` / `page N` / `page-N` fallback
4. **If no page came from the chunk**, fall back to the offline index: `pdfPages[cite.volume][cite.number]`. This is the main path in practice — the AnythingLLM PDF collector we use strips page metadata during embedding, so step 3 almost always returns null. The index is produced by `scripts/build-pdf-page-index.mjs` (see below).
5. Build `pdfHref` as a query string into our React viewer: `` `/pdf/${cite.volume}?page=${page}&q=${snippet}` ``. Missing params are just omitted.
   - `snippet` is the first 4-6 consecutive words of the matched chunk's PDF text (with leading punctuation stripped). Short enough to survive small differences in pdf.js's text extraction, long enough to uniquely identify the passage.
6. Use the same top chunk's `text` (stripped of any `<document_metadata>...</document_metadata>` prefix, collapsed whitespace, trimmed to 400 chars) as the `excerpt` for the pill's hover tooltip.

If the `sources` array is empty or `null` (older assistant messages written before migration `006`, AnythingLLM streams that didn't surface sources, etc.), step 4 still applies — we always know the volume and number from the parsed citation, so the index alone is enough to produce a deep link. The pill just won't have a hover excerpt.

### Building the page index

`scripts/build-pdf-page-index.mjs` walks the VTT folder and, for each `Book of Heaven Volume X - Number Y.vtt`:

1. Parses `(volume, number)` from the filename.
2. Strips VTT headers / timestamps to get plain text, then selects ~8 long sentences as "anchors" (short filler lines like "Okay so..." get rejected — they don't carry enough signal).
3. Opens `Volume_XX.pdf` with `pdfjs-dist` (legacy Node build), extracts per-page text, normalizes to a set of 5-word shingles per page.
4. Scores each anchor against each page by shingle overlap. Takes the best-scoring page, then walks backward for the **earliest** page that still scores within 90% of the peak — that's usually where the diary entry actually begins, rather than a later page that happened to repeat a phrase.
5. If the best score crosses a threshold (default 0.5), records the page. Below-threshold entries are listed at the end and simply don't go into the index; those citations fall back to the volume front page.

Output: `frontend/public/data/pdf-pages.json`, shape `{ "<volume>": { "<number>": <page> } }`. Typical size: ~15-25 KB, easily inlined. `PdfPagesContext` fetches it once at app mount and exposes it via `usePdfPages()`.

Usage (from the repo root):

```
npm install           # installs pdfjs-dist
npm run build-pdf-pages -- --verbose
```

Options:

| Flag | Default | Purpose |
|---|---|---|
| `--vtt-dir <path>` | `C:\Code\mp3-to-mp4-slides-app\output\transcripts` | Folder with the 612 VTT files |
| `--pdf-dir <path>` | `frontend/public/pdfs` | Folder with `Volume_01.pdf` … `Volume_36.pdf` |
| `--out <path>` | `frontend/public/data/pdf-pages.json` | Output JSON path |
| `--min-score <0..1>` | `0.5` | Below this, the page for that Number is left unresolved |
| `--verbose` | off | Log every anchor's best page + score |

Precision: **Number-level**. A citation with a late timestamp (e.g. `Number 13 (01:04:29)`) still opens at the Number's first page. For almost all entries that's within 1-3 pages of the actual passage — good enough to search with Ctrl+F. True timestamp-level precision would require per-cue indexing and is tracked as a follow-up.

---

## YouTube link resolution

1. Look up `youtubeMap[String(cite.number)]` — this is a static `{ "7": "abc123..." }` map served from `/data/youtube-map.json` and loaded once at app boot via `YoutubeMapContext`.
2. If a video ID exists and the citation had a timestamp, build `` `https://www.youtube.com/watch?v=${id}&t=${timestampSec}s` ``.
3. If a video ID exists but no timestamp, link to the video without the `t=` parameter.
4. If no video ID, return `null` and the UI hides the YouTube icon.

### Building the map

`scripts/build-youtube-map.mjs` emits the JSON. Inputs (any combination):

- `--vtt-dir <path>` — scans VTT filenames for a transcript number (first run of digits) and scrapes any YouTube URL found in the first 40 lines.
- `--csv <path>` — two-column `number,url_or_id` CSV overrides.
- `--playlist-json <path>` — `[{ position, videoId }]` export from yt-dlp or the YouTube Data API.

Any numbers not resolved are logged; the map is written with only the resolved entries.

---

## PDF file layout

`frontend/public/pdfs/Volume_01.pdf` through `Volume_36.pdf`. The filenames are zero-padded to two digits so the URL builder is deterministic. The binaries are not in git (size); see `frontend/public/pdfs/README.md` for where to drop them locally and the long-term plan for production hosting (likely Supabase Storage signed URLs).

---

## React PDF viewer (`/pdf/:volume`)

A full-viewport route that renders the requested volume through pdfjs-dist's component library (`PDFViewer`, `PDFFindController`, `PDFLinkService`, `EventBus`). Lives in `frontend/src/routes/PdfViewerPage.tsx` and is registered outside `ProtectedLayout` so it takes over the whole viewport (no chat sidebar competing for width).

Query params:

| Param | Example | Effect |
|---|---|---|
| `page` | `?page=14` | Jumps to that page once `pagesinit` fires. Clamped to `[1, pageCount]`. |
| `q` | `?q=Finally%20after%20one%20and%20a%20half%20years` | Dispatches a `find` event once the first text layer has rendered (~200 ms after `pagesinit`). `phraseSearch: true` + `highlightAll: true`, so every match of the phrase in the document gets a translucent highlight; the focused match turns orange. |

The worker is loaded via `import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'` — Vite emits it as an asset and pdf.js spawns it from the same origin. `cmaps` and `standard_fonts` are pulled from `unpkg.com/pdfjs-dist@<pinned>/…` at runtime so we don't have to vendor them into our repo.

The toolbar provides: previous/next page, a numeric page input, a search field (updates `q=` in the URL on submit), and a zoom in/out/fit cluster. A close icon on the left returns to `/`.

Highlighting styles live in `PdfViewerPage.css` and override pdf.js's default `.textLayer .highlight` / `.highlight.selected` classes with the app's warm amber palette.

---

## Failure modes and fallbacks

| Condition | Resulting pill |
|---|---|
| Normal case | `[Vol 4 · No 7 · 1:23:45]` + PDF icon (→ viewer at page + highlighted snippet) + YouTube icon (→ timestamp) |
| No source chunks for this volume | Pill + PDF icon (→ viewer at page from offline index, no highlight) + YouTube icon |
| PDF chunk found but no page or index entry | Pill + PDF icon (→ viewer at volume page 1) + YouTube icon |
| Citation has no timestamp | Pill + PDF icon + YouTube icon linking to video start |
| Citation number missing from youtube-map.json | Pill + PDF icon, no YouTube icon |
| Citation text unparseable (malformed) | Plain amber pill with the raw citation text, no action icons |

Hovering the pill always shows a tooltip: either the retrieved source excerpt (when one matched) or the original unabbreviated citation text.

---

## Files involved

| File | Role |
|---|---|
| `supabase/functions/chat-proxy/index.ts` | Captures `sources` from AnythingLLM SSE, persists to `chat_messages.sources`, returns in response body |
| `supabase/migrations/006_chat_message_sources.sql` | Adds `sources jsonb` column to `chat_messages` |
| `frontend/src/lib/citations.ts` | `parseCitation`, `CITATION_PATTERN`, `formatTimestamp`, `padVolume` |
| `frontend/src/lib/sources.ts` | `resolveCitationLinks` — PDF chunk matching + page index lookup + link builders |
| `frontend/src/lib/YoutubeMapContext.tsx` | One-time fetch of `/data/youtube-map.json`, exposed via `useYoutubeMap()` |
| `frontend/src/lib/PdfPagesContext.tsx` | One-time fetch of `/data/pdf-pages.json`, exposed via `usePdfPages()` |
| `frontend/src/components/CitationBadge.tsx` | Pill component + `highlightCitations` walker |
| `frontend/src/components/Icons.tsx` | `IconPdf`, `IconYoutube` |
| `frontend/src/components/ChatWindow.tsx` | Per-message `AssistantMarkdown` wires sources + youtube map into the highlighter |
| `frontend/src/routes/PdfViewerPage.tsx` | Full-viewport React PDF viewer backed by pdfjs-dist (page nav, zoom, search highlight) |
| `frontend/src/routes/PdfViewerPage.css` | Viewer toolbar + text-layer highlight styles |
| `frontend/public/pdfs/` | The 36 volume PDFs (binaries not in git) |
| `frontend/public/data/youtube-map.json` | `{ "1": "videoId", ... }` |
| `frontend/public/data/pdf-pages.json` | `{ "<volume>": { "<number>": <page> } }` |
| `scripts/build-youtube-map.mjs` | Helper to regenerate the YouTube map from VTT files / CSV / playlist JSON |
| `scripts/build-pdf-page-index.mjs` | Builds `pdf-pages.json` by text-matching VTT content against PDF page text |
| `package.json` (root) | Pins `pdfjs-dist` as a devDependency for the scripts; exposes `npm run build-pdf-pages` |
