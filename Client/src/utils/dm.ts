import type { Channel, PublicUser } from '../api/types';

/** The other people of a DM (everyone but me). */
export function dmOthers(channel: Pick<Channel, 'memberIds'>, selfId: string | null | undefined): string[] {
  return (channel.memberIds ?? []).filter((id) => id !== selfId);
}

/** What a DM is called: its title (group), else the other members' names. */
export function dmName(channel: Pick<Channel, 'title' | 'memberIds'>, users: Record<string, PublicUser>, selfId: string | null | undefined): string {
  if (channel.title) return channel.title;
  const names = dmOthers(channel, selfId).map((id) => users[id]?.displayName ?? '…');
  if (names.length === 0) return users[selfId ?? '']?.displayName ?? '…';
  return names.join(', ');
}

export function isGroupDm(channel: Pick<Channel, 'memberIds' | 'type'>): boolean {
  return channel.type === 'DM' && (channel.memberIds?.length ?? 0) > 2;
}

/** A channel with its display name resolved (DMs get the people's names). */
export function displayChannel(channel: Channel, users: Record<string, PublicUser>, selfId: string | null | undefined): Channel {
  return channel.type === 'DM' ? { ...channel, name: dmName(channel, users, selfId) } : channel;
}
