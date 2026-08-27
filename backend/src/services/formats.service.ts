import { fetchVideoInfo, type RawFormat, type RawVideoInfo } from './ytdlp.service';
import type {
  AudioFormatGroup,
  AudioTierOption,
  VideoFormatOption,
  VideoMeta,
} from '../types/api';

/** Metadata is cached briefly so /formats and /clip don't each pay for a yt-dlp run. */
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; info: RawVideoInfo }>();

export async function getVideoInfo(videoId: string, url: string): Promise<RawVideoInfo> {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.info;
  }

  const info = await fetchVideoInfo(url);
  cache.set(videoId, { at: Date.now(), info });

  // Keep the cache from growing without bound on a long-running server.
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return info;
}

const isPresent = (codec: string | null | undefined): boolean =>
  Boolean(codec) && codec !== 'none';

/** Storyboard/manifest pseudo-formats can't be clipped. */
function isUsable(format: RawFormat): boolean {
  if (!format.format_id) return false;
  if (format.protocol === 'mhtml') return false;
  if (format.ext === 'mhtml') return false;
  return isPresent(format.vcodec) || isPresent(format.acodec);
}

const sizeOf = (format: RawFormat): number | null =>
  format.filesize ?? format.filesize_approx ?? null;

function shortCodec(codec: string | null | undefined): string {
  if (!codec || codec === 'none') return 'unknown';
  const base = codec.split('.')[0] ?? codec;
  const aliases: Record<string, string> = {
    avc1: 'H.264',
    avc3: 'H.264',
    hev1: 'H.265',
    hvc1: 'H.265',
    av01: 'AV1',
    vp09: 'VP9',
    vp9: 'VP9',
    vp8: 'VP8',
    mp4a: 'AAC',
  };
  return aliases[base] ?? base.toUpperCase();
}

/**
 * Ranks video formats within one resolution. Preferring mp4/H.264 keeps the merge step
 * cheap and the output playable everywhere; bitrate breaks remaining ties.
 */
function scoreVideo(format: RawFormat): number {
  const extScore = format.ext === 'mp4' ? 2000 : format.ext === 'webm' ? 1000 : 0;
  const codec = (format.vcodec ?? '').toLowerCase();
  const codecScore = codec.startsWith('avc') ? 300 : codec.startsWith('vp') ? 200 : 100;
  const protocolScore = format.protocol === 'https' ? 50 : 0;
  const bitrate = format.tbr ?? format.vbr ?? 0;
  return extScore + codecScore + protocolScore + Math.min(bitrate, 999) / 1000;
}

/**
 * Size of the audio track that would be merged into a video-only format, matching the
 * `bestaudio[ext=m4a]/bestaudio` selector the clip service uses. Without this, a
 * video-only entry would under-report the size of the file the user actually gets.
 */
export function mergeAudioSize(formats: RawFormat[]): number {
  const audioOnly = formats.filter(
    (format) => isUsable(format) && isPresent(format.acodec) && !isPresent(format.vcodec),
  );

  const preferred = audioOnly.filter((format) => format.ext === 'm4a');
  const pool = preferred.length > 0 ? preferred : audioOnly;

  const best = pool
    .slice()
    .sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];

  return best ? (sizeOf(best) ?? 0) : 0;
}

function buildVideoOptions(formats: RawFormat[]): VideoFormatOption[] {
  const audioSize = mergeAudioSize(formats);
  const byHeight = new Map<number, RawFormat>();

  formats
    .filter((format) => isUsable(format) && isPresent(format.vcodec) && (format.height ?? 0) > 0)
    .forEach((format) => {
      const height = format.height as number;
      const incumbent = byHeight.get(height);
      if (!incumbent || scoreVideo(format) > scoreVideo(incumbent)) {
        byHeight.set(height, format);
      }
    });

  return [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, format]) => {
      const fps = format.fps ? Math.round(format.fps) : null;
      const hdr = Boolean(format.dynamic_range && format.dynamic_range !== 'SDR');
      const hasAudio = isPresent(format.acodec);
      const videoSize = sizeOf(format);

      return {
        formatId: format.format_id as string,
        label: `${height}p${fps && fps > 30 ? fps : ''}${hdr ? ' HDR' : ''}`,
        height,
        width: format.width ?? null,
        fps,
        ext: format.ext ?? 'mp4',
        vcodec: shortCodec(format.vcodec),
        hasAudio,
        // Whole-video size; the client scales it down to the selected range.
        filesizeBytes: videoSize === null ? null : videoSize + (hasAudio ? 0 : audioSize),
        note: format.format_note ?? null,
        hdr,
      } satisfies VideoFormatOption;
    });
}

interface CodecProfile {
  codec: string;
  ext: string;
  label: string;
  rank: number;
}

/** Maps a yt-dlp acodec onto the container the clip should be saved in. */
function audioProfile(acodec: string): CodecProfile {
  const base = (acodec.split('.')[0] ?? acodec).toLowerCase();

  if (base === 'mp4a' || base === 'aac') {
    return { codec: 'aac', ext: 'm4a', label: 'AAC · m4a', rank: 0 };
  }
  if (base === 'opus') {
    return { codec: 'opus', ext: 'opus', label: 'Opus · opus', rank: 1 };
  }
  if (base === 'mp3') {
    return { codec: 'mp3', ext: 'mp3', label: 'MP3 · mp3', rank: 2 };
  }
  if (base === 'vorbis') {
    return { codec: 'vorbis', ext: 'ogg', label: 'Vorbis · ogg', rank: 3 };
  }
  if (base === 'ec-3' || base === 'eac3') {
    return { codec: 'eac3', ext: 'eac3', label: 'E-AC-3 · eac3', rank: 4 };
  }
  if (base === 'ac-3' || base === 'ac3') {
    return { codec: 'ac3', ext: 'ac3', label: 'AC-3 · ac3', rank: 4 };
  }
  if (base === 'flac') {
    return { codec: 'flac', ext: 'flac', label: 'FLAC · flac', rank: 1 };
  }

  return { codec: base, ext: base, label: `${base.toUpperCase()} · ${base}`, rank: 9 };
}

const isDubbed = (format: RawFormat): boolean => /dub|dubbed/i.test(format.format_note ?? '');

function buildAudioGroups(formats: RawFormat[]): AudioFormatGroup[] {
  const audioOnly = formats.filter(
    (format) => isUsable(format) && isPresent(format.acodec) && !isPresent(format.vcodec),
  );

  // Prefer the video's original-language track; only fall back to dubs if that's all
  // YouTube offers.
  const original = audioOnly.filter((format) => !isDubbed(format));
  const pool = original.length > 0 ? original : audioOnly;

  const groups = new Map<string, { profile: CodecProfile; formats: RawFormat[] }>();

  pool.forEach((format) => {
    const profile = audioProfile(format.acodec ?? '');
    const bucket = groups.get(profile.codec);
    if (bucket) {
      bucket.formats.push(format);
    } else {
      groups.set(profile.codec, { profile, formats: [format] });
    }
  });

  return [...groups.values()]
    .sort((a, b) => a.profile.rank - b.profile.rank)
    .map(({ profile, formats: members }) => {
      const seen = new Set<number>();
      const tiers: AudioTierOption[] = members
        .slice()
        .sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))
        .filter((format) => {
          // Collapse near-identical bitrate variants into one selectable tier.
          const key = Math.round(format.abr ?? format.tbr ?? 0);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((format) => {
          const bitrate = format.abr ?? format.tbr ?? null;
          const rounded = bitrate === null ? null : Math.round(bitrate);
          const channels = format.audio_channels ?? null;

          return {
            formatId: format.format_id as string,
            bitrateKbps: rounded,
            label: rounded === null ? 'default bitrate' : `${rounded} kbps`,
            filesizeBytes: sizeOf(format),
            sampleRate: format.asr ?? null,
            note:
              [format.format_note, channels && channels > 2 ? `${channels}ch` : null]
                .filter(Boolean)
                .join(' · ') || null,
          } satisfies AudioTierOption;
        });

      return { codec: profile.codec, ext: profile.ext, label: profile.label, tiers };
    })
    .filter((group) => group.tiers.length > 0);
}

export function toMeta(info: RawVideoInfo, videoId: string, url: string): VideoMeta {
  return {
    videoId: info.id ?? videoId,
    title: info.title ?? 'Untitled video',
    uploader: info.uploader ?? info.channel ?? '',
    durationSeconds: Math.max(0, Math.round(info.duration ?? 0)),
    thumbnail: info.thumbnail ?? null,
    webpageUrl: info.webpage_url ?? url,
    isLive: Boolean(info.is_live) || info.live_status === 'is_live',
  };
}

/** Looks up a specific format id in the cached metadata. */
export function findFormat(info: RawVideoInfo, formatId: string): RawFormat | undefined {
  return (info.formats ?? []).find((format) => format.format_id === formatId);
}

/**
 * The normalised picker lists. Shared by /api/formats and /api/resolve so both endpoints
 * describe a video identically — the browser path and the server path must agree on format
 * ids or a fallback mid-request would change the user's selection.
 */
export function buildFormatLists(formats: RawFormat[]): {
  video: VideoFormatOption[];
  audio: AudioFormatGroup[];
} {
  return { video: buildVideoOptions(formats), audio: buildAudioGroups(formats) };
}

