/**
 * Minimal typings for the YouTube IFrame Player API — only the members ClipTube uses.
 * https://developers.google.com/youtube/iframe_api_reference
 */
declare namespace YT {
  interface PlayerEvent {
    target: Player
  }

  interface OnStateChangeEvent extends PlayerEvent {
    /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
    data: number
  }

  interface OnErrorEvent extends PlayerEvent {
    data: number
  }

  interface PlayerVars {
    autoplay?: 0 | 1
    controls?: 0 | 1
    modestbranding?: 0 | 1
    rel?: 0 | 1
    playsinline?: 0 | 1
    disablekb?: 0 | 1
    origin?: string
    start?: number
  }

  interface PlayerOptions {
    videoId?: string
    width?: number | string
    height?: number | string
    playerVars?: PlayerVars
    events?: {
      onReady?: (event: PlayerEvent) => void
      onStateChange?: (event: OnStateChangeEvent) => void
      onError?: (event: OnErrorEvent) => void
    }
  }

  class Player {
    constructor(element: HTMLElement | string, options: PlayerOptions)
    playVideo(): void
    pauseVideo(): void
    seekTo(seconds: number, allowSeekAhead: boolean): void
    getCurrentTime(): number
    getDuration(): number
    getPlayerState(): number
    loadVideoById(videoId: string | { videoId: string; startSeconds?: number }): void
    /** Quality ids YouTube says it can serve, e.g. `['hd1080', 'hd720', 'medium']`. */
    getAvailableQualityLevels(): string[]
    /**
     * A hint only. YouTube has ignored this since it moved to adaptive streaming, so the
     * capture path treats the result as advisory and records what it actually got.
     */
    setPlaybackQuality(quality: string): void
    mute(): void
    unMute(): void
    isMuted(): boolean
    destroy(): void
  }
}

interface Window {
  YT?: typeof YT
  onYouTubeIframeAPIReady?: (() => void) | undefined
}
