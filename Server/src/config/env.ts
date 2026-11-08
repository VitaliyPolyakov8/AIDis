import path from 'node:path';

/**
 * 0.5.1: origin of the AIDis Android app (Capacitor serves the bundled client from this fixed
 * hostname inside its WebView; it does not exist on the network). Browsers can never be this
 * origin, so allowing it does not open the API to websites.
 */
export const ANDROID_APP_ORIGIN = 'https://android.aidis.local';
import { z } from 'zod';
import { parseDuration } from '../common/duration.js';

/**
 * All deployment-specific configuration comes from environment variables.
 * The configuration is validated once at startup; the process refuses to start
 * with a clear message when something important is missing or insecure.
 */

const PLACEHOLDER_MARKERS = ['change_me', 'change-me', 'changeme', 'replace-me', 'example', 'secret123'];

const durationString = z.string().transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `Invalid duration "${value}" (use e.g. 15m, 12h, 30d)` });
    return z.NEVER;
  }
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('loopback'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: durationString.default(15 * 60),
  REFRESH_TOKEN_TTL: durationString.default(30 * 24 * 60 * 60),

  LIVEKIT_URL: z.string().default(''),
  LIVEKIT_API_URL: z.string().default(''),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  LIVEKIT_TOKEN_TTL: durationString.default(10 * 60),

  UPLOAD_DIRECTORY: z.string().default('./storage/uploads'),
  VOICE_TRANSCRIBE_PYTHON: z.string().default(''),
  VOICE_TRANSCRIBE_SCRIPT: z.string().default(''),
  VOICE_TRANSCRIBE_MODEL: z.string().default(''),
  MAX_UPLOAD_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  // 0.5.5: resumable uploads in 8 MiB pieces (Nginx needs no change); 5 GiB by default.
  MAX_LARGE_UPLOAD_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024 * 1024),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(1).max(20000).default(4000),
  // 0.3.1: link preview cards and GIF search
  LINK_PREVIEWS: z.enum(['true', 'false']).default('true'),
  LINK_PREVIEW_STEAM_COUNTRY: z
    .string()
    .regex(/^[a-z]{2}$/i)
    .default('us'),
  LINK_PREVIEW_STEAM_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2,20}$/i)
    .default('english'),
  // Free text on purpose: an unknown value disables GIFs with a clear log line instead of stopping the backend.
  GIF_PROVIDER: z.string().trim().toLowerCase().default('none'),
  GIF_API_KEY: z.string().default(''),
  GIF_LOCALE: z
    .string()
    .regex(/^[a-z]{2}(_[A-Z]{2})?$/)
    .default('en_US'),
  CLIENT_VERSION_FILE: z.string().default('./config/client-version.json'),
  /** One-time code of the first-run wizard, written by deploy/setup.sh. */
  SETUP_CODE_FILE: z.string().default('./config/setup-code'),
  /** Extra voice servers must be wss://<name>.<this domain>; empty = the host name of PUBLIC_BASE_URL. */
  VOICE_NODE_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([a-z0-9.-]+\.[a-z]{2,})?$/)
    .default(''),
  /** Game covers from the Steam store (activity cards, game tracker). Off by default: no requests to Steam. */
  STEAM_ART: z.enum(['true', 'false']).default('false'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  publicBaseUrl: string;
  corsOrigins: string[];
  trustProxy: string | boolean;
  databaseUrl: string;
  jwtAccessSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  livekit: {
    /** URL returned to clients (public wss:// address). */
    publicUrl: string;
    /** URL the backend uses for server-side API calls (internal Docker address). */
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
    tokenTtlSeconds: number;
    enabled: boolean;
  };
  uploadDirectory: string;
  maxUploadSize: number;
  /** 0.5.5: limit of resumable (chunked) uploads. */
  maxLargeUploadSize: number;
  maxMessageLength: number;
  voiceTranscription?: { python: string; script: string; model: string };
  linkPreviews: { enabled: boolean; steamCountry: string; steamLanguage: string };
  gifs: {
    provider: 'none' | 'tenor' | 'giphy';
    apiKey: string;
    locale: string;
    /** Why GIFs are off although GIF_PROVIDER was set (logged at startup; never contains the key). */
    configError: string | null;
  };
  clientVersionFile: string;
  setupCodeFile: string;
  /** 0.7.1 */
  voiceNodeDomain: string;
  /** Steam store artwork for games (off by default). */
  steamArt: boolean;
  rateLimitMax: number;
  loginRateLimitMax: number;
}

const GIF_PROVIDER_NAMES = ['tenor', 'giphy'] as const;

/**
 * Server-backed GIF provider: tenor | giphy | none. Misconfiguration turns GIFs off, never the
 * server.
 */
export function gifConfig(provider: string, apiKey: string, locale: string): AppConfig['gifs'] {
  const off = (configError: string | null): AppConfig['gifs'] => ({ provider: 'none', apiKey: '', locale, configError });
  if (provider === '' || provider === 'none') return off(null);
  if (provider === 'klipy') {
    return off('GIF_PROVIDER=klipy is not supported (use giphy, tenor or none); server GIF search is off');
  }
  if (!(GIF_PROVIDER_NAMES as readonly string[]).includes(provider)) {
    return off(`GIF_PROVIDER "${provider.slice(0, 40)}" is not supported (use giphy, tenor or none); server GIF search is off`);
  }
  if (!apiKey) return off(`GIF_PROVIDER=${provider} but GIF_API_KEY is empty; server GIF search is off`);
  return { provider: provider as AppConfig['gifs']['provider'], apiKey, locale, configError: null };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProduction = e.NODE_ENV === 'production';

  const corsOrigins = e.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const livekitEnabled = e.LIVEKIT_API_KEY !== '' && e.LIVEKIT_API_SECRET !== '' && e.LIVEKIT_URL !== '';

  if (isProduction) {
    if (looksLikePlaceholder(e.JWT_ACCESS_SECRET)) {
      problems.push('JWT_ACCESS_SECRET still contains a placeholder value; generate one with: openssl rand -hex 32');
    }
    if (corsOrigins.includes('*')) {
      problems.push('CORS_ORIGINS must list explicit origins in production ("*" is not allowed)');
    }
    if (corsOrigins.length === 0) {
      problems.push('CORS_ORIGINS must be set in production, e.g. https://chat.example.com');
    }
    if (!livekitEnabled) {
      problems.push('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production');
    } else {
      if (e.LIVEKIT_API_SECRET.length < 32) {
        problems.push('LIVEKIT_API_SECRET must be at least 32 characters');
      }
      if (looksLikePlaceholder(e.LIVEKIT_API_SECRET) || looksLikePlaceholder(e.LIVEKIT_API_KEY)) {
        problems.push('LIVEKIT_API_KEY / LIVEKIT_API_SECRET still contain a placeholder value');
      }
    }
    if (looksLikePlaceholder(e.DATABASE_URL)) {
      problems.push('POSTGRES_PASSWORD (DATABASE_URL) still contains a placeholder value');
    }
    if (!e.PUBLIC_BASE_URL.startsWith('https://')) {
      problems.push('PUBLIC_BASE_URL should be an https:// URL in production, e.g. https://chat.example.com');
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  let trustProxy: string | boolean = e.TRUST_PROXY;
  if (e.TRUST_PROXY === 'true') trustProxy = true;
  if (e.TRUST_PROXY === 'false') trustProxy = false;

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    // 0.5.1: the Android app's WebView origin (Capacitor server.hostname) is always allowed.
    corsOrigins: corsOrigins.includes('*') || corsOrigins.includes(ANDROID_APP_ORIGIN) ? corsOrigins : [...corsOrigins, ANDROID_APP_ORIGIN],
    trustProxy,
    databaseUrl: e.DATABASE_URL,
    jwtAccessSecret: e.JWT_ACCESS_SECRET,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL,
    refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL,
    livekit: {
      publicUrl: e.LIVEKIT_URL,
      apiUrl: e.LIVEKIT_API_URL !== '' ? e.LIVEKIT_API_URL : e.LIVEKIT_URL.replace(/^ws/, 'http'),
      apiKey: e.LIVEKIT_API_KEY,
      apiSecret: e.LIVEKIT_API_SECRET,
      tokenTtlSeconds: e.LIVEKIT_TOKEN_TTL,
      enabled: livekitEnabled,
    },
    uploadDirectory: path.resolve(e.UPLOAD_DIRECTORY),
    maxUploadSize: e.MAX_UPLOAD_SIZE,
    maxLargeUploadSize: Math.max(e.MAX_UPLOAD_SIZE, e.MAX_LARGE_UPLOAD_SIZE),
    maxMessageLength: e.MAX_MESSAGE_LENGTH,
    voiceTranscription: { python: e.VOICE_TRANSCRIBE_PYTHON, script: e.VOICE_TRANSCRIBE_SCRIPT, model: e.VOICE_TRANSCRIBE_MODEL },
    linkPreviews: { enabled: e.LINK_PREVIEWS === 'true', steamCountry: e.LINK_PREVIEW_STEAM_COUNTRY.toLowerCase(), steamLanguage: e.LINK_PREVIEW_STEAM_LANGUAGE.toLowerCase() },
    gifs: gifConfig(e.GIF_PROVIDER, e.GIF_API_KEY.trim(), e.GIF_LOCALE),
    clientVersionFile: path.resolve(e.CLIENT_VERSION_FILE),
    setupCodeFile: path.resolve(e.SETUP_CODE_FILE),
    voiceNodeDomain: e.VOICE_NODE_DOMAIN !== '' ? e.VOICE_NODE_DOMAIN : new URL(e.PUBLIC_BASE_URL).hostname.toLowerCase(),
    steamArt: e.STEAM_ART === 'true',
    rateLimitMax: e.RATE_LIMIT_MAX,
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
  };
}
