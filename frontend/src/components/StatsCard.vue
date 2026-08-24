<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchStats } from '../lib/api'

const total = ref<number | null>(null)
const shown = ref(0)
const failed = ref(false)

let frame: number | null = null

/** Counts up to the new total so the number doesn't just snap into place. */
function animateTo(value: number) {
  if (frame !== null) cancelAnimationFrame(frame)

  const from = shown.value
  const distance = value - from
  if (distance === 0) return

  const duration = 600
  const startedAt = performance.now()

  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    // easeOutCubic
    const eased = 1 - (1 - progress) ** 3
    shown.value = Math.round(from + distance * eased)

    if (progress < 1) {
      frame = requestAnimationFrame(step)
    } else {
      frame = null
      shown.value = value
    }
  }

  frame = requestAnimationFrame(step)
}

async function refresh() {
  try {
    const stats = await fetchStats()
    failed.value = false
    total.value = stats.totalDownloads
  } catch {
    failed.value = true
  }
}

watch(total, (value) => {
  if (value !== null) animateTo(value)
})

onMounted(refresh)

onBeforeUnmount(() => {
  if (frame !== null) cancelAnimationFrame(frame)
})

defineExpose({ refresh })
</script>

<template>
  <section class="stats card">
    <p class="stats-number mono">
      <template v-if="total === null">{{ failed ? '—' : '·' }}</template>
      <template v-else>{{ shown.toLocaleString() }}</template>
    </p>
    <p class="stats-label">Total Downloads</p>
    <p v-if="failed" class="stats-note muted">Stats are unavailable right now.</p>
  </section>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 30px 26px;
  text-align: center;
}

.stats-number {
  font-size: 2.75rem;
  line-height: 1.1;
  font-weight: 550;
  letter-spacing: -0.03em;
  color: var(--accent);
}

.stats-label {
  font-size: 0.8125rem;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.stats-note {
  margin-top: 6px;
  font-size: 0.75rem;
}
</style>
