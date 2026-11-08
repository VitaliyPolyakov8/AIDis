import type { MouseEvent as ReactMouseEvent } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckCheck, LogOut, Plus, Users } from 'lucide-react';
import type { Channel } from '../api/types';
import { Avatar } from './Avatar';
import { UserPanel } from './UserPanel';
import { VoiceDock } from './VoiceDock';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/uiStore';
import { isMutedRead, notifyModeOf, useReadStore } from '../stores/readStore';
import { useActiveGuild } from '../stores/guildStore';
import { useFriendsStore } from '../stores/friendsStore';
import { dmsApi } from '../api/channels';
import { friendlyError } from '../api/errors';
import { openMenu, type MenuEntry } from './menu/MenuHost';
import { openNewDm } from './dm/DmDialogs';
import { dmName, dmOthers, isGroupDm } from '../utils/dm';
import { StyledName } from './profile/StyledName';
import { presenceState } from '../utils/presence';
import { SeasonalDecor } from './SeasonalDecor';
import { GuildRail } from './guilds/GuildRail';
import { ServerHeader } from './guilds/ServerHeader';
import { GuildChannelList } from './guilds/GuildChannelList';
import { UnreadBadge, useNotifyMenu } from './guilds/ChannelItems';
import { dmPath, homePath } from './guilds/routes';

/** Home (no server open): friends and direct messages. */
function DmList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dms = useChatStore((s) => s.dms);
  const users = usePresenceStore((s) => s.users);
  const presence = usePresenceStore((s) => s.presence);
  const selfId = useAuthStore((s) => s.user?.id);
  const markAllRead = useReadStore((s) => s.markAllRead);
  const reads = useReadStore((s) => s.reads);
  const notifyMenu = useNotifyMenu();
  const requests = useFriendsStore((s) => s.incoming.length);

  const onMenu = (e: ReactMouseEvent, dm: Channel) => {
    const read = useReadStore.getState().reads[dm.id];
    const entries: MenuEntry[] = [
      { label: t('chat.unread.markRead'), icon: <CheckCheck size={15} />, onSelect: () => markAllRead(dm.id), disabled: !read || read.unread === 0 },
      { kind: 'separator' },
      ...notifyMenu(dm.id, notifyModeOf(read)),
    ];
    if (isGroupDm(dm)) {
      entries.push({ kind: 'separator' });
      entries.push({
        label: t('dm.leave'),
        icon: <LogOut size={15} />,
        danger: true,
        onSelect: () => {
          dmsApi.leave(dm.id).then(
            () => {
              useChatStore.setState((s) => ({ dms: s.dms.filter((d) => d.id !== dm.id) }));
              void navigate(homePath());
            },
            (err: unknown) => toast.error(friendlyError(err, t('dm.failed')), 'dm-leave'),
          );
        },
      });
    }
    openMenu(e, entries, dmName(dm, users, selfId));
  };

  return (
    <>
      <div className="hub-links">
        <NavLink to={homePath()} end className={({ isActive }) => `channel-link friends-link${isActive ? ' is-active' : ''}`}>
          <Users size={16} className="channel-icon" aria-hidden="true" />
          <span className="channel-name">{t('friends.title')}</span>
          {requests > 0 && <span className="badge badge-mention">{requests > 99 ? '99+' : requests}</span>}
        </NavLink>
      </div>
      <section className="channel-section" aria-labelledby="dm-heading">
        <h2 id="dm-heading" className="channel-section-title">
          <span>{t('dm.title')}</span>
          <button type="button" className="icon-btn icon-btn-xs" aria-label={t('dm.new')} title={t('dm.new')} onClick={openNewDm}>
            <Plus size={14} />
          </button>
        </h2>
        <ul className="channel-list dm-list">
          {dms.map((dm) => {
            const others = dmOthers(dm, selfId);
            const group = isGroupDm(dm);
            const first = others[0];
            const name = dmName(dm, users, selfId);
            return (
              <li key={dm.id}>
                <NavLink
                  to={dmPath(dm.id)}
                  className={({ isActive }) => `channel-link dm-link${isActive ? ' is-active' : ''}${(reads[dm.id]?.unread ?? 0) > 0 && !isMutedRead(reads[dm.id]) ? ' is-unread' : ''}`}
                  onContextMenu={(e) => onMenu(e, dm)}
                >
                  {group || !first ? (
                    <span className="dm-group-icon" aria-hidden="true">
                      <Users size={16} />
                    </span>
                  ) : (
                    <Avatar userId={first} name={name} avatarAttachmentId={users[first]?.avatarAttachmentId} size={30} status={presenceState(presence[first])} />
                  )}
                  <span className="dm-text">
                    <span className="channel-name">{group || !first ? name : <StyledName userId={first} name={name} />}</span>
                    {group && <span className="dm-sub">{t('dm.members', { count: dm.memberIds?.length ?? 0 })}</span>}
                  </span>
                  <UnreadBadge channelId={dm.id} />
                </NavLink>
              </li>
            );
          })}
          {dms.length === 0 && (
            <li className="channel-empty dm-empty">
              <p>{t('dm.empty')}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={openNewDm}>
                <Plus size={14} aria-hidden="true" /> {t('dm.new')}
              </button>
            </li>
          )}
        </ul>
      </section>
    </>
  );
}

/** 0.7.0 left side: the server column, then the open server's channels (or Home: friends and DMs). */
export function ChannelSidebar() {
  const { t } = useTranslation();
  const guild = useActiveGuild();
  return (
    <nav className="rail" aria-label={t('sidebar.channels')}>
      <GuildRail />
      <div className="rail-panel">
        {guild ? (
          <ServerHeader guild={guild} />
        ) : (
          <div className="rail-header">
            <span className="server-name">{t('rail.home')}</span>
          </div>
        )}
        <div className="rail-scroll">{guild ? <GuildChannelList guildId={guild.id} /> : <DmList />}</div>
        <div className="rail-dock">
          <SeasonalDecor />
          <VoiceDock />
          <UserPanel />
        </div>
      </div>
    </nav>
  );
}
