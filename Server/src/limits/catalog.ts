import type { AppConfig } from '../config/env.js';

/**
 * 0.7.0 limits the superadmin can change: a global value plus exceptions for one server or one
 * user. Values are clamped to [min, max]; max can be a technical ceiling taken from .env (upload
 * sizes are also limited by Nginx and multipart settings, so the UI cannot raise them past .env).
 */
export const LIMIT_KEYS = [
  'guilds.owned',
  'guilds.joined',
  'guild.members',
  'guild.channels',
  'guild.roles',
  'guild.emojis',
  'guild.sounds',
  'guild.invites',
  'friends',
  'friends.pending',
  'upload.size',
  'upload.largeSize',
  'message.length',
  'voice.bitrateMax',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type LimitScopeName = 'GUILD' | 'USER';

export interface LimitDef {
  key: LimitKey;
  scopes: readonly LimitScopeName[];
  default: (config: AppConfig) => number;
  min: number;
  max: (config: AppConfig) => number;
}

const fixed = (value: number) => () => value;
const HARD = 1_000_000;

export const LIMITS: readonly LimitDef[] = [
  { key: 'guilds.owned', scopes: ['USER'], default: fixed(10), min: 0, max: fixed(HARD) },
  { key: 'guilds.joined', scopes: ['USER'], default: fixed(100), min: 1, max: fixed(HARD) },
  { key: 'guild.members', scopes: ['GUILD'], default: fixed(500), min: 1, max: fixed(HARD) },
  { key: 'guild.channels', scopes: ['GUILD'], default: fixed(200), min: 1, max: fixed(2000) },
  { key: 'guild.roles', scopes: ['GUILD'], default: fixed(100), min: 1, max: fixed(1000) },
  { key: 'guild.emojis', scopes: ['GUILD'], default: fixed(100), min: 0, max: fixed(10_000) },
  { key: 'guild.sounds', scopes: ['GUILD'], default: fixed(50), min: 0, max: fixed(1000) },
  { key: 'guild.invites', scopes: ['GUILD'], default: fixed(100), min: 0, max: fixed(10_000) },
  { key: 'friends', scopes: ['USER'], default: fixed(1000), min: 0, max: fixed(HARD) },
  { key: 'friends.pending', scopes: ['USER'], default: fixed(50), min: 0, max: fixed(10_000) },
  // upload.size: the one-request upload path of a user; upload.largeSize: any file, checked again when it is sent into a server.
  { key: 'upload.size', scopes: ['USER'], default: (c) => c.maxUploadSize, min: 1024, max: (c) => c.maxUploadSize },
  { key: 'upload.largeSize', scopes: ['GUILD', 'USER'], default: (c) => c.maxLargeUploadSize, min: 1024, max: (c) => c.maxLargeUploadSize },
  { key: 'message.length', scopes: ['GUILD'], default: (c) => c.maxMessageLength, min: 1, max: (c) => c.maxMessageLength },
  { key: 'voice.bitrateMax', scopes: ['GUILD'], default: fixed(256), min: 8, max: fixed(256) },
];

export function limitDef(key: string): LimitDef | undefined {
  return LIMITS.find((l) => l.key === key);
}
