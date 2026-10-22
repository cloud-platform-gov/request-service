import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { Config } from './config/env.js';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** An error whose code and message are safe to show to clients. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Same shape as the API Gateway's error body, plus optional validation details. */
export interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: ErrorDetail[] };
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

export function sendError(res: Response, error: HttpError): void {
  const body: ErrorBody = {
    error: { code: error.code, message: error.message, requestId: String(res.req.id) },
  };
  if (error.details) body.error.details = error.details;
  res.status(error.statusCode).json(body);
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/**
 * Single place that turns any error into the public error format.
 * Stack traces are only ever logged; 5xx messages are hidden in production.
 */
export function errorHandler(config: Config): ErrorRequestHandler {
  const isProduction = config.NODE_ENV === 'production';

  return (err: unknown, req, res, _next) => {
    if (err instanceof HttpError) {
      sendError(res, err);
      return;
    }

    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      sendError(res, new HttpError(400, 'BAD_REQUEST', 'Request validation failed', details));
      return;
    }

    // body-parser errors carry `type` and a 4xx `status`; their messages can echo input, so use fixed ones.
    const { status, type } = (err ?? {}) as { status?: unknown; type?: unknown };
    if (type === 'entity.parse.failed') {
      sendError(res, new HttpError(400, 'BAD_REQUEST', 'Malformed JSON body'));
      return;
    }
    if (type === 'entity.too.large') {
      sendError(res, new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      req.log.info({ err }, 'client error');
      sendError(res, new HttpError(status, CLIENT_ERROR_CODES[status] ?? 'CLIENT_ERROR', 'Invalid request'));
      return;
    }

    req.log.error({ err }, 'unhandled error');
    const message = isProduction || !(err instanceof Error) ? 'Internal server error' : err.message;
    sendError(res, new HttpError(500, 'INTERNAL_ERROR', message));
  };
}
