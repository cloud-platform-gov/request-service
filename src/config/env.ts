import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' });

const amqpUrl = z.url({ protocol: /^amqps?$/, error: 'must be an amqp:// or amqps:// URL' });

/** Comma-separated list of exact origins allowed by CORS. Empty means no cross-origin access. */
const corsOrigins = z
  .string()
  .default('')
  .transform((value, ctx): string[] => {
    const origins = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    for (const origin of origins) {
      if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
        ctx.addIssue({ code: 'custom', message: `"${origin}" is not an origin like https://example.org` });
        return z.NEVER;
      }
    }
    return origins;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  // 4003 is the port the API Gateway expects for the Request Service.
  PORT: z.coerce.number().int().min(1).max(65535).default(4003),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: databaseUrl,

  // Must match the Identity Service: tokens are HS256 with a shared secret and issuer.
  JWT_SECRET: z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'must be at least 32 bytes'),
  JWT_ISSUER: z.string().min(1).default('cloud-platform-gov-identity'),

  RABBITMQ_URL: amqpUrl,
  RABBITMQ_EXCHANGE: z.string().min(1).max(255).default('cloud-platform-gov.events'),
  // Upper bound for connecting to the broker and for waiting on a publisher confirm.
  RABBITMQ_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  CORS_ORIGIN: corsOrigins,
});

export type Config = z.output<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables. Empty strings are treated as unset so that
 * `FOO=` in an env file falls back to the default (or fails if required).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const input = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
