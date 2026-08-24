<script setup lang="ts">
import { computed, ref } from 'vue'
import ClipDialog from './ClipDialog.vue'
import RangeSlider from './RangeSlider.vue'
import TimeField from './TimeField.vue'
import YouTubePlayer from './YouTubePlayer.vue'
import { describeError, fetchFormats } from '../lib/api'
import { extractVideoId } from '../lib/youtube'
import { formatDuration } from '../lib/time'
import type { ClipRange, FormatsResponse } from '../types'

/** Matches the slider and the backend minimum clip length. */
const MIN_GAP = 0.5
/** seekTo() goes over postMessage; throttling keeps dragging smooth. */
const SEEK_THROTTLE_MS = 120

const emit = defineEmits<{ downloadStarted: [] }>()

const urlText = ref('')
const urlError = ref<string | null>(null)

const videoId = ref<string | null>(null)
const duration = ref(0)
const playhead = ref(0)
const range = ref<ClipRange>({ start: 0, end: 0 })
const playerError = ref<string | null>(null)

const dialogOpen = ref(false)
const formats = ref<FormatsResponse | null>(null)
const formatsLoading = ref(false)
const formatsError = ref<string | null>(null)

const player = ref<InstanceType<typeof YouTubePlayer> | null>(null)

const canonicalUrl = computed(() =>
  videoId.value ? `https://www.youtube.com/watch?v=${videoId.value}` : '',
)
const ready = computed(() => Boolean(videoId.value) && duration.value > 0)
const clipSeconds = computed(() => Math.max(0, range.value.end - range.value.start))

function loadUrl() {
  const id = extractVideoId(urlText.value)

  if (!id) {
    urlError.value = 'Paste a YouTube link, for example youtube.com/watch?v=… or youtu.be/…'
    return
  }

  urlError.value = null
  playerError.value = null
  formats.value = null
  formatsError.value = null
  duration.value = 0
  playhead.value = 0
  range.value = { start: 0, end: 0 }
  videoId.value = id
}

function onPlayerReady(seconds: number) {
  duration.value = seconds
  // The slider spans the whole video, and the whole video starts out selected.
  range.value = { start: 0, end: seconds }
}

function onPlayerError(message: string) {
  playerError.value = message
  duration.value = 0
}

let lastSeekAt = 0

/** Called continuously while a handle is dragged. */
function onScrub(seconds: number) {
  playhead.value = seconds

  const now = performance.now()
  if (now - lastSeekAt < SEEK_THROTTLE_MS) return
  lastSeekAt = now
  player.value?.seek(seconds, false)
}

function onDragStateChange(dragging: boolean) {
  if (dragging) return
  // Commit the final position once the handle is released.
  player.value?.seek(playhead.value, true)
}

function seekTo(seconds: number) {
  playhead.value = seconds
  player.value?.seek(seconds, true)
}

function playSelection() {
  player.value?.seek(range.value.start, true)
  player.value?.play()
}

async function openClipDialog() {
  if (!ready.value) return

  dialogOpen.value = true
  formatsLoading.value = true
  formatsError.value = null

  try {
    formats.value = await fetchFormats(canonicalUrl.value)
  } catch (error) {
    formats.value = null
    formatsError.value = describeError(error, 'Could not read the formats for this video.')
  } finally {
    formatsLoading.value = false
  }
}
</script>

<template>
  <section class="studio card">
    <form class="url-row" @submit.prevent="loadUrl">
      <div class="url-field">
        <label class="eyebrow" for="youtube-url">YouTube URL</label>
        <input
          id="youtube-url"
          v-model="urlText"
          class="field"
          :class="{ 'is-invalid': !!urlError }"
          type="url"
          inputmode="url"
          placeholder="https://www.youtube.com/watch?v=…"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="!!urlError"
          @input="urlError = null"
        />
      </div>
      <button class="btn btn-primary url-submit" type="submit">Load</button>
    </form>

    <Transition name="fade">
      <p v-if="urlError" class="notice">{{ urlError }}</p>
    </Transition>

    <Transition name="fade">
      <div v-if="videoId" class="stage">
        <YouTubePlayer
          ref="player"
          :video-id="videoId"
          @ready="onPlayerReady"
          @time="playhead = $event"
          @error="onPlayerError"
        />

        <div v-if="playerError" class="notice">{{ playerError }}</div>

        <template v-else>
          <RangeSlider
            v-model="range"
            :duration="duration"
            :playhead="playhead"
            :disabled="!ready"
            @scrub="onScrub"
            @seek="seekTo"
            @drag-state-change="onDragStateChange"
          />

          <div class="timestamps">
            <TimeField
              v-model="range.start"
              label="Start"
              :min="0"
              :max="Math.max(0, range.end - MIN_GAP)"
              :disabled="!ready"
              @commit="seekTo"
            />
            <span class="timestamps-arrow" aria-hidden="true">→</span>
            <TimeField
              v-model="range.end"
              label="End"
              :min="Math.min(duration, range.start + MIN_GAP)"
              :max="duration"
              :disabled="!ready"
              @commit="seekTo"
            />
          </div>

          <div class="actions">
            <button
              class="btn btn-quiet action-preview"
              type="button"
              :disabled="!ready"
              @click="playSelection"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M4.5 3.2v9.6l8-4.8z" fill="currentColor" />
              </svg>
              Play selection
            </button>

            <button
              class="btn btn-primary action-clip"
              type="button"
              :disabled="!ready || clipSeconds < MIN_GAP"
              @click="openClipDialog"
            >
              Clip {{ formatDuration(clipSeconds) }}
            </button>
          </div>
        </template>
      </div>
    </Transition>

    <p v-if="!videoId" class="empty muted">
      Paste a link to preview the video, then drag the handles to pick the part you want.
    </p>

    <ClipDialog
      :open="dialogOpen"
      :loading="formatsLoading"
      :error="formatsError"
      :formats="formats"
      :url="canonicalUrl"
      :range="range"
      @close="dialogOpen = false"
      @retry="openClipDialog"
      @started="emit('downloadStarted')"
    />
  </section>
</template>

<style scoped>
.studio {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 26px;
}

.url-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.url-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.url-submit {
  flex: none;
  padding: 12px 26px;
}

.stage {
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.timestamps {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: 14px;
}

.timestamps-arrow {
  padding-bottom: 12px;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.action-preview {
  padding: 9px 16px;
  font-size: 0.875rem;
}

.action-clip {
  min-width: 160px;
}

.empty {
  font-size: 0.9375rem;
  text-align: center;
  padding: 10px 0 6px;
}

@media (max-width: 600px) {
  .studio {
    padding: 20px;
    gap: 18px;
  }

  .url-row {
    flex-direction: column;
    align-items: stretch;
  }

  .url-submit {
    width: 100%;
  }

  .timestamps {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .timestamps-arrow {
    display: none;
  }

  .actions {
    flex-direction: column-reverse;
    align-items: stretch;
  }

  .action-clip,
  .action-preview {
    width: 100%;
  }
}
</style>
