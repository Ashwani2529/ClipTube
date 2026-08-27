import { reportTelemetry } from '../lib/api'
import { platformTag } from './capabilities'
import type { ClipErrorCode } from './youtube/errors'
import type { AcquisitionMode, StrategyName } from './youtube/types'

/**
 * Operational telemetry for the browser-first experiment.
 *
 * The question this exists to answer is a single number: what share of clips complete
 * without our backend making a YouTube request? Everything recorded here serves that, and
 * nothing here identifies a user or a video — no video ids, no URLs, no titles, no
 * addresses. The backend aggregates counters in memory and forgets them on restart, so this
 * is not a datastore and deliberately cannot become one.
 */

export type Outcome =
  /** Finished in the browser with zero backend YouTube contact. */
  | 'client_only'
  /** Browser fetched the media, backend supplied metadata only. */
  | 'client_media'
  /** Backend fetched the media. */
  | 'server'
  | 'cancelled'
  | 'failed'

export interface ClipTelemetry {
  outcome: Outcome
  /** Which source resolved the video. */
  resolvedBy: StrategyName | null
  browserResolution: 'success' | 'failure' | 'skipped'
  clientProcessing: 'success' | 'failure' | 'skipped'
  serverFallback: 'used' | 'not-used'
  acquisition: AcquisitionMode | null
  failureCode: ClipErrorCode | null
  /** Wall-clock milliseconds from request to result. */
  durationMs: number
  /** Clip length asked for, which dominates capture time. */
  clipSeconds: number
  /** `desktop` | `mobile` | `ios`. */
  platform: string
}

/**
 * Accumulates one request's facts. A builder rather than a bag of loose variables so the
 * controller cannot forget a field and quietly skew the metric.
 */
export class TelemetryRecorder {
  private readonly startedAt = performance.now()

  private resolvedBy: StrategyName | null = null
  private browserResolution: ClipTelemetry['browserResolution'] = 'skipped'
  private clientProcessing: ClipTelemetry['clientProcessing'] = 'skipped'
  private acquisition: AcquisitionMode | null = null

  private readonly clipSeconds: number

  constructor(clipSeconds: number) {
    this.clipSeconds = clipSeconds
  }

  markResolution(strategy: StrategyName, ok: boolean): void {
    if (ok) this.resolvedBy = strategy
    if (strategy === 'browser') this.browserResolution = ok ? 'success' : 'failure'
  }

  markClientProcessing(ok: boolean, acquisition: AcquisitionMode | null): void {
    this.clientProcessing = ok ? 'success' : 'failure'
    if (acquisition) this.acquisition = acquisition
  }

  markServerProcessing(acquisition: AcquisitionMode = 'server'): void {
    this.acquisition = acquisition
  }

  private build(outcome: Outcome, failureCode: ClipErrorCode | null): ClipTelemetry {
    return {
      outcome,
      resolvedBy: this.resolvedBy,
      browserResolution: this.browserResolution,
      clientProcessing: this.clientProcessing,
      serverFallback: this.acquisition === 'server' ? 'used' : 'not-used',
      acquisition: this.acquisition,
      failureCode,
      durationMs: Math.round(performance.now() - this.startedAt),
      clipSeconds: Math.round(this.clipSeconds),
      platform: platformTag(),
    }
  }

  /**
   * `client_only` is the headline metric and is deliberately strict: the browser must have
   * both resolved the video and produced the bytes. A capture-based clip qualifies; one
   * that needed the backend for stream URLs is recorded as `client_media` instead, because
   * the backend still spoke to YouTube.
   */
  succeeded(producedBy: StrategyName, acquisition: AcquisitionMode): ClipTelemetry {
    this.acquisition = acquisition

    let outcome: Outcome = 'server'
    if (producedBy === 'browser') {
      outcome = this.resolvedBy === 'browser' && acquisition === 'capture' ? 'client_only' : 'client_media'
    }

    return this.emit(this.build(outcome, null))
  }

  failed(code: ClipErrorCode): ClipTelemetry {
    return this.emit(this.build(code === 'CANCELLED' ? 'cancelled' : 'failed', code))
  }

  /** Fire-and-forget: telemetry must never delay or break a user's clip. */
  private emit(record: ClipTelemetry): ClipTelemetry {
    void reportTelemetry(record).catch(() => undefined)
    return record
  }
}
