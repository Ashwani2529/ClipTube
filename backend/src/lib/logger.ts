type Level = 'info' | 'warn' | 'error';

const label: Record<Level, string> = {
  info: 'info ',
  warn: 'warn ',
  error: 'error',
};

function write(level: Level, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] ${label[level]} ${message}`;
  const stream = level === 'info' ? console.log : console.error;
  if (meta === undefined) {
    stream(line);
  } else {
    stream(line, meta);
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};
