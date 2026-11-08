import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/common/duration.js';
import { sanitizeText } from '../src/common/validation.js';
import { sanitizeFilename, sanitizeMimeType } from '../src/attachments/storage.js';
import { LoginThrottle } from '../src/auth/login-throttle.js';
import { ConfigError, loadConfig } from '../src/config/env.js';

describe('helpers', () => {
  it('parses durations', () => {
    expect(parseDuration('900')).toBe(900);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('12h')).toBe(43_200);
    expect(parseDuration('30d')).toBe(2_592_000);
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('0')).toThrow();
  });

  it('sanitizes text, filenames and MIME types', () => {
    expect(sanitizeText('a\u0000b\r\nc\u0007 ')).toBe('ab\nc');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('..hidden')).toBe('hidden');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeMimeType('image/PNG')).toBe('image/png');
    expect(sanitizeMimeType('text/html; charset=utf-8')).toBe('application/octet-stream');
  });

  it('throttles repeated failures per key', () => {
    const throttle = new LoginThrottle(3, 1000);
    for (let i = 0; i < 3; i++) throttle.recordFailure('bob', 0);
    expect(throttle.isBlocked('bob', 10)).toBe(true);
    expect(throttle.isBlocked('bob', 2000)).toBe(false);
  });
});

describe('configuration', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://aidis:pw@postgres:5432/aidis',
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    PUBLIC_BASE_URL: 'https://aidis.test',
    CORS_ORIGINS: 'https://aidis.test',
    LIVEKIT_URL: 'wss://rtc.aidis.test',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'b'.repeat(64),
  };

  it('accepts a complete production configuration', () => {
    const config = loadConfig(productionEnv);
    expect(config.isProduction).toBe(true);
    expect(config.corsOrigins).toEqual(['https://aidis.test', 'https://android.aidis.local']);
    expect(config.livekit.apiUrl).toBe('https://rtc.aidis.test');
  });

  it('refuses insecure production configuration', () => {
    expect(() => loadConfig({ ...productionEnv, JWT_ACCESS_SECRET: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...productionEnv, JWT_ACCESS_SECRET: 'change-me-change-me-change-me-change-me' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...productionEnv, CORS_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...productionEnv, LIVEKIT_API_SECRET: '' })).toThrow(ConfigError);
  });
});
