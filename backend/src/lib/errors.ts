export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);

export const notFound = (message: string) => new HttpError(404, message);

export const conflict = (message: string) => new HttpError(409, message);

export const upstreamFailure = (message: string, details?: unknown) =>
  new HttpError(502, message, details);
