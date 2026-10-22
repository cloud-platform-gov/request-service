import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from '../../config/env.js';

// Same verification rules as identity-service/src/modules/identity/tokens.ts.
// This service only verifies tokens; it never issues them.
const ALGORITHM = 'HS256';

type TokenConfig = Pick<Config, 'JWT_SECRET' | 'JWT_ISSUER'>;

const subject = z.uuid();

/** Returns the user ID, or null for any invalid, expired or unexpected token. */
export async function verifyAccessToken(config: TokenConfig, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), {
      algorithms: [ALGORITHM],
      issuer: config.JWT_ISSUER,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const parsed = subject.safeParse(payload.sub);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
