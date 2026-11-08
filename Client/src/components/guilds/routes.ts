import type { Channel } from '../../api/types';

/**
 * 0.7.0 URLs (Discord-like):
 *   /channels/@me                 Home: friends
 *   /channels/@me/:dmId           a direct message
 *   /channels/@me/:dmId/call      a DM call
 *   /channels/:guildId            a server (opens its last or first text channel)
 *   /channels/:guildId/:channelId a text or voice channel (the view follows the channel type)
 *   /invite/:code                 an invite
 * 0.6 links (/channels/:channelId, /voice/:id, /dm/:id, /dm) are redirected by legacyRedirect.
 */
export const HOME_SEGMENT = '@me';

const seg = (value: string) => encodeURIComponent(value);

export const homePath = () => `/channels/${HOME_SEGMENT}`;
export const dmPath = (dmId: string) => `${homePath()}/${seg(dmId)}`;
export const dmCallPath = (dmId: string) => `${dmPath(dmId)}/call`;
export const guildPath = (guildId: string) => `/channels/${seg(guildId)}`;
export const channelPath = (guildId: string, channelId: string) => `${guildPath(guildId)}/${seg(channelId)}`;
export const invitePath = (code: string) => `/invite/${seg(code)}`;

/** The server a path belongs to: an id, null for Home (/channels/@me...), undefined for other sections. */
export function activeGuildFromPath(pathname: string): string | null | undefined {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'channels' || !parts[1]) return undefined;
  return parts[1] === HOME_SEGMENT ? null : decodeURIComponent(parts[1]);
}

type Linkable = Pick<Channel, 'id' | 'type' | 'guildId'>;

/** Where a channel or DM opens. `call` opens a DM's call view (server voice channels need no flag). */
export function linkTo(channel: Linkable, options: { call?: boolean } = {}): string {
  if (channel.type === 'DM' || !channel.guildId) return options.call ? dmCallPath(channel.id) : dmPath(channel.id);
  return channelPath(channel.guildId, channel.id);
}

/** A 0.6 path -> its 0.7.0 place, or null when it is not an old link (or the channel is unknown). */
export function legacyRedirect(pathname: string, lookup: (id: string) => Linkable | undefined): string | null {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id] = parts;
  if (section === 'dm') return parts.length === 1 ? homePath() : parts.length === 2 && id ? dmPath(id) : null;
  if ((section === 'voice' || section === 'channels') && parts.length === 2 && id && id !== HOME_SEGMENT) {
    const channel = lookup(id);
    if (!channel) return null;
    return linkTo(channel, { call: section === 'voice' });
  }
  return null;
}

// ---- the last place of each server (kept per device) --------------------------------------------

const LAST_CHANNELS_KEY = 'aidis.lastChannels';
const LAST_GUILD_KEY = 'aidis.lastGuild';

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_CHANNELS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function rememberChannel(guildId: string, channelId: string): void {
  try {
    const map = readMap();
    if (map[guildId] === channelId && localStorage.getItem(LAST_GUILD_KEY) === guildId) return;
    map[guildId] = channelId;
    localStorage.setItem(LAST_CHANNELS_KEY, JSON.stringify(map));
    localStorage.setItem(LAST_GUILD_KEY, guildId);
  } catch {
    // Storage may be unavailable (private mode): the first channel opens instead.
  }
}

export function lastChannelOf(guildId: string): string | null {
  return readMap()[guildId] ?? null;
}

export function lastGuild(): string | null {
  try {
    return localStorage.getItem(LAST_GUILD_KEY);
  } catch {
    return null;
  }
}

/** The channel a server opens on: the last opened one when still visible, else its first text channel. */
export function landingChannel(guildId: string, channels: readonly Channel[]): Channel | undefined {
  const last = lastChannelOf(guildId);
  const remembered = last ? channels.find((c) => c.id === last && c.type !== 'CATEGORY') : undefined;
  if (remembered) return remembered;
  return channels
    .filter((c) => c.type === 'TEXT')
    .slice()
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))[0];
}
