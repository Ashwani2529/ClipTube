<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { formatClock, formatDuration } from '../lib/time'
import type { ClipRange } from '../types'

/** Smallest selectable clip, matched to the backend's minimum. */
const MIN_GAP = 0.5

type Handle = 'start' | 'end'

const props = withDefaults(
  defineProps<{
    modelValue: ClipRange
    duration: number
    playhead?: number
    disabled?: boolean
  }>(),
  { playhead: 0, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: ClipRange]
  /** Dragging a handle should move the player with it. */
  scrub: [seconds: number]
  /** Clicking the rail seeks without changing the selection. */
  seek: [seconds: number]
  dragStateChange: [dragging: boolean]
}>()

const rail = ref<HTMLDivElement | null>(null)
const active = ref<Handle | null>(null)

const usable = computed(() => props.duration > 0 && !props.disabled)

const percent = (seconds: number): number => {
  if (props.duration <= 0) return 0
  return Math.min(100, Math.max(0, (seconds / props.duration) * 100))
}

const startPercent = computed(() => percent(props.modelValue.start))
const endPercent = computed(() => percent(props.modelValue.end))
const playheadPercent = computed(() => percent(props.playhead))
const selectedSeconds = computed(() =>
  Math.max(0, props.modelValue.end - props.modelValue.start),
)

/** Maps a pointer position on the rail to a time in seconds. */
function timeAt(clientX: number): number {
  const box = rail.value?.getBoundingClientRect()
  if (!box || box.width === 0) return 0
  const ratio = (clientX - box.left) / box.width
  return Math.min(props.duration, Math.max(0, ratio * props.duration))
}

function apply(handle: Handle, seconds: number) {
  const { start, end } = props.modelValue

  const next: ClipRange =
    handle === 'start'
      ? { start: Math.min(seconds, end - MIN_GAP), end }
      : { start, end: Math.max(seconds, start + MIN_GAP) }

  next.start = Math.max(0, next.start)
  next.end = Math.min(props.duration, next.end)

  emit('update:modelValue', next)
  emit('scrub', handle === 'start' ? next.start : next.end)
}

function onPointerMove(event: PointerEvent) {
  if (!active.value) return
  event.preventDefault()
  apply(active.value, timeAt(event.clientX))
}

function stopDragging() {
  if (!active.value) return
  active.value = null
  emit('dragStateChange', false)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopDragging)
  window.removeEventListener('pointercancel', stopDragging)
}

function startDragging(handle: Handle, event: PointerEvent) {
  if (!usable.value) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement | null)?.focus()

  active.value = handle
  emit('dragStateChange', true)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)
}

/** Clicking anywhere on the rail scrubs the player to that point. */
function onRailPointerDown(event: PointerEvent) {
  if (!usable.value || active.value) return
  emit('seek', timeAt(event.clientX))
}

function onKeydown(handle: Handle, event: KeyboardEvent) {
  if (!usable.value) return

  const step = event.shiftKey ? 5 : 1
  const current = handle === 'start' ? props.modelValue.start : props.modelValue.end

  let next: number | null = null
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step
  else if (event.key === 'Home') next = handle === 'start' ? 0 : props.modelValue.start + MIN_GAP
  else if (event.key === 'End')
    next = handle === 'start' ? props.modelValue.end - MIN_GAP : props.duration

  if (next === null) return
  event.preventDefault()
  apply(handle, next)
}

onBeforeUnmount(stopDragging)
</script>

<template>
  <div class="slider" :class="{ 'is-dragging': !!active, 'is-disabled': !usable }">
    <div class="slider-summary">
      <span class="eyebrow">Selection</span>
      <span class="mono slider-length">{{ formatDuration(selectedSeconds) }}</span>
    </div>

    <div class="slider-rail-area">
      <div ref="rail" class="slider-rail" @pointerdown="onRailPointerDown">
        <div
          class="slider-selection"
          :style="{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }"
        />

        <div
          v-show="usable"
          class="slider-playhead"
          :style="{ left: `${playheadPercent}%` }"
          aria-hidden="true"
        />

        <div
          class="slider-handle"
          :class="{ 'is-active': active === 'start' }"
          :style="{ left: `${startPercent}%` }"
          role="slider"
          :tabindex="usable ? 0 : -1"
          :aria-disabled="!usable"
          aria-label="Clip start"
          :aria-valuemin="0"
          :aria-valuemax="Math.max(0, modelValue.end - MIN_GAP)"
          :aria-valuenow="Math.round(modelValue.start)"
          :aria-valuetext="formatClock(modelValue.start)"
          @pointerdown="startDragging('start', $event)"
          @keydown="onKeydown('start', $event)"
        >
          <span class="slider-tip mono">{{ formatClock(modelValue.start) }}</span>
        </div>

        <div
          class="slider-handle"
          :class="{ 'is-active': active === 'end' }"
          :style="{ left: `${endPercent}%` }"
          role="slider"
          :tabindex="usable ? 0 : -1"
          :aria-disabled="!usable"
          aria-label="Clip end"
          :aria-valuemin="Math.min(duration, modelValue.start + MIN_GAP)"
          :aria-valuemax="duration"
          :aria-valuenow="Math.round(modelValue.end)"
          :aria-valuetext="formatClock(modelValue.end)"
          @pointerdown="startDragging('end', $event)"
          @keydown="onKeydown('end', $event)"
        >
          <span class="slider-tip mono">{{ formatClock(modelValue.end) }}</span>
        </div>
      </div>

      <div class="slider-scale mono">
        <span>0:00</span>
        <span>{{ formatDuration(duration) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slider {
  --handle: 20px;
}

.slider-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.slider-length {
  font-size: 0.875rem;
  color: var(--text-strong);
}

.slider-rail-area {
  padding: 0 calc(var(--handle) / 2);
}

.slider-rail {
  position: relative;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  box-shadow: inset 0 0 0 1px var(--border);
  cursor: pointer;
  touch-action: none;
}

.is-disabled .slider-rail {
  cursor: default;
}

.slider-selection {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--accent);
  opacity: 0.28;
  border-radius: var(--radius-pill);
  transition: opacity 0.18s var(--ease);
  pointer-events: none;
}

.is-dragging .slider-selection {
  opacity: 0.4;
}

.slider-playhead {
  position: absolute;
  top: -5px;
  bottom: -5px;
  width: 2px;
  border-radius: 2px;
  background: var(--text-strong);
  opacity: 0.35;
  transform: translateX(-1px);
  pointer-events: none;
}

.slider-handle {
  position: absolute;
  top: 50%;
  width: var(--handle);
  height: var(--handle);
  margin: calc(var(--handle) / -2) 0 0 calc(var(--handle) / -2);
  border-radius: 50%;
  background: var(--surface);
  box-shadow:
    inset 0 0 0 2px var(--accent),
    var(--shadow-sm);
  cursor: grab;
  touch-action: none;
  transition:
    transform 0.18s var(--ease),
    box-shadow 0.18s var(--ease);
}

.slider-handle:hover {
  transform: scale(1.1);
}

.slider-handle.is-active {
  cursor: grabbing;
  transform: scale(1.18);
  box-shadow:
    inset 0 0 0 2px var(--accent),
    0 0 0 6px var(--accent-ring);
}

.is-disabled .slider-handle {
  cursor: default;
  box-shadow:
    inset 0 0 0 2px var(--border-strong),
    var(--shadow-xs);
}
.is-disabled .slider-handle:hover {
  transform: none;
}

.slider-tip {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  color: var(--text-strong);
  font-size: 0.75rem;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.18s var(--ease),
    transform 0.18s var(--ease);
}

.slider-handle:hover .slider-tip,
.slider-handle:focus-visible .slider-tip,
.slider-handle.is-active .slider-tip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.slider-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
  font-size: 0.75rem;
  color: var(--text-muted);
}
</style>
