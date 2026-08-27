# ClipTube

Download just the part of a YouTube video you actually want.

Paste a link, preview the video in place, drag two handles to mark a range, and save that
slice on its own — as an `.mp4` video or as the original audio track, untouched. No
full-length download, no re-encoding, no editor.

## Features

- **Inline preview** — the video is embedded with the YouTube IFrame Player API.
- **Dual-handle range slider** spanning the full duration, live-synced with the player:
  dragging a handle seeks the video, playback moves the marker. Keyboard accessible.
- **Manual `hh:mm:ss` timestamps** for start and end, validated and two-way bound to the
  slider.
- **Format picker** listing exactly what `yt-dlp` reports for that video — one entry per
  resolution (360p → 4K, HDR flagged) and original audio codecs (`m4a`, `opus`, …) with a
  bitrate tier each. Dubbed tracks are filtered out when an original-language track exists.
- **Browser-first extraction** — the YouTube-facing work runs in your own browser over your
  own connection wherever it can, so clips are not funnelled through a shared server IP.
  The server is a fallback, not the default route.
- **Precise cuts** — the clip is trimmed to the exact range, stream-copied rather than
  re-encoded whenever the source allows it.
- **Named output** — files arrive as `{video-title}-clip.{ext}`.
- **Live progress** while the clip is built, then a direct browser save.
- **All-time download counter**, persisted in MongoDB.
- **Self-cleaning storage** — a clip is deleted the moment its download finishes, and an
  hourly sweep clears anything orphaned.

## How extraction works

ClipTube tries the user's own device before its backend, and falls back transparently:

| Stage | Preferred | Fallback |
| --- | --- | --- |
| Metadata | `youtube.com/oembed` + the IFrame player, both from the browser | `POST /api/resolve` (yt-dlp) |
| Media bytes | fetched by the browser, or captured from the embedded player | yt-dlp on the server |
| Trim / remux | `ffmpeg.wasm`, loaded lazily on first use | `ffmpeg` on the server |

Browser JavaScript cannot read YouTube's media URLs directly — `/youtubei/v1/player`
refuses cross-origin requests — so the fully client-side path records the embedded player
rather than downloading from the CDN. `GET /api/metrics` reports how often each path wins.

## Tech stack

**Frontend** — Vite · Vue 3 (`<script setup>`) · TypeScript · axios · `ffmpeg.wasm`
(lazy-loaded). Custom slider and modal, no UI framework. Light theme only.

**Backend** — Node.js · Express 5 · TypeScript · Mongoose / MongoDB · node-cron ·
fluent-ffmpeg.

**Media** — `ffmpeg.wasm` in the browser; `yt-dlp` and `ffmpeg` as child processes on the
server fallback.

---

Built by **Ashwani Singh** — [GitHub](https://github.com/ashwani2529) ·
[Portfolio](https://ashwanisingh-portfolio.netlify.app/)
