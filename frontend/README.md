# ClipTube — frontend

Vite + Vue 3 + TypeScript single-page app.

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api to http://localhost:4000)
npm run build    # type-check + production bundle into dist/
npm run preview  # serve the built bundle
```

The backend must be running for format lookup, clipping and stats to work. See the
[root README](../README.md) for full setup instructions.

## Layout

| Path | Purpose |
| --- | --- |
| `src/components/ClipStudio.vue` | URL box, player, slider, timestamps, Clip button |
| `src/components/YouTubePlayer.vue` | YouTube IFrame Player API wrapper |
| `src/components/RangeSlider.vue` | Custom dual-handle range slider |
| `src/components/TimeField.vue` | Validated `hh:mm:ss` input |
| `src/components/ClipDialog.vue` | Video / Audio / Preview Info tabs + downloads |
| `src/components/StatsCard.vue` | All-time download counter |
| `src/components/AppFooter.vue` | Credits |
| `src/lib/` | API client, clip-job polling, time helpers, IFrame API loader |
| `src/style.css` | Design tokens and shared primitives |
