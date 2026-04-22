# Volume PDFs

The frontend serves the 36 Book of Heaven volume PDFs from this directory. Citation pills in assistant replies link directly to these files with a `#page=N` anchor that native PDF viewers honour (e.g. `/pdfs/Volume_04.pdf#page=23`).

## Filename convention

Zero-padded to two digits so the URL builder in `frontend/src/lib/citations.ts` (`padVolume`) is deterministic:

```
Volume_01.pdf
Volume_02.pdf
...
Volume_36.pdf
```

The matcher in `frontend/src/lib/sources.ts` also accepts the unpadded form (`Volume_4.pdf`) in the AnythingLLM source chunks, but the public URL always uses the padded form.

## Where the actual PDFs live

The PDF binaries are **not** checked into git (see `frontend/.gitignore`). Drop your local copies into this folder before running `npm run dev`; Vite will serve them as `http://localhost:5173/pdfs/Volume_XX.pdf`.

For the production deploy on Vercel either:

1. Check the PDFs into a separate branch that Vercel builds from, or
2. Upload them to a Supabase Storage bucket and swap the `/pdfs/` prefix in `resolveCitationLinks` for a signed URL builder.

Total size of all 36 volumes is ~500–700 MB, which is above Vercel's default build-output limit, so option (2) is the likely long-term answer.
