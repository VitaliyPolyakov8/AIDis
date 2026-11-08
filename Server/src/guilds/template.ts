import type { Prisma } from '../generated/prisma/client.js';
import { DEFAULT_EVERYONE } from '../permissions/catalog.js';

export interface GuildTemplate {
  categories: { name: string; channels: { type: 'TEXT' | 'VOICE'; name: string; protected?: boolean }[] }[];
}

export const GUILD_LANGUAGES = ['en', 'ru'] as const;
export type GuildLanguage = (typeof GUILD_LANGUAGES)[number];

const NAMES: Record<GuildLanguage, { text: string; general: string; voice: string; lounge: string }> = {
  en: { text: 'Text channels', general: 'general', voice: 'Voice channels', lounge: 'General' },
  ru: { text: 'Текстовые каналы', general: 'общий', voice: 'Голосовые каналы', lounge: 'Общий' },
};

/** What a new server starts with, named in the language of the person who creates it. */
export function newGuildTemplate(lang: GuildLanguage = 'en'): GuildTemplate {
  const n = NAMES[lang];
  return {
    categories: [
      { name: n.text, channels: [{ type: 'TEXT', name: n.general, protected: true }] },
      { name: n.voice, channels: [{ type: 'VOICE', name: n.lounge, protected: true }] },
    ],
  };
}

/**
 * Creates a server, its @everyone role, the owner's membership and the template channels (inside
 * the caller's transaction). The first text channel becomes the system channel.
 */
export async function createGuildFromTemplate(tx: Prisma.TransactionClient, input: { name: string; ownerId: string; template: GuildTemplate }): Promise<string> {
  const guild = await tx.guild.create({ data: { name: input.name, ownerId: input.ownerId } });
  await tx.roleDef.create({ data: { guildId: guild.id, key: 'everyone', name: '@everyone', position: 0, permissions: [...DEFAULT_EVERYONE] } });
  await tx.guildMember.create({ data: { guildId: guild.id, userId: input.ownerId } });
  let systemChannelId: string | null = null;
  for (const [catIndex, category] of input.template.categories.entries()) {
    const cat = await tx.channel.create({ data: { guildId: guild.id, type: 'CATEGORY', name: category.name, position: catIndex } });
    for (const [index, channel] of category.channels.entries()) {
      const created = await tx.channel.create({
        data: { guildId: guild.id, type: channel.type, name: channel.name, position: index, parentId: cat.id, permissionsSynced: true, protected: channel.protected ?? false },
      });
      if (channel.type === 'TEXT' && systemChannelId === null) systemChannelId = created.id;
    }
  }
  if (systemChannelId) await tx.guild.update({ where: { id: guild.id }, data: { systemChannelId } });
  return guild.id;
}
