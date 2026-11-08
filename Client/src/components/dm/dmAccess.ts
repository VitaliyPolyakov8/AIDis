import type { Channel } from '../../api/types';
import { useFriendsStore } from '../../stores/friendsStore';
import { useAuthStore } from '../../stores/authStore';

/** The other person of a 1:1 DM (null for group DMs). */
export function dmPeer(dm: Pick<Channel, 'memberIds'>, selfId: string | undefined): string | null {
  const others = (dm.memberIds ?? []).filter((id) => id !== selfId);
  return others.length === 1 ? (others[0] ?? null) : null;
}

/** 0.7.0: a 1:1 DM is writable only between friends; group DMs keep working for their members. */
export function canWriteDm(dm: Pick<Channel, 'memberIds'>, selfId: string | undefined, isFriend: (userId: string) => boolean): boolean {
  const peer = dmPeer(dm, selfId);
  return peer === null || isFriend(peer);
}

export function useCanWriteDm(dm: Pick<Channel, 'memberIds'> | undefined): boolean {
  const selfId = useAuthStore((s) => s.user?.id);
  const friendIds = useFriendsStore((s) => s.friendIds);
  return dm ? canWriteDm(dm, selfId, (id) => friendIds.includes(id)) : true;
}
