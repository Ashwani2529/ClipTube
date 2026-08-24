import axios, { AxiosError } from 'axios'
import type {
  ClipResponse,
  ClipType,
  FormatsResponse,
  JobStatusResponse,
  StatsResponse,
} from '../types'

/** Relative by default so the Vite dev proxy keeps everything same-origin. */
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'

const client = axios.create({ baseURL: API_BASE, timeout: 120_000 })

/** Pulls the server's `{ error }` message out of a failed request. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof AxiosError) {
    const payload = error.response?.data as { error?: string } | undefined
    if (payload?.error) return payload.error
    if (error.code === 'ECONNABORTED') return 'The server took too long to respond.'
    if (!error.response) return 'Could not reach the ClipTube server. Is the backend running?'
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export async function fetchFormats(url: string): Promise<FormatsResponse> {
  const { data } = await client.post<FormatsResponse>('/formats', { url })
  return data
}

export interface CreateClipInput {
  url: string
  start: number
  end: number
  type: ClipType
  formatId: string
}

export async function createClip(input: CreateClipInput): Promise<ClipResponse> {
  const { data } = await client.post<ClipResponse>('/clip', input)
  return data
}

export async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  const { data } = await client.get<JobStatusResponse>(`/status/${jobId}`)
  return data
}

export async function fetchStats(): Promise<StatsResponse> {
  const { data } = await client.get<StatsResponse>('/stats')
  return data
}

export const downloadUrlFor = (jobId: string): string => `${API_BASE}/download/${jobId}`
