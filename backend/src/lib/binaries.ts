import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { env } from '../config/env';
import { logger } from './logger';

export type BinaryName = 'yt-dlp' | 'ffmpeg' | 'ffprobe';

export interface ResolvedBinary {
  name: BinaryName;
  /** Command or absolute path handed to `spawn`. */
  command: string;
  version: string;
  /** Where the binary came from, for the startup banner. */
  source: 'env' | 'path' | 'bundled';
}

interface Candidate {
  command: string;
  source: ResolvedBinary['source'];
}

const VERSION_FLAG: Record<BinaryName, string> = {
  'yt-dlp': '--version',
  ffmpeg: '-version',
  ffprobe: '-version',
};

const INSTALL_HINT: Record<BinaryName, string> = {
  'yt-dlp':
    'Install it with `winget install yt-dlp` / `brew install yt-dlp` / `pip install -U yt-dlp`, ' +
    'or reinstall backend deps so the bundled `youtube-dl-exec` binary is downloaded, ' +
    'or point YTDLP_PATH in .env at the executable.',
  ffmpeg:
    'Install it with `winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`, ' +
    'or reinstall backend deps so `ffmpeg-static` is present, ' +
    'or point FFMPEG_PATH in .env at the executable.',
  ffprobe:
    'ffprobe ships with ffmpeg. Install ffmpeg, reinstall backend deps so `ffprobe-static` is present, ' +
    'or point FFPROBE_PATH in .env at the executable.',
};

const resolved = new Map<BinaryName, ResolvedBinary>();

/** Path to a binary shipped inside node_modules, or null when the package is absent. */
function bundledPath(name: BinaryName): string | null {
  try {
    if (name === 'yt-dlp') {
      const pkg = require.resolve('youtube-dl-exec/package.json');
      const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const candidate = path.join(path.dirname(pkg), 'bin', exe);
      return fs.existsSync(candidate) ? candidate : null;
    }

    if (name === 'ffmpeg') {
      // ffmpeg-static's main export is the absolute path to the binary.
      const candidate = require('ffmpeg-static') as string | null;
      return typeof candidate === 'string' && fs.existsSync(candidate) ? candidate : null;
    }

    const probe = require('ffprobe-static') as { path?: string } | string | null;
    const candidate = typeof probe === 'string' ? probe : probe?.path;
    return typeof candidate === 'string' && fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function candidatesFor(name: BinaryName): Candidate[] {
  const override =
    name === 'yt-dlp'
      ? env.binaries.ytDlp
      : name === 'ffmpeg'
        ? env.binaries.ffmpeg
        : env.binaries.ffprobe;

  const list: Candidate[] = [];
  if (override) list.push({ command: override, source: 'env' });
  list.push({ command: name, source: 'path' });

  const bundled = bundledPath(name);
  if (bundled) list.push({ command: bundled, source: 'bundled' });

  return list;
}

function probeVersion(command: string, flag: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [flag], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const firstLine = stdout.split('\n')[0]?.trim() ?? '';
      resolve(firstLine || 'unknown');
    });
  });
}

/** Resolves a binary once and caches the result for the lifetime of the process. */
export async function resolveBinary(name: BinaryName): Promise<ResolvedBinary> {
  const cached = resolved.get(name);
  if (cached) return cached;

  const attempted: string[] = [];
  for (const candidate of candidatesFor(name)) {
    const version = await probeVersion(candidate.command, VERSION_FLAG[name]);
    if (version) {
      const entry: ResolvedBinary = { name, command: candidate.command, version, source: candidate.source };
      resolved.set(name, entry);
      return entry;
    }
    attempted.push(`${candidate.command} (${candidate.source})`);
  }

  throw new Error(
    `Required binary "${name}" was not found. Tried: ${attempted.join(', ')}. ${INSTALL_HINT[name]}`,
  );
}

/** Cached lookup for code paths that run after the startup check succeeded. */
export function binaryPath(name: BinaryName): string {
  const entry = resolved.get(name);
  if (!entry) throw new Error(`Binary "${name}" has not been resolved yet.`);
  return entry.command;
}

/**
 * Verifies every binary the API depends on. Rejects with a single readable error
 * listing everything that is missing, so startup fails loudly instead of at
 * download time.
 */
export async function verifyBinaries(): Promise<ResolvedBinary[]> {
  const names: BinaryName[] = ['yt-dlp', 'ffmpeg', 'ffprobe'];
  const results = await Promise.allSettled(names.map((name) => resolveBinary(name)));

  const ok: ResolvedBinary[] = [];
  const problems: string[] = [];

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      ok.push(result.value);
    } else {
      problems.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  });

  ok.forEach((entry) => {
    logger.info(`${entry.name} ready — ${entry.version} [${entry.source}: ${entry.command}]`);
  });

  if (problems.length > 0) {
    throw new Error(`Missing required binaries:\n  - ${problems.join('\n  - ')}`);
  }

  return ok;
}
