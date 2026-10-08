# MammoCheck Anonymizer (local)

Browser tool that anonymizes patient folders **on the user's own computer** and saves the anonymized copies back to it.
Nothing is uploaded: there is no server, no account, no storage. The page is static (GitHub Pages); all processing runs in the browser (Web Workers + WASM).

Live: https://mammocheck.github.io/mammocheck-anonymizer-local/

## How to use

1. Open the page in **Chrome or Edge** (recommended).
2. Drop one or more patient folders on the page, or the folder that contains all of them. Each folder name is taken as the patient's name.
3. Click **Anonymize & save** and choose an **empty output folder**. The browser asks for permission to write there.
4. The key file `mammocheck-key-<date>.csv` (patient name <-> ID) is downloaded separately. Keep it safe and **do not share it** with the anonymized files.
5. Output: one sub-folder per patient ID (`MC-XXXXXX/...`) with the anonymized files and a `manifest.json`.

Other browsers (Firefox, Safari) cannot write into a folder: they get one ZIP download instead, built in memory, so keep batches small there.

## What it does per file

| Type | Treatment |
|---|---|
| FLIR thermal JPG (EXIF make FLIR) | bytes untouched (radiometric data kept), scanned for name strings (blocked if found) |
| Video (mp4, mov, avi, m4v, 3gp, mkv, webm, wmv, mpg) | **included, bytes untouched**, streamed byte-scan for name strings, filename rewritten; manifest says "included, not content-anonymized (faces/voice may be present)" |
| Other images | OCR, black boxes over names / contact details / label values, re-encoded (EXIF/GPS dropped) |
| PDF | real redaction with mupdf (text removed from the file, image pixels blacked out), scanned pages via OCR, metadata/XMP/bookmarks removed, form fields cleared |
| DOCX / XLSX | text replaced with `[REDACTED]`, document properties wiped |
| TXT / CSV | text replaced |
| `Thumbs.db`, `.DS_Store`, `~$*`, `desktop.ini` | dropped |
| anything else | skipped and listed in the report |

Names: folder name -> variants (`F.Last`, `Last, First`, `J A N E`, upper/lower case, accents) + fuzzy matching (edit distance 1 on
tokens of 5+ letters, so `SMITHSAN` / `Brownn` are caught but `Endometriosis` is not). Names found in `Name:` fields that share a token
with the folder name are added automatically. Label-anchored redaction removes the value after `Name`, `Date of birth`, `Address`,
`Phone`, `Mobile`, `Email`, `ID`, `File No`, `MRN`... Clinical text, age, gender and exam dates are kept.
A **leak gate** re-checks every output (text layer, OCR of the output image, raw bytes); a failing file is **not saved** and is listed in the report.
File names have name variants replaced by the patient ID (`Med. F-Thermo R.Smithson.pdf` -> `Med. F-Thermo MC-7F3K2Q.pdf`).
Each patient gets a random ID `MC-XXXXXX` and a `manifest.json` (files, actions, skipped/blocked; no names). The doctor downloads
`mammocheck-key-<date>.csv` (name <-> ID) (never part of the output). Every run assigns new IDs (a returning patient gets a new ID).

## Development

```bash
cd web && npm install
npm run dev                  # http://localhost:5173/  (add ?zip=1 to force the ZIP output)
npm test                     # vitest
npm run build                # tsc + vite build (reads VITE_BASE)
npx tsx scripts/verify.ts <input-folder> <out-dir-outside-the-repo> [--no-ocr]   # runs the real pipeline in Node
```

Core logic (`names.ts`, `scan.ts`, `pipeline.ts`, `process/*`) has no DOM dependency and runs in Node; the browser supplies the image codec
(`imageio.ts`), the Node script uses `@napi-rs/canvas`. Deploys to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

Never commit real patient data to this repository.

## Known limits

- **Handwriting** on scanned forms is not read by OCR; it is only covered by the label-anchored boxes (value area right of `Name`, `Date of birth`, ...). Check a few results.
- OCR is imperfect (tables, colored text, photos): two OCR passes are used and the output is OCR'd again as a leak gate, but it can miss text. Scanned/photographed PDFs and images are the weakest part.
- **Faces and voices are not anonymized.** Photos are not inspected for faces. **Videos are copied as-is** (only the filename and a byte-scan for name strings), so they may contain faces, voices or on-screen text; the manifest marks them.
- Embedded images in DOCX/XLSX are not anonymized (the manifest notes how many were present). Old binary `.doc/.xls`, `.tif`, etc. are skipped.
- Other people's names (referring doctors, relatives) are kept unless they sit behind a `Name`-type label; contact details (phones, emails) are removed wherever they appear.
- Very large videos: the byte-scan is case-insensitive on names of 5+ letters at word boundaries; a spurious match in a multi-GB file is possible and would block that file (listed in the report).
- ZIP output (non-Chromium browsers) is built in memory: fine for a few patients, not for large batches or long videos. Keep the tab open until the report appears.
- HEIC/HEIF only decode in browsers that support it (Safari); otherwise those files are skipped.
- The first OCR run downloads the English language data (~10 MB) from the tesseract.js CDN; this contains no patient data.
- mupdf is AGPL-licensed; that is fine because this repo is public, keep it public/AGPL-compatible.
