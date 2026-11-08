import { useGuildStore } from '../../stores/guildStore';
import type { Channel } from '../../api/types';
import type { ChannelOrderItem } from '../../api/guilds';

export interface ChannelGroup {
  category: Channel;
  children: Channel[];
}

export interface ChannelTree {
  categories: ChannelGroup[];
  /** Channels without a category (or whose category I cannot see): shown on top. */
  orphans: Channel[];
}

const byPosition = (a: Channel, b: Channel) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Groups a server's channels for the sidebar: categories in order, each with its channels in order. */
export function buildTree(channels: readonly Channel[]): ChannelTree {
  const categories = channels.filter((c) => c.type === 'CATEGORY').sort(byPosition);
  const groups = new Map<string, ChannelGroup>(categories.map((category) => [category.id, { category, children: [] }]));
  const orphans: Channel[] = [];
  for (const channel of [...channels].sort(byPosition)) {
    if (channel.type === 'CATEGORY') continue;
    const group = channel.parentId ? groups.get(channel.parentId) : undefined;
    if (group) group.children.push(channel);
    else orphans.push(channel);
  }
  return { categories: categories.flatMap((c) => groups.get(c.id) ?? []), orphans };
}

export type DropTarget = { kind: 'before'; id: string } | { kind: 'into'; categoryId: string };

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Drag & drop in the channel list -> the order items to save (only the groups that changed), or null
 * for a no-op. Channels go before another channel (taking its category) or to the end of a category;
 * categories only go before another category.
 */
export function moveInTree(tree: ChannelTree, dragId: string, target: DropTarget): ChannelOrderItem[] | null {
  const categoryIds = tree.categories.map((g) => g.category.id);
  if (categoryIds.includes(dragId)) {
    if (target.kind !== 'before' || target.id === dragId || !categoryIds.includes(target.id)) return null;
    const next = categoryIds.filter((id) => id !== dragId);
    next.splice(next.indexOf(target.id), 0, dragId);
    return sameOrder(next, categoryIds) ? null : next.map((id, position) => ({ id, parentId: null, position }));
  }
  const groups = new Map<string | null, string[]>([[null, tree.orphans.map((c) => c.id)], ...tree.categories.map((g): [string, string[]] => [g.category.id, g.children.map((c) => c.id)])]);
  const groupOf = (id: string): string | null | undefined => {
    for (const [key, ids] of groups) if (ids.includes(id)) return key;
    return undefined;
  };
  const from = groupOf(dragId);
  if (from === undefined) return null;
  let to: string | null;
  if (target.kind === 'into') {
    if (!groups.has(target.categoryId)) return null;
    to = target.categoryId;
  } else {
    if (target.id === dragId) return null;
    const found = groupOf(target.id);
    if (found === undefined) return null;
    to = found;
  }
  const original = groups.get(from) ?? [];
  const source = original.filter((id) => id !== dragId);
  const dest = from === to ? source : [...(groups.get(to) ?? [])];
  dest.splice(target.kind === 'into' ? dest.length : dest.indexOf(target.id), 0, dragId);
  if (from === to && sameOrder(dest, original)) return null;
  const items: ChannelOrderItem[] = [];
  if (from !== to) items.push(...source.map((id, position) => ({ id, parentId: from, position })));
  items.push(...dest.map((id, position) => ({ id, parentId: to, position })));
  return items;
}

/** Lock icon: @everyone may not see the channel (own overwrites, or the category's when synced). */
export function isLockedChannel(channel: Channel, channels: readonly Channel[], everyoneRoleId: string | null): boolean {
  if (!everyoneRoleId) return false;
  const parent = channel.permissionsSynced && channel.parentId ? channels.find((c) => c.id === channel.parentId) : undefined;
  const overwrites = (parent ?? channel).overwrites;
  return overwrites?.some((o) => o.targetType === 'ROLE' && o.targetId === everyoneRoleId && o.deny.includes('VIEW_CHANNEL')) ?? false;
}

export function useChannelLocked(channel: Channel | undefined): boolean {
  return useGuildStore((s) => {
    if (!channel?.guildId) return false;
    const data = s.byGuild[channel.guildId];
    if (!data) return false;
    const everyone = data.roles.find((r) => r.isEveryone)?.id ?? null;
    return isLockedChannel(channel, data.channels, everyone);
  });
}
