import { spawn } from 'child_process';
import { logger } from './logger';

export interface RunOptions {
  cwd?: string;
  /** Fires for every complete stdout line — used to follow yt-dlp progress. */
  onStdoutLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class ProcessError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    const tail = stderr.trim().split('\n').slice(-6).join('\n');
    super(`${command} exited with code ${exitCode ?? 'null'}${tail ? `:\n${tail}` : ''}`);
    this.name = 'ProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Runs a binary with an argument array (never a shell string, so titles and URLs
 * cannot be interpreted as shell syntax) and buffers its output.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    logger.info(`spawn ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      // stdin is closed, not piped: ffmpeg reads stdin when it wants to ask about
      // overwriting a file, and against an open-but-silent pipe it would wait forever.
      // With 'ignore' any such read hits EOF and the process carries on.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!options.onStdoutLine) return;

      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      lines.forEach((line) => {
        if (line.trim()) options.onStdoutLine?.(line);
      });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (code) => {
      if (pending.trim() && options.onStdoutLine) options.onStdoutLine(pending);
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new ProcessError(command, code, stderr || stdout));
        }
      });
    });
  });
}
