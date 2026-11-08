import type { Channel } from '../../api/types';
import type { SearchQuery } from '../../api/messages';

/**
 * 0.7.0: what "search everywhere" means. On a server: that server; in DMs (or on Home): my DMs.
 * "This channel": just the channel. The server requires one of guildId / channelId / dms.
 */
export function searchScope(scope: 'channel' | 'all', channel: Pick<Channel, 'id' | 'type' | 'guildId'> | undefined, activeGuildId: string | null): Pick<SearchQuery, 'channelId' | 'guildId' | 'dms'> {
  if (scope === 'channel' && channel) return { channelId: channel.id };
  const guildId = channel ? channel.guildId : activeGuildId;
  return guildId ? { guildId } : { dms: true };
}
