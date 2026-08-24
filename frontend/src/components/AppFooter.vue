<template>
  <footer class="footer">
    <p class="footer-credit">Built by Ashwani Singh</p>

    <div class="footer-links">
      <a
        class="footer-link"
        href="https://github.com/ashwani2529"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Ashwani Singh on GitHub"
        title="GitHub"
      >
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38l-.01-1.49c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.14.46.55.38A8 8 0 0 0 8 0Z"
          />
        </svg>
      </a>

      <a
        class="footer-link"
        href="https://ashwanisingh-portfolio.netlify.app/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Ashwani Singh's portfolio"
        title="Portfolio"
      >
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6.4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M1.6 8h12.8M8 1.6c1.9 2 1.9 10.8 0 12.8M8 1.6c-1.9 2-1.9 10.8 0 12.8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </a>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 34px 0 8px;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.footer-credit {
  letter-spacing: -0.005em;
}

.footer-links {
  display: flex;
  gap: 8px;
}

.footer-link {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--text-muted);
  background: transparent;
  transition:
    color 0.18s var(--ease),
    background-color 0.18s var(--ease),
    transform 0.18s var(--ease);
}

.footer-link:hover {
  color: var(--accent-hover);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
</style>
