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
- `cite.volume`, `cite.number`, `cite.timestampSec` (from `parseCitation`)
- `pdfPages` (pre-built index, loaded once from `/data/pdf-pages.json`). Each `(volume, number)` entry is either an array of timestamped segments or a single-segment object — see schema below.

Algorithm (`resolveCitationLinks` in `frontend/src/lib/sources.ts`) is deliberately tiny:

1. Look up `pdfPages[String(cite.volume)][String(cite.number)]`.
2. `PdfPagesContext.pickEntry(value, cite.timestampSec)` resolves it to a single `{ page, anchor? }`:
   - For an array of segments, pick the segment with the greatest `t` ≤ the citation timestamp. When the citation has no timestamp, or the timestamp is before the first segment, the first segment is used.
   - For a single-entry object (fallback path for Numbers without date headings), return it unchanged.
3. Build `pdfHref` as a query string into our React viewer: `` `/pdf/${cite.volume}?page=${page}&q=${anchor}` ``. Missing params are just omitted.

The AnythingLLM retrieval `sources` payload is still threaded through the component tree (and persisted on `chat_messages.sources`), but `resolveCitationLinks` no longer reads from it. Earlier revisions of this spec described matching the retrieval chunks by volume, pulling the top-ranked PDF chunk, and deriving the page + highlight from its text — that produced visibly wrong highlights because PDFs are whole-volume documents and a single "best chunk for Volume 1" is, at most, correct for one of the several Vol 1 Numbers cited in the reply. The offline index is keyed by `(volume, number, t)`, which is exactly what a citation carries, so it's always correct when present.

If the index has no entry for `(cite.volume, cite.number)` — typically because the VTT had no detectable date headings and the shingle fallback (see below) still fell below the match threshold — the PDF pill still works: it opens the volume without a page or highlight, and the user can scroll or Ctrl-F.

### Building the page index

`scripts/build-pdf-page-index.mjs` walks the VTT folder and, for each `Book of Heaven Volume X - Number Y.vtt`, tries two strategies in order:

**Primary: date-driven segmentation.** This is the path that produces the high-precision per-timestamp index, and the reason Francis's long multi-entry Numbers now highlight correctly. For each volume:

1. Opens `Volume_XX.pdf` with `pdfjs-dist` (legacy Node build), extracts per-page text, and builds a date-header index: `"december 8 1902" → { page: 63, display: "December 8, 1902" }`. The first occurrence of each date wins, which corresponds to the entry heading because the PDFs use a canonical centered date header at the start of every entry.
2. For each Number's VTT, parses the cues (with timestamps) and walks them in order looking for date mentions matching `\b<month>\s+\d{1,2}(?:st|nd|rd|th)?,?\s+((?:18|19|20)\d{2})\b`. Each match yields a candidate segment `{ t: cue.startSec, page, anchor: display }`, where `anchor` is the canonical "December 8, 1902" form taken directly from the PDF page's header.
3. Deduplicates segments on `(page, anchor)` so a Francis restating a date ("December 4, 1902.", "So this is December 4, 1902.") collapses to the first occurrence. Segments whose date isn't in the PDF's date index are silently dropped — this handles misreads without disturbing the surrounding segments.
4. If at least one segment survives, the Number's index entry is the array of segments, sorted by `t`.

**Fallback: single-page shingle match.** When a VTT has zero date mentions (short summaries, poems, or commentary Numbers that don't read dates aloud), the old heuristic takes over:

1. Strips VTT headers / timestamps to get plain text, selects ~8 long sentences as "anchors" (short filler lines like "Okay so..." get rejected).
2. Normalizes each page's text to a set of 5-word shingles.
3. Scores each anchor against each page by shingle overlap, picks the best-scoring page, then walks backward for the earliest page within 90% of the peak (usually where the entry begins).
4. If the best score crosses a threshold (default 0.5), records `{ page, anchor? }`. The anchor is the first 5-6-word window on that page whose normalized form matches one of this Number's anchor shingles, taken verbatim (casing + inline punctuation preserved) so pdf.js's phrase search always highlights it. One extra content token is appended when it's at least 3 characters long, so we don't produce truncated fragments like `"impossible to c"` caused by hyphenated line breaks.

Below-threshold Numbers (neither strategy worked) are listed at the end and simply don't go into the index; those citations fall back to opening the volume without a page or highlight.

### Output schema

`frontend/public/data/pdf-pages.json`:

```jsonc
{
  "<volume>": {
    "<number>": /* one of: */
      // (a) array of timestamped segments — the primary shape
      [
        { "t": 0,    "page": 60, "anchor": "November 21, 1902" },
        { "t": 2443, "page": 63, "anchor": "December 8, 1902" }
      ],
      // (b) single-entry fallback — for Numbers without date headings
      { "page": 13, "anchor": "As I lost consciousness, Our Lord" }
      // (c) legacy bare number — tolerated by the loader; the builder no longer writes this
  }
}
```

`PdfPagesContext` fetches it once at app mount, validates each entry, sorts segment arrays by `t`, and exposes the index via `usePdfPages()`. `pickEntry(value, timestampSec)` resolves a value to a single `{ page, anchor? }` using the rules in the algorithm section above. Typical size: ~40-80 KB, easily inlined.

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

Precision: **timestamp-level when the VTT has date headings**, **Number-level otherwise.** A Number whose VTT reads multiple dates aloud produces one segment per dated entry, and a citation's timestamp picks the correct segment — so `[Vol 4 · No 13 · 1:04:06]` now opens at page 63 ("December 8, 1902") instead of the Number's opening page (60, "November 21, 1902"). Numbers whose VTT has no dates fall back to single-page precision via the shingle heuristic.

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
| Normal case | `[Vol 4 · No 7 · 1:23:45]` + PDF icon (→ viewer at page + highlighted anchor phrase) + YouTube icon (→ timestamp) |
| Index has page but no anchor | Pill + PDF icon (→ viewer at page, no highlight) + YouTube icon |
| Index missing entry for this (volume, number) | Pill + PDF icon (→ viewer at volume page 1) + YouTube icon |
| Citation has no timestamp | Pill + PDF icon + YouTube icon linking to video start |
| Citation number missing from youtube-map.json | Pill + PDF icon, no YouTube icon |
| Citation text unparseable (malformed) | Plain amber pill with the raw citation text, no action icons |

Hovering the pill always shows a tooltip: the index-derived anchor phrase when one is available (a short verbatim preview of what the PDF will open to), otherwise the original unabbreviated citation text.

---

## Files involved

| File | Role |
|---|---|
| `supabase/functions/chat-proxy/index.ts` | Captures `sources` from AnythingLLM SSE, persists to `chat_messages.sources`, returns in response body |
| `supabase/migrations/006_chat_message_sources.sql` | Adds `sources jsonb` column to `chat_messages` |
| `frontend/src/lib/citations.ts` | `parseCitation`, `CITATION_PATTERN`, `formatTimestamp`, `padVolume` |
| `frontend/src/lib/sources.ts` | `resolveCitationLinks` — (volume, number) lookup into the offline index + link builders |
| `frontend/src/lib/YoutubeMapContext.tsx` | One-time fetch of `/data/youtube-map.json`, exposed via `useYoutubeMap()` |
| `frontend/src/lib/PdfPagesContext.tsx` | One-time fetch of `/data/pdf-pages.json`, exposed via `usePdfPages()` |
| `frontend/src/components/CitationBadge.tsx` | Pill component + `highlightCitations` walker |
| `frontend/src/components/Icons.tsx` | `IconPdf`, `IconYoutube` |
| `frontend/src/components/ChatWindow.tsx` | Per-message `AssistantMarkdown` wires sources + youtube map into the highlighter |
| `frontend/src/routes/PdfViewerPage.tsx` | Full-viewport React PDF viewer backed by pdfjs-dist (page nav, zoom, search highlight) |
| `frontend/src/routes/PdfViewerPage.css` | Viewer toolbar + text-layer highlight styles |
| `frontend/public/pdfs/` | The 36 volume PDFs (binaries not in git) |
| `frontend/public/data/youtube-map.json` | `{ "1": "videoId", ... }` |
| `frontend/public/data/pdf-pages.json` | `{ "<volume>": { "<number>": Segment[] \| Entry } }` — see "Output schema" above |
| `scripts/build-youtube-map.mjs` | Helper to regenerate the YouTube map from VTT files / CSV / playlist JSON |
| `scripts/build-pdf-page-index.mjs` | Builds `pdf-pages.json` by text-matching VTT content against PDF page text |
| `package.json` (root) | Pins `pdfjs-dist` as a devDependency for the scripts; exposes `npm run build-pdf-pages` |
