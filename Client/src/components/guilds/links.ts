import type { Channel } from '../../api/types';
import { useChatStore } from '../../stores/chatStore';
import { linkTo } from './routes';

/** A server channel (any of my servers) or a DM, by id. */
export function findAnyChannel(channelId: string): Channel | undefined {
  const { channels, dms } = useChatStore.getState();
  return channels.find((c) => c.id === channelId) ?? dms.find((c) => c.id === channelId);
}

/** Where a channel id opens; `call` opens a DM's call view. Unknown ids go to the default place. */
export function pathForChannelId(channelId: string, options: { call?: boolean } = {}): string {
  const channel = findAnyChannel(channelId);
  return channel ? linkTo(channel, options) : '/';
}
