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
- **Precise cuts** — the section is fetched with keyframes forced at the cut points, then
  probed and trimmed if it overruns.
- **No transcoding** — the `ffmpeg` pass is a stream copy that only fixes the container and
  moves the mp4 index to the front for instant seeking.
- **Named output** — files arrive as `{video-title}-clip.{ext}`.
- **Live progress** while the clip is built, then a direct browser save.
- **All-time download counter**, persisted in MongoDB.
- **Self-cleaning storage** — a clip is deleted the moment its download finishes, and an
  hourly sweep clears anything orphaned.

## Tech stack

**Frontend** — Vite · Vue 3 (`<script setup>`) · TypeScript · axios. Custom slider and
modal, no UI framework. Light theme only.

**Backend** — Node.js · Express 5 · TypeScript · Mongoose / MongoDB · node-cron ·
fluent-ffmpeg.

**Media** — `yt-dlp` and `ffmpeg`, spawned as child processes.

---

Built by **Ashwani Singh** — [GitHub](https://github.com/ashwani2529) ·
[Portfolio](https://ashwanisingh-portfolio.netlify.app/)
