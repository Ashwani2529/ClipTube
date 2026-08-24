<script setup lang="ts">
import { ref } from 'vue'
import AppFooter from './components/AppFooter.vue'
import ClipStudio from './components/ClipStudio.vue'
import StatsCard from './components/StatsCard.vue'

const stats = ref<InstanceType<typeof StatsCard> | null>(null)

// The counter increments the moment a job is created, so refresh as soon as one starts.
function onDownloadStarted() {
  void stats.value?.refresh()
}
</script>

<template>
  <div class="page">
    <header class="masthead">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <span class="brand-name">ClipTube</span>
      </div>
      <h1>Take just the part you need.</h1>
      <p class="tagline">
        Preview any YouTube video, mark a range, and download that slice as video or audio.
      </p>
    </header>

    <main class="stack">
      <ClipStudio @download-started="onDownloadStarted" />
      <StatsCard ref="stats" />
    </main>

    <AppFooter />
  </div>
</template>

<style scoped>
.page {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 64px 20px 40px;
  display: flex;
  flex-direction: column;
}

.masthead {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  margin-bottom: 38px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 14px 6px 10px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
}

.brand-mark {
  width: 9px;
  height: 16px;
  border-radius: 5px;
  background: var(--accent);
}

.brand-name {
  font-size: 0.8125rem;
  font-weight: 550;
  letter-spacing: 0.02em;
  color: var(--accent-hover);
}

.tagline {
  max-width: 46ch;
  font-size: 1rem;
  color: var(--text-muted);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

@media (max-width: 600px) {
  .page {
    padding: 40px 16px 32px;
  }

  .masthead {
    margin-bottom: 28px;
  }

  h1 {
    font-size: 1.625rem;
  }

  .tagline {
    font-size: 0.9375rem;
  }
}
</style>
