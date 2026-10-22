import { Router } from 'express';

/** Liveness of the process only; deliberately does not query the database or the broker. */
export function healthRouter(): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'request-service', uptimeSeconds: Math.round(process.uptime()) });
  });
  return router;
}
