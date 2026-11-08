import type { LoggerOptions } from 'pino';
import type { AppConfig } from '../config/env.js';

/**
 * Structured JSON logging (pino). Secrets are redacted defensively even though
 * the code never logs them on purpose.
 */
export function buildLoggerOptions(config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'nodeEnv'>): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: 'aidis-backend' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'newPassword',
        'passwordHash',
        'accessToken',
        'refreshToken',
        'token',
        '*.password',
        '*.passwordHash',
        '*.accessToken',
        '*.refreshToken',
        '*.token',
        'apiSecret',
        '*.apiSecret',
        'databaseUrl',
        '*.databaseUrl',
      ],
      censor: '[redacted]',
    },
  };
}
