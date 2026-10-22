import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';

const required = {
  DATABASE_URL: 'postgres://requests:requests@localhost:5434/requests',
  JWT_SECRET: 'x'.repeat(32),
  RABBITMQ_URL: 'amqp://requests:requests@localhost:5672',
};

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(required)).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 4003,
      JWT_ISSUER: 'cloud-platform-gov-identity',
      RABBITMQ_EXCHANGE: 'cloud-platform-gov.events',
      RABBITMQ_PUBLISH_TIMEOUT_MS: 5_000,
      CORS_ORIGIN: [],
    });
  });

  it('requires DATABASE_URL, JWT_SECRET and RABBITMQ_URL, treating empty values as unset', () => {
    const issues = issuesFor({ DATABASE_URL: '', JWT_SECRET: '  ', RABBITMQ_URL: '' });
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toMatch(/DATABASE_URL/);
    expect(issues.join('\n')).toMatch(/JWT_SECRET/);
    expect(issues.join('\n')).toMatch(/RABBITMQ_URL/);
  });

  it('rejects a JWT_SECRET shorter than 32 bytes', () => {
    expect(issuesFor({ ...required, JWT_SECRET: 'x'.repeat(31) })).toEqual(['JWT_SECRET: must be at least 32 bytes']);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(issuesFor({ ...required, DATABASE_URL: 'mysql://localhost/db' })[0]).toMatch(/^DATABASE_URL:/);
  });

  it('accepts amqps and rejects other RABBITMQ_URL schemes without echoing the value', () => {
    expect(loadConfig({ ...required, RABBITMQ_URL: 'amqps://u:p@mq.example:5671' }).RABBITMQ_URL).toBe(
      'amqps://u:p@mq.example:5671',
    );
    const issues = issuesFor({ ...required, RABBITMQ_URL: 'http://user:topsecret@mq.example' });
    expect(issues).toEqual(['RABBITMQ_URL: must be an amqp:// or amqps:// URL']);
  });

  it.each(['0', '-5', 'soon'])('rejects RABBITMQ_PUBLISH_TIMEOUT_MS=%s', (value) => {
    expect(issuesFor({ ...required, RABBITMQ_PUBLISH_TIMEOUT_MS: value })[0]).toMatch(/^RABBITMQ_PUBLISH_TIMEOUT_MS:/);
  });

  it('parses a CORS_ORIGIN list and rejects non-origins', () => {
    expect(loadConfig({ ...required, CORS_ORIGIN: 'http://localhost:5173, https://gov.example' }).CORS_ORIGIN).toEqual([
      'http://localhost:5173',
      'https://gov.example',
    ]);
    expect(issuesFor({ ...required, CORS_ORIGIN: '*' })[0]).toMatch(/^CORS_ORIGIN:/);
  });
});
