import type { Channel } from '../../api/types';

/** 0.7.0: people are moved only between voice channels of the same server. */
export function moveTargets(channels: readonly Channel[], fromChannelId: string): Channel[] {
  const from = channels.find((c) => c.id === fromChannelId);
  if (!from?.guildId) return [];
  return channels.filter((c) => c.type === 'VOICE' && c.id !== fromChannelId && c.guildId === from.guildId);
}
