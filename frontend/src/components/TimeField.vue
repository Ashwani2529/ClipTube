<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatClock, parseClock } from '../lib/time'

const props = withDefaults(
  defineProps<{
    modelValue: number
    label: string
    min?: number
    max?: number
    disabled?: boolean
  }>(),
  { min: 0, max: Number.POSITIVE_INFINITY, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [seconds: number]
  /** Emitted when editing settles, so the parent can seek the player. */
  commit: [seconds: number]
}>()

const text = ref(formatClock(props.modelValue))
const focused = ref(false)
const invalid = ref(false)

// While the field has focus the user owns the text; outside changes (slider drags) win.
watch(
  () => props.modelValue,
  (seconds) => {
    if (focused.value) return
    text.value = formatClock(seconds)
    invalid.value = false
  },
)

const clampedMax = computed(() =>
  Number.isFinite(props.max) ? Math.max(props.min, props.max) : Number.POSITIVE_INFINITY,
)

const hint = computed(() => (invalid.value ? 'Use hh:mm:ss' : null))

function commit(raw: string, final: boolean): void {
  const parsed = parseClock(raw)

  if (parsed === null) {
    invalid.value = true
    return
  }

  invalid.value = false
  const clamped = Math.min(clampedMax.value, Math.max(props.min, parsed))

  emit('update:modelValue', clamped)
  if (final) {
    text.value = formatClock(clamped)
    emit('commit', clamped)
  }
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  text.value = value
  commit(value, false)
}

function onBlur() {
  focused.value = false
  const parsed = parseClock(text.value)
  if (parsed === null) {
    // Nothing usable typed — snap back to the authoritative value.
    text.value = formatClock(props.modelValue)
    invalid.value = false
    return
  }
  commit(text.value, true)
}

function onEnter(event: KeyboardEvent) {
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <label class="time-field">
    <span class="eyebrow">{{ label }}</span>
    <input
      v-model="text"
      class="field mono time-input"
      :class="{ 'is-invalid': invalid }"
      type="text"
      inputmode="numeric"
      placeholder="00:00:00"
      autocomplete="off"
      spellcheck="false"
      maxlength="11"
      :disabled="disabled"
      :aria-invalid="invalid"
      @focus="focused = true"
      @input="onInput"
      @blur="onBlur"
      @keydown.enter="onEnter"
    />
    <Transition name="fade">
      <span v-if="hint" class="time-hint">{{ hint }}</span>
    </Transition>
  </label>
</template>

<style scoped>
.time-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  position: relative;
}

.time-input {
  padding: 11px 14px;
  font-size: 0.9375rem;
  letter-spacing: 0.02em;
}

.time-hint {
  position: absolute;
  top: calc(100% + 5px);
  left: 2px;
  font-size: 0.75rem;
  color: var(--danger);
}
</style>
