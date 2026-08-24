# ClipTube

Paste a YouTube URL, scrub to the part you want, and download just that slice — as an
`.mp4` video or as untouched original audio (`.m4a` / `.opus` / …).

A single-page Vue 3 app on top of an Express API that drives `yt-dlp` and `ffmpeg`.

---

## How it works

1. **Preview** — the URL is embedded with the YouTube IFrame Player API.
2. **Select** — a custom dual-handle slider spans the full duration and stays in sync with
   the player: dragging a handle seeks the video, playing moves the marker. Two validated
   `hh:mm:ss` fields are two-way bound to the same range.
3. **Choose a format** — *Clip* asks the API what `yt-dlp` reports for that video and opens
   a dialog with three tabs: **Video** (one entry per resolution), **Audio** (original
   codecs, with a bitrate tier per codec) and **Preview Info** (thumbnail, channel,
   duration, selected range).
4. **Download** — the API creates a Mongo job, runs `yt-dlp --download-sections` at the
   chosen format, copies the result into its final container with `ffmpeg`, and hands the
   file to the browser as `{video-title-slugified}-clip.{ext}`. The temp file is unlinked
   the moment the response finishes.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** | Built and tested on Node 25. |
| **MongoDB** | Local `mongod`, or any connection string (Atlas works). |
| **yt-dlp** | Must be on `PATH`, or set `YTDLP_PATH` in `backend/.env`. |
| **ffmpeg + ffprobe** | Must be on `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH`. |

The API refuses to start without all three binaries and prints exactly which one is
missing and how to install it.

### Installing the binaries

```bash
# Windows (winget)
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg

# macOS (Homebrew)
brew install yt-dlp ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg
python3 -m pip install -U yt-dlp
```

Verify with `yt-dlp --version` and `ffmpeg -version`.

> **Alternative: npm-bundled binaries.** `npm run install:binaries` in `backend/` adds
> `ffmpeg-static`, `ffprobe-static` and `youtube-dl-exec`, whose install scripts download
> their own binaries; the resolver picks them up automatically as a fallback. This needs
> unproxied HTTPS access to GitHub — on a network with TLS inspection the download fails
> with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, so install the binaries by hand instead.

---

## Setup

### Backend

```bash
cd backend
npm install
cp .env.example .env      # then edit if your Mongo isn't on the default port
npm run dev               # http://localhost:4000
```

`.env` keys:

| Key | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | API port. |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/cliptube` | Database. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins. |
| `TEMP_DIR` | `temp` | Where clips are written (relative to `backend/`). |
| `TEMP_FILE_TTL_MINUTES` | `60` | Age at which orphaned files are swept. |
| `CLEANUP_CRON` | `0 * * * *` | Sweep schedule (also runs once at startup). |
| `MAX_CLIP_SECONDS` | `1800` | Longest clip the API will build. |
| `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` | *(empty)* | Explicit binary paths; blank means auto-detect. |

Other scripts: `npm run build` (compile to `dist/`), `npm start` (run the build),
`npm run typecheck`.

### Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:4000`, so everything stays same-origin
and no CORS or download-header workarounds are needed. For a production build where the
API is on another host, set `VITE_API_BASE_URL` (see `frontend/.env.example`).

Run both servers together, then open **http://localhost:5173**.

---

## API

| Method | Route | Body / Params | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/formats` | `{ url }` | `{ meta, video[], audio[] }` — normalised format lists. |
| `POST` | `/api/clip` | `{ url, start, end, type, formatId }` | `202 { jobId, statusUrl, downloadUrl, totalDownloads }`. |
| `GET` | `/api/status/:jobId` | — | `{ status, progress, fileName, error, downloadUrl }`. |
| `GET` | `/api/download/:jobId` | — | The file; deleted from disk once the response finishes. |
| `GET` | `/api/stats` | — | `{ totalDownloads }`. |
| `GET` | `/api/health` | — | `{ ok, database, uptimeSeconds }`. |

`start` / `end` accept seconds or `hh:mm:ss` (`startTime` / `endTime` are accepted as
aliases). Job status moves `queued → downloading → processing → ready → downloaded`, or
`failed` with a human-readable `error`.

### Models

- **`Job`** — `jobId`, `url`, `videoId`, `title`, `start`, `end`, `type`, `formatId`,
  `status`, `progress`, `filePath`, `fileName`, `sizeBytes`, `error`, timestamps.
- **`Stats`** — a single pinned document holding `totalDownloads`.

### Where the counter increments

`totalDownloads` is bumped in `POST /api/clip`, i.e. the moment the Download button
creates a job — so retries and failures are counted too, per the product spec. The
`/api/download` handler deliberately does **not** increment it, to avoid double-counting.

---

## File lifecycle

Each job gets its own folder, `backend/temp/<jobId>/`, holding one human-readable file.
Two things remove it:

1. **`res.on('finish')`** after a successful download — the folder is deleted immediately
   and the job is marked `downloaded`. An *aborted* transfer deliberately leaves the file
   in place so the user can retry.
2. **The sweep** — runs at startup and on `CLEANUP_CRON` (hourly by default), deleting
   anything older than `TEMP_FILE_TTL_MINUTES` and marking those jobs `failed` so
   `/api/status` stays honest.

---

## Layout

```
backend/
  src/
    index.ts                    startup: binary check → temp dir → Mongo → cron → listen
    app.ts                      Express wiring
    config/{env,db}.ts          .env parsing, Mongo connection
    lib/
      binaries.ts               resolves + version-checks yt-dlp / ffmpeg / ffprobe
      exec.ts                   argv-array spawn wrapper (never a shell string)
      ffmpeg.ts                 fluent-ffmpeg probe + stream-copy remux
      youtube.ts                URL validation, canonical rebuild
      time.ts, slugify.ts, errors.ts, logger.ts
    models/{Job,Stats}.ts
    routes/api.ts
    services/
      ytdlp.service.ts          -J metadata, --download-sections downloads
      formats.service.ts        raw formats → tab-ready video/audio lists (+ 10 min cache)
      clip.service.ts           job creation and the download → remux pipeline
      cleanup.service.ts        startup + cron temp sweep
frontend/
  src/
    components/                 ClipStudio, YouTubePlayer, RangeSlider, TimeField,
                                ClipDialog, StatsCard, AppFooter
    lib/                        api client, clip-job polling, time helpers, IFrame loader
    style.css                   design tokens
```

---

## Notes on the implementation

- **Cut accuracy.** `--force-keyframes-at-cuts` makes `yt-dlp` re-encode around the cut so
  the clip starts where you asked instead of snapping back to the previous keyframe. The
  clip is then probed; if it still overruns the requested length by more than 0.75s,
  `ffmpeg` trims the tail.
- **No re-encoding in the ffmpeg pass.** It is a stream copy: it fixes the container to
  match the codec (webm/opus → `.opus`, merged → `.mp4`) and moves the mp4 index to the
  front so the file seeks instantly.
- **Original audio only.** The Audio tab lists what YouTube actually serves and copies it
  through untouched — no transcoding, and dubbed tracks are filtered out when an
  original-language track exists.
- **Command safety.** Binaries are spawned with an argv array and never through a shell,
  and the incoming URL is rebuilt from a validated 11-character video id rather than
  forwarded verbatim.
- **`multer`** is installed because it is on the project's dependency list, but nothing
  imports it: the API has no upload endpoints, and downloads are served with
  `res.download()`.

---

## Built by

**Ashwani Singh** — [GitHub](https://github.com/ashwani2529) ·
[Portfolio](https://ashwanisingh-portfolio.netlify.app/)
