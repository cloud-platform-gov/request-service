import type { RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import { HttpError } from '../errors.js';
import { verifyAccessToken } from '../modules/requests/tokens.js';

declare global {
  namespace Express {
    interface Locals {
      userId?: string;
    }
  }
}

const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/;

/** One generic message for every failure, so clients learn nothing about why a token was rejected. */
export const unauthorized = () => new HttpError(401, 'UNAUTHORIZED', 'Authentication required');

/**
 * Requires a valid bearer access token and exposes its subject as `res.locals.userId`.
 * The gateway forwards the token unverified and sets no identity headers, so the
 * token is the only source of identity; headers like `x-user-id` are never read.
 */
export function authenticate(config: Config): RequestHandler {
  return async (req, res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const userId = token ? await verifyAccessToken(config, token) : null;
    if (!userId) throw unauthorized();
    res.locals.userId = userId;
    next();
  };
}
