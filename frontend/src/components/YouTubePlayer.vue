<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadYouTubeIframeApi } from '../lib/youtube'

const PLAYING = 1
const ENDED = 0

const props = defineProps<{ videoId: string }>()

const emit = defineEmits<{
  /** Fired once the player is usable, with the video duration in seconds. */
  ready: [duration: number]
  /** Live playhead position while the video plays or after a seek. */
  time: [seconds: number]
  playing: [value: boolean]
  error: [message: string]
}>()

const host = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const failure = ref<string | null>(null)

let player: YT.Player | null = null
let pollId: number | null = null
let durationId: number | null = null

const ERRORS: Record<number, string> = {
  2: 'YouTube rejected that video id.',
  5: 'This video cannot be played in an embedded player.',
  100: 'That video was removed or is private.',
  101: 'The owner does not allow this video to be embedded.',
  150: 'The owner does not allow this video to be embedded.',
}

function stopPolling() {
  if (pollId !== null) {
    window.clearInterval(pollId)
    pollId = null
  }
}

/**
 * The IFrame API has no timeupdate event, so the playhead is sampled while the video
 * plays. 100ms keeps the slider marker smooth without flooding the postMessage bridge.
 */
function startPolling() {
  stopPolling()
  pollId = window.setInterval(() => {
    if (!player) return
    emit('time', player.getCurrentTime())
  }, 100)
}

/** Duration is 0 until metadata lands, so it's polled briefly after onReady. */
function watchForDuration() {
  if (durationId !== null) window.clearInterval(durationId)

  let attempts = 0
  durationId = window.setInterval(() => {
    attempts += 1
    const duration = player?.getDuration() ?? 0

    if (duration > 0) {
      emit('ready', duration)
      loading.value = false
      window.clearInterval(durationId as number)
      durationId = null
    } else if (attempts > 40) {
      window.clearInterval(durationId as number)
      durationId = null
      loading.value = false
      failure.value = 'Could not read the length of that video.'
      emit('error', failure.value)
    }
  }, 250)
}

/**
 * The IFrame API *replaces* the element it is given with an iframe, and `destroy()`
 * removes that iframe. So each player gets a throwaway child of the persistent host
 * element rather than the host itself — otherwise a re-mount would build its iframe
 * inside a node that is no longer in the document.
 */
function freshTarget(): HTMLElement | null {
  if (!host.value) return null
  host.value.replaceChildren()
  const target = document.createElement('div')
  host.value.appendChild(target)
  return target
}

async function mountPlayer(videoId: string) {
  loading.value = true
  failure.value = null

  try {
    const api = await loadYouTubeIframeApi()

    player?.destroy()
    player = null

    const target = freshTarget()
    if (!target) return

    player = new api.Player(target, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => watchForDuration(),
        onStateChange: (event) => {
          const isPlaying = event.data === PLAYING
          emit('playing', isPlaying)
          if (isPlaying) {
            startPolling()
          } else {
            stopPolling()
            // Report the resting position so the marker settles where the user paused.
            if (player) emit('time', player.getCurrentTime())
          }
          if (event.data === ENDED) emit('playing', false)
        },
        onError: (event) => {
          loading.value = false
          failure.value = ERRORS[event.data] ?? 'That video could not be loaded.'
          emit('error', failure.value)
        },
      },
    })
  } catch (error) {
    loading.value = false
    failure.value = error instanceof Error ? error.message : 'Could not load the player.'
    emit('error', failure.value)
  }
}

// Not `immediate`: the watcher would run during setup, before the host ref exists.
onMounted(() => void mountPlayer(props.videoId))
watch(() => props.videoId, (videoId) => void mountPlayer(videoId))

onBeforeUnmount(() => {
  stopPolling()
  if (durationId !== null) window.clearInterval(durationId)
  player?.destroy()
  player = null
})

/** YouTube quality ids by height, used to translate a requested resolution. */
const QUALITY_BY_HEIGHT: ReadonlyArray<readonly [number, string]> = [
  [4320, 'highres'],
  [2160, 'hd2160'],
  [1440, 'hd1440'],
  [1080, 'hd1080'],
  [720, 'hd720'],
  [480, 'large'],
  [360, 'medium'],
  [240, 'small'],
  [144, 'tiny'],
]

/**
 * Parent-driven controls. Beyond the slider and timestamp fields, this is the full
 * PlayerProbe + PlayerController surface the browser extraction path depends on — declaring
 * it here keeps every YouTube-specific call inside this component.
 */
defineExpose({
  seek(seconds: number, allowSeekAhead = true) {
    player?.seekTo(Math.max(0, seconds), allowSeekAhead)
  },
  play() {
    player?.playVideo()
  },
  pause() {
    player?.pauseVideo()
  },
  currentTime(): number {
    return player?.getCurrentTime() ?? 0
  },

  // --- PlayerProbe ---
  getDuration(): number {
    return player?.getDuration() ?? 0
  },
  getAvailableQualityLevels(): string[] {
    try {
      return player?.getAvailableQualityLevels() ?? []
    } catch {
      // The method is missing on very old embeds; an empty ladder just means the browser
      // source reports no formats and the server path takes over.
      return []
    }
  },

  // --- PlayerController ---
  getCurrentTime(): number {
    return player?.getCurrentTime() ?? 0
  },
  requestQuality(height: number) {
    const match = QUALITY_BY_HEIGHT.find(([threshold]) => height >= threshold)
    if (!match) return
    try {
      player?.setPlaybackQuality(match[1])
    } catch {
      // Advisory only — YouTube picks its own quality regardless.
    }
  },
  setMuted(muted: boolean) {
    if (muted) player?.mute()
    else player?.unMute()
  },
  getContainer(): HTMLElement | null {
    return host.value
  },
})
</script>

<template>
  <div class="player">
    <div ref="host" class="player-frame" />

    <Transition name="fade">
      <div v-if="loading || failure" class="player-veil">
        <span v-if="failure" class="player-message">{{ failure }}</span>
        <span v-else class="spinner" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  aspect-ratio: 16 / 9;
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--surface-sunken);
}

.player-frame,
.player-frame :deep(iframe) {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.player-veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  background: var(--surface-sunken);
  color: var(--text-muted);
}

.player-message {
  max-width: 32ch;
  font-size: 0.875rem;
}
</style>
