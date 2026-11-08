import type { MyGuildView } from '../../api/types';
import { useGuildStore } from '../../stores/guildStore';
import { useReadStore } from '../../stores/readStore';
import { useEmojiStore } from '../../emojis/store';
import { channelPath, guildPath } from './routes';

/**
 * After creating or joining a server: add it, load its channels BEFORE navigating (otherwise the
 * channel view would not know the server yet and fall back to Home), and return where to go.
 */
export async function enterGuild(guild: MyGuildView, channelId: string | null = null): Promise<string> {
  const store = useGuildStore.getState();
  store.applyGuild(guild);
  await store.refreshChannels(guild.id).catch(() => undefined);
  void useReadStore
    .getState()
    .load()
    .catch(() => undefined);
  void useEmojiStore.getState().load();
  const known = channelId && useGuildStore.getState().byGuild[guild.id]?.channels.some((c) => c.id === channelId);
  return known ? channelPath(guild.id, channelId) : guildPath(guild.id);
}
