import { memo, useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { PlatformIcons } from './profile/PlatformIcons';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, Crown, MessageCircle, PhoneOff, User, Volume2 } from 'lucide-react';
import type { MemberView, PresenceView, PublicUser, RoleView } from '../api/types';
import { Avatar } from './Avatar';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../voice/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { formatLastSeen } from '../utils/time';
import { activeCustomStatus, presenceState } from '../utils/presence';
import { gameTheme } from '../utils/gameTheme';
import { anchorRect, openProfile } from './profile/profileState';
import { ActivityPill, UserBadges } from './profile/ProfileBits';
import { openMenu, type MenuEntry } from './menu/MenuHost';
import { useOpenDm } from './dm/DmDialogs';
import { openMoveUser, openVoiceDisconnect } from './voice/ModerationDialogs';
import { can } from '../stores/permsStore';
import { toast } from '../stores/uiStore';
import { useNameStyle } from './profile/nameStyle';
import { friendlyError } from '../api/errors';
import { memberDisplay, useGuildStore, type MemberDisplay } from '../stores/guildStore';
import { useFriendsStore } from '../stores/friendsStore';
import { groupMembers } from './members/groupMembers';

const MemberRow = memo(function MemberRow({
  user,
  display,
  presence,
  inVoice,
  owner,
  onMenu,
}: {
  user: PublicUser;
  /** 0.7.0: the server profile (nickname, avatar, role colour); global on Home. */
  display: MemberDisplay;
  presence: PresenceView | undefined;
  inVoice: string | null;
  owner: boolean;
  onMenu: (e: ReactMouseEvent, user: PublicUser, voiceChannelId: string | null) => void;
}) {
  const { t } = useTranslation();
  const state = presenceState(presence);
  const online = state !== 'offline';
  const lastSeen = presence?.lastSeenAt ?? user.lastSeenAt;
  const custom = online ? activeCustomStatus(presence) : null;
  const activity = online ? presence?.activity : null;
  const status = online ? t(`status.state.${state}`) : formatLastSeen(lastSeen);
  const roleColor = display.roleColor;
  // 0.5.0: the user's own nickname color first, then the role color.
  const nameStyle = useNameStyle(user.id, user, roleColor);
  const accent = activity ? gameTheme(activity.name) : null;
  const style = (accent ? { '--game-accent': accent.accent, '--game-soft': accent.soft } : {}) as CSSProperties;
  return (
    <li className={`member${online ? '' : ' is-offline'}${activity ? ' is-playing' : ''} is-${state}`} style={style}>
      <button type="button" className="member-button" title={`${display.name} (@${user.username}) · ${status}`} onClick={(e) => openProfile(e, user.id)} onContextMenu={(e) => onMenu(e, user, inVoice)}>
        <Avatar userId={user.id} name={display.name} avatarAttachmentId={display.avatarAttachmentId} size={32} status={state} />
        <span className="member-text">
          <span className="member-name">
            <span className={`member-name-text ${nameStyle.className}`} style={nameStyle.style}>
              {display.name}
            </span>
            {owner && <Crown size={12} className="member-crown" role="img" aria-label={t('gs.members.owner')} />}
            <UserBadges user={user} size={12} />
            <PlatformIcons userId={user.id} size={12} />
            {/* 0.4.5: the voice icon lives on the name line, so the activity line below gets the full width. */}
            {inVoice && <Volume2 size={14} className="member-voice" aria-hidden="true" />}
          </span>
          {!online ? (
            <span className="member-sub">{status}</span>
          ) : activity ? null : custom ? (
            <span className="member-sub member-custom">
              {custom.emoji && <span className="custom-emoji">{custom.emoji}</span>}
              <span className="custom-status-text">{custom.text}</span>
            </span>
          ) : state !== 'online' ? (
            <span className={`member-sub is-${state}`}>{status}</span>
          ) : null}
        </span>
        {/* 0.4.7: the game has its own row across the whole button (under the avatar too). */}
        {activity && (
          <span className="member-activity">
            <ActivityPill name={activity.name} compact />
          </span>
        )}
      </button>
    </li>
  );
});

const NO_MEMBERS: MemberView[] = [];
const NO_ROLES: RoleView[] = [];

interface Section {
  key: string;
  title: string;
  color: string | null;
  rows: { user: PublicUser; display: MemberDisplay }[];
}

export function MembersSidebar() {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const presence = usePresenceStore((s) => s.presence);
  const occupancy = useVoiceStore((s) => s.occupancy);
  const selfId = useAuthStore((s) => s.user?.id);
  const guild = useGuildStore((s) => s.guilds.find((g) => g.id === s.activeGuildId) ?? null);
  const members = useGuildStore((s) => (s.activeGuildId ? (s.byGuild[s.activeGuildId]?.members ?? NO_MEMBERS) : NO_MEMBERS));
  const roles = useGuildStore((s) => (s.activeGuildId ? (s.byGuild[s.activeGuildId]?.roles ?? NO_ROLES) : NO_ROLES));
  const friendIds = useFriendsStore((s) => s.friendIds);
  const openDm = useOpenDm();

  /** user id -> voice channel id they are in (as far as we know). */
  const voiceOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const [channelId, list] of Object.entries(occupancy)) for (const p of list) map.set(p.identity, channelId);
    return map;
  }, [occupancy]);

  // 0.7.0: the open server's members grouped by displayed roles; on Home: my friends.
  const { sections, offline } = useMemo(() => {
    const isOnline = (id: string) => presence[id]?.status === 'online';
    const toRow = (m: MemberView) => {
      const user = users[m.userId];
      return user ? { user, display: memberDisplay(user, m, roles) } : null;
    };
    const toRows = (list: MemberView[]) => list.map(toRow).filter((r): r is NonNullable<ReturnType<typeof toRow>> => r !== null);
    const source: MemberView[] = guild ? members : friendIds.map((userId) => ({ userId, roleIds: [], joinedAt: '', nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null }));
    const grouped = groupMembers(source, roles, isOnline, (m) => memberDisplay(users[m.userId], m, roles).name);
    const list: Section[] = grouped.groups.map((g) => ({ key: g.role?.id ?? 'online', title: g.role?.name ?? t('members.online'), color: g.role?.color ?? null, rows: toRows(g.members) }));
    return { sections: list.filter((section) => section.rows.length > 0), offline: toRows(grouped.offline) };
  }, [guild, members, roles, friendIds, users, presence, t]);

  const onMenu = (e: ReactMouseEvent, user: PublicUser, voiceChannelId: string | null) => {
    // The menu item runs after this event is over, when React has already cleared e.currentTarget:
    // capture the row's rectangle now.
    const rect = anchorRect(e);
    const entries: MenuEntry[] = [{ label: t('members.profile'), icon: <User size={15} />, onSelect: () => openProfile(rect, user.id) }];
    if (user.id !== selfId) {
      entries.push({
        label: t('dm.message'),
        icon: <MessageCircle size={15} />,
        onSelect: () => {
          openDm(user.id).catch((err: unknown) => toast.error(friendlyError(err, t('dm.failed')), 'dm-open'));
        },
      });
      if (voiceChannelId && (can('MOVE_USERS') || can('DISCONNECT_USERS'))) {
        entries.push({ kind: 'separator' });
        if (can('MOVE_USERS')) entries.push({ label: t('voice.moderation.moveTo'), icon: <ArrowRightLeft size={15} />, onSelect: () => openMoveUser(user, voiceChannelId) });
        if (can('DISCONNECT_USERS')) entries.push({ label: t('voice.menu.disconnect'), icon: <PhoneOff size={15} />, danger: true, onSelect: () => openVoiceDisconnect(user, voiceChannelId) });
      }
    }
    openMenu(e, entries, user.displayName);
  };

  const ownerId = guild?.ownerId;
  return (
    <aside className="members" aria-label={t('members.title')}>
      <div className="members-scroll">
        {sections.map((section) => (
          <section key={section.key} aria-labelledby={`members-${section.key}`}>
            <h2 id={`members-${section.key}`} className="members-title" style={section.color ? ({ '--members-role': section.color } as CSSProperties) : undefined}>
              {section.title} — <span className="members-count">{section.rows.length}</span>
            </h2>
            <ul className="member-list">
              {section.rows.map(({ user, display }) => (
                <MemberRow key={user.id} user={user} display={display} presence={presence[user.id]} inVoice={voiceOf.get(user.id) ?? null} owner={user.id === ownerId} onMenu={onMenu} />
              ))}
            </ul>
          </section>
        ))}
        {sections.length === 0 && (
          <section aria-labelledby="members-online">
            <h2 id="members-online" className="members-title">
              {t('members.online')} — <span className="members-count">0</span>
            </h2>
            <ul className="member-list">
              <li className="member-empty">{t('members.nobodyOnline')}</li>
            </ul>
          </section>
        )}
        {offline.length > 0 && (
          <section aria-labelledby="members-offline">
            <h2 id="members-offline" className="members-title">
              {t('members.offline')} — <span className="members-count">{offline.length}</span>
            </h2>
            <ul className="member-list">
              {offline.map(({ user, display }) => (
                <MemberRow key={user.id} user={user} display={display} presence={presence[user.id]} inVoice={null} owner={user.id === ownerId} onMenu={onMenu} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
