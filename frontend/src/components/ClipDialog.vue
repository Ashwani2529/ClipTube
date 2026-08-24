<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatBytes, formatClock, formatDuration } from '../lib/time'
import { useClipJob } from '../lib/useClipJob'
import type { ClipRange, ClipType, FormatsResponse } from '../types'

type Tab = 'video' | 'audio' | 'info'

const props = defineProps<{
  open: boolean
  loading: boolean
  error: string | null
  formats: FormatsResponse | null
  url: string
  range: ClipRange
}>()

const emit = defineEmits<{
  close: []
  /** Fires as soon as a job is created, so the stats card can refresh. */
  started: []
  retry: []
}>()

const TABS: { key: Tab; label: string }[] = [
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'info', label: 'Preview Info' },
]

const tab = ref<Tab>('video')
const videoFormatId = ref<string | null>(null)
const audioFormatId = ref<string | null>(null)
const dialogEl = ref<HTMLDivElement | null>(null)

const {
  phase: jobPhase,
  progress: jobProgress,
  message: jobMessage,
  error: jobError,
  fileName: jobFileName,
  start: startJob,
  reset: resetJob,
} = useClipJob()

const meta = computed(() => props.formats?.meta ?? null)
const videoOptions = computed(() => props.formats?.video ?? [])
const audioGroups = computed(() => props.formats?.audio ?? [])
const clipSeconds = computed(() => Math.max(0, props.range.end - props.range.start))

const busy = computed(() => jobPhase.value === 'starting' || jobPhase.value === 'working')

/** The audio tier currently selected, used for the summary line. */
const selectedAudio = computed(() => {
  for (const group of audioGroups.value) {
    const tier = group.tiers.find((candidate) => candidate.formatId === audioFormatId.value)
    if (tier) return { group, tier }
  }
  return null
})

const selectedVideo = computed(
  () => videoOptions.value.find((option) => option.formatId === videoFormatId.value) ?? null,
)

/** Preselect a sensible default whenever a fresh format list arrives. */
watch(
  () => props.formats,
  (formats) => {
    if (!formats) return

    // 1080p if it exists, otherwise the highest resolution offered.
    const preferred =
      formats.video.find((option) => option.height === 1080) ?? formats.video[0] ?? null
    videoFormatId.value = preferred?.formatId ?? null

    const firstGroup = formats.audio[0]
    audioFormatId.value = firstGroup?.tiers[0]?.formatId ?? null

    tab.value = formats.video.length > 0 ? 'video' : formats.audio.length > 0 ? 'audio' : 'info'
  },
  { immediate: true },
)

function close() {
  if (busy.value) return
  resetJob()
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
}

// Escape closes the dialog wherever focus happens to be, and the page behind it
// shouldn't scroll while the modal is up.
watch(
  () => props.open,
  (open) => {
    if (open) {
      resetJob()
      window.addEventListener('keydown', onKeydown)
      document.body.style.overflow = 'hidden'
      void Promise.resolve().then(() => dialogEl.value?.focus())
    } else {
      window.removeEventListener('keydown', onKeydown)
      document.body.style.overflow = ''
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

function onBackdrop(event: MouseEvent | PointerEvent) {
  if (event.target === event.currentTarget) close()
}

async function download(type: ClipType) {
  const formatId = type === 'video' ? videoFormatId.value : audioFormatId.value
  if (!formatId) return

  const jobId = await startJob({
    url: props.url,
    start: props.range.start,
    end: props.range.end,
    type,
    formatId,
  })

  if (jobId) emit('started')
}

const targetExtension = computed(() => {
  if (tab.value === 'audio') return selectedAudio.value?.group.ext ?? 'm4a'
  return 'mp4'
})

/**
 * yt-dlp reports sizes for the whole video, so scale them down to the selected range —
 * otherwise a 12-second clip advertises the full 40 MB download.
 */
function clipSize(fullBytes: number | null): string | null {
  const total = meta.value?.durationSeconds ?? 0
  if (!fullBytes || total <= 0) return null
  return formatBytes(fullBytes * Math.min(1, clipSeconds.value / total))
}
</script>

<template>
  <Transition name="dialog">
    <div v-if="open" class="backdrop" @pointerdown="onBackdrop">
      <div
        ref="dialogEl"
        class="dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-dialog-title"
        tabindex="-1"
      >
        <header class="dialog-head">
          <div class="dialog-heading">
            <span class="eyebrow">Download clip</span>
            <h2 id="clip-dialog-title">{{ meta?.title ?? 'Fetching formats…' }}</h2>
          </div>
          <button
            class="btn btn-quiet dialog-close"
            type="button"
            aria-label="Close"
            :disabled="busy"
            @click="close"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
          </button>
        </header>

        <div v-if="loading" class="dialog-state">
          <span class="spinner" />
          <p>Asking yt-dlp what this video offers…</p>
        </div>

        <div v-else-if="error" class="dialog-state">
          <p class="notice">{{ error }}</p>
          <button class="btn btn-soft" type="button" @click="emit('retry')">Try again</button>
        </div>

        <template v-else-if="formats">
          <nav class="tabs" role="tablist">
            <button
              v-for="entry in TABS"
              :key="entry.key"
              class="tab"
              :class="{ 'is-active': tab === entry.key }"
              type="button"
              role="tab"
              :aria-selected="tab === entry.key"
              @click="tab = entry.key"
            >
              {{ entry.label }}
            </button>
          </nav>

          <div class="dialog-body">
            <!-- Video -->
            <div v-if="tab === 'video'" class="panel" role="tabpanel">
              <p v-if="videoOptions.length === 0" class="muted panel-empty">
                yt-dlp reported no video formats for this URL.
              </p>

              <ul v-else class="options">
                <li v-for="option in videoOptions" :key="option.formatId">
                  <label class="option" :class="{ 'is-selected': videoFormatId === option.formatId }">
                    <input
                      v-model="videoFormatId"
                      class="option-radio"
                      type="radio"
                      name="video-format"
                      :value="option.formatId"
                      :disabled="busy"
                    />
                    <span class="option-main">
                      <span class="option-title">{{ option.label }}</span>
                      <span class="option-meta">
                        {{ option.vcodec }} · {{ option.ext }}
                        <template v-if="option.hasAudio"> · audio included</template>
                        <template v-else> · audio merged in</template>
                      </span>
                    </span>
                    <span
                      v-if="clipSize(option.filesizeBytes)"
                      class="option-size mono"
                      title="Estimated size of the selected range"
                    >
                      ~{{ clipSize(option.filesizeBytes) }}
                    </span>
                  </label>
                </li>
              </ul>
            </div>

            <!-- Audio -->
            <div v-else-if="tab === 'audio'" class="panel" role="tabpanel">
              <p v-if="audioGroups.length === 0" class="muted panel-empty">
                yt-dlp reported no audio-only formats for this URL.
              </p>

              <div v-for="group in audioGroups" :key="group.codec" class="group">
                <h3 class="group-title">{{ group.label }}</h3>
                <ul class="options">
                  <li v-for="tier in group.tiers" :key="tier.formatId">
                    <label class="option" :class="{ 'is-selected': audioFormatId === tier.formatId }">
                      <input
                        v-model="audioFormatId"
                        class="option-radio"
                        type="radio"
                        name="audio-format"
                        :value="tier.formatId"
                        :disabled="busy"
                      />
                      <span class="option-main">
                        <span class="option-title">{{ tier.label }}</span>
                        <span class="option-meta">
                          .{{ group.ext }}
                          <template v-if="tier.sampleRate">
                            · {{ Math.round(tier.sampleRate / 1000) }} kHz
                          </template>
                          <template v-if="tier.note"> · {{ tier.note }}</template>
                        </span>
                      </span>
                      <span
                        v-if="clipSize(tier.filesizeBytes)"
                        class="option-size mono"
                        title="Estimated size of the selected range"
                      >
                        ~{{ clipSize(tier.filesizeBytes) }}
                      </span>
                    </label>
                  </li>
                </ul>
              </div>
            </div>

            <!-- Preview info -->
            <div v-else class="panel" role="tabpanel">
              <div class="info">
                <img
                  v-if="meta?.thumbnail"
                  class="info-thumb"
                  :src="meta.thumbnail"
                  :alt="`Thumbnail for ${meta.title}`"
                  loading="lazy"
                />
                <dl class="info-list">
                  <div class="info-row">
                    <dt>Title</dt>
                    <dd>{{ meta?.title }}</dd>
                  </div>
                  <div v-if="meta?.uploader" class="info-row">
                    <dt>Channel</dt>
                    <dd>{{ meta.uploader }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>Full length</dt>
                    <dd class="mono">{{ formatDuration(meta?.durationSeconds ?? 0) }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>Selected range</dt>
                    <dd class="mono">
                      {{ formatClock(range.start) }} → {{ formatClock(range.end) }}
                    </dd>
                  </div>
                  <div class="info-row">
                    <dt>Clip length</dt>
                    <dd class="mono">{{ formatDuration(clipSeconds) }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>Video pick</dt>
                    <dd>{{ selectedVideo ? selectedVideo.label : 'none selected' }}</dd>
                  </div>
                  <div class="info-row">
                    <dt>Audio pick</dt>
                    <dd>
                      {{
                        selectedAudio
                          ? `${selectedAudio.group.label} · ${selectedAudio.tier.label}`
                          : 'none selected'
                      }}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>

          <footer class="dialog-foot">
            <div class="foot-status">
              <template v-if="jobError">
                <p class="notice">{{ jobError }}</p>
              </template>
              <template v-else-if="jobPhase === 'ready'">
                <p class="foot-done">Saved{{ jobFileName ? ` as ${jobFileName}` : '' }}.</p>
              </template>
              <template v-else-if="busy">
                <div
                  class="progress"
                  role="progressbar"
                  :aria-valuenow="jobProgress > 0 ? jobProgress : undefined"
                >
                  <!-- Until yt-dlp reports a size there is no percentage to show, so the
                       bar runs indeterminate rather than sitting at a frozen-looking 0%. -->
                  <div
                    v-if="jobProgress > 0"
                    class="progress-fill"
                    :style="{ width: `${jobProgress}%` }"
                  />
                  <div v-else class="progress-pending" />
                </div>
                <p class="foot-message">{{ jobMessage }}</p>
              </template>
              <template v-else>
                <p class="foot-message muted">
                  {{ formatDuration(clipSeconds) }} clip · saved as .{{ targetExtension }}
                </p>
              </template>
            </div>

            <button
              v-if="tab === 'video'"
              class="btn btn-primary"
              type="button"
              :disabled="busy || !videoFormatId"
              @click="download('video')"
            >
              <span v-if="busy" class="spinner" />
              {{ busy ? 'Working…' : 'Download video' }}
            </button>

            <button
              v-else-if="tab === 'audio'"
              class="btn btn-primary"
              type="button"
              :disabled="busy || !audioFormatId"
              @click="download('audio')"
            >
              <span v-if="busy" class="spinner" />
              {{ busy ? 'Working…' : 'Download audio' }}
            </button>

            <button v-else class="btn btn-soft" type="button" @click="tab = 'video'">
              Choose a format
            </button>
          </footer>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(44, 47, 61, 0.22);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(88svh, 720px);
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 24px 24px 18px;
}

.dialog-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.dialog-heading h2 {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.dialog-close {
  flex: none;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
}

.dialog-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 24px 34px;
  color: var(--text-muted);
  font-size: 0.9375rem;
  text-align: center;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}

.tab {
  position: relative;
  padding: 10px 14px 13px;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition:
    color 0.18s var(--ease),
    background-color 0.18s var(--ease);
}

.tab:hover {
  color: var(--text-strong);
  background: var(--surface-sunken);
}

.tab.is-active {
  color: var(--accent-hover);
}

.tab.is-active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 4px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: panel-in 0.2s var(--ease);
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

.panel-empty {
  font-size: 0.9375rem;
  padding: 8px 0 16px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-title {
  color: var(--text-muted);
  font-size: 0.8125rem;
  font-weight: 550;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.option {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition:
    border-color 0.18s var(--ease),
    background-color 0.18s var(--ease);
}

.option:hover {
  background: var(--surface-sunken);
}

.option.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.option-radio {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  margin: 0;
  cursor: pointer;
}

.option-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.option-title {
  color: var(--text-strong);
  font-size: 0.9375rem;
  font-weight: 500;
}

.option-meta {
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.option-size {
  flex: none;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.info-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius);
  background: var(--surface-sunken);
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
  margin: 0;
}

.info-row {
  display: grid;
  grid-template-columns: 118px 1fr;
  gap: 14px;
  align-items: baseline;
  font-size: 0.875rem;
}

.info-row dt {
  color: var(--text-muted);
}

.info-row dd {
  margin: 0;
  color: var(--text-strong);
  overflow-wrap: anywhere;
}

.dialog-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px 22px;
  border-top: 1px solid var(--border);
}

.foot-status {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.foot-message {
  font-size: 0.8125rem;
}

.foot-done {
  font-size: 0.8125rem;
  color: var(--accent-hover);
  overflow-wrap: anywhere;
}

.progress {
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--accent);
  transition: width 0.3s var(--ease);
}

.progress-pending {
  height: 100%;
  width: 35%;
  border-radius: var(--radius-pill);
  background: var(--accent);
  opacity: 0.55;
  animation: progress-slide 1.4s var(--ease) infinite;
}

@keyframes progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(286%);
  }
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s var(--ease);
}
.dialog-enter-active .dialog,
.dialog-leave-active .dialog {
  transition:
    opacity 0.2s var(--ease),
    transform 0.24s var(--ease);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .dialog,
.dialog-leave-to .dialog {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}

@media (max-width: 560px) {
  .dialog-head,
  .tabs,
  .dialog-body,
  .dialog-foot {
    padding-left: 18px;
    padding-right: 18px;
  }

  .dialog-foot {
    flex-direction: column;
    align-items: stretch;
  }

  .info-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
