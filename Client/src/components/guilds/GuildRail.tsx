import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Compass, Globe, Plus } from 'lucide-react';
import type { MyGuildView } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { LogoMark } from '../Logo';
import { GuildIcon } from './GuildIcon';
import { useGuildChannels, useGuildStore } from '../../stores/guildStore';
import { useChatStore } from '../../stores/chatStore';
import { isMutedRead, useReadStore } from '../../stores/readStore';
import { useFriendsStore } from '../../stores/friendsStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { openMenu } from '../menu/MenuHost';
import { openGuildDialog } from './guildDialogs';
import { openAdminSection } from '../admin/AdminPanel';
import { guildPath, homePath, HOME_SEGMENT } from './routes';

const count = (n: number) => (n > 99 ? '99+' : String(n));

/** One server in the rail: icon, mention count or unread pip, drag to reorder. */
function GuildButton({ guild, active, dragProps }: { guild: MyGuildView; active: boolean; dragProps: object }) {
  const navigate = useNavigate();
  const channels = useGuildChannels(guild.id);
  const mentions = useReadStore((s) => channels.reduce((n, c) => n + (s.reads[c.id]?.mentions ?? 0), 0));
  const unread = useReadStore((s) => channels.some((c) => (s.reads[c.id]?.unread ?? 0) > 0 && !isMutedRead(s.reads[c.id])));
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`guild-btn is-server${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
      title={guild.name}
      aria-label={guild.name}
      onClick={() => void navigate(guildPath(guild.id))}
      {...dragProps}
    >
      <GuildIcon name={guild.name} iconAttachmentId={guild.iconAttachmentId} />
      {mentions > 0 ? <span className="guild-badge">{count(mentions)}</span> : unread && <span className="guild-pip" aria-hidden="true" />}
    </button>
  );
}

function useRailDrag(guilds: MyGuildView[]) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return (guild: MyGuildView) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDragging(guild.id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-aidis-guild', guild.id);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragging || dragging === guild.id) return;
      e.preventDefault();
      setOver(guild.id);
    },
    onDragLeave: () => setOver((o) => (o === guild.id ? null : o)),
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragging;
      setDragging(null);
      setOver(null);
      if (!from || from === guild.id) return;
      const ids = guilds.map((g) => g.id).filter((id) => id !== from);
      ids.splice(ids.indexOf(guild.id), 0, from);
      useGuildStore.getState().setOrder(ids);
      guildsApi.setOrder(ids).catch((err: unknown) => {
        toast.error(friendlyError(err, t('rail.orderFailed')), 'guild-order');
        void useGuildStore
          .getState()
          .loadGuilds()
          .catch(() => undefined);
      });
    },
    'data-drop-target': over === guild.id ? 'true' : undefined,
  });
}

/** 0.7.0 left column: Home (friends and DMs), my servers, add a server, all servers (superadmin). */
export function GuildRail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const guilds = useGuildStore((s) => s.guilds);
  const activeGuildId = useGuildStore((s) => s.activeGuildId);
  const dms = useChatStore((s) => s.dms);
  const dmUnread = useReadStore((s) => dms.reduce((n, d) => n + (isMutedRead(s.reads[d.id]) ? 0 : (s.reads[d.id]?.unread ?? 0)), 0));
  const requests = useFriendsStore((s) => s.incoming.length);
  const superadmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const drag = useRailDrag(guilds);
  const home = location.pathname.startsWith(`/channels/${HOME_SEGMENT}`) || (activeGuildId === null && !location.pathname.startsWith('/channels/'));
  const homeCount = dmUnread + requests;

  const add = (e: ReactMouseEvent) =>
    openMenu(
      e,
      [
        { label: t('rail.createServer'), icon: <Plus size={15} />, onSelect: () => openGuildDialog({ kind: 'create' }) },
        { label: t('rail.joinServer'), icon: <Compass size={15} />, onSelect: () => openGuildDialog({ kind: 'join' }) },
      ],
      t('rail.addServer'),
    );

  return (
    <div className="guild-rail" role="tablist" aria-label={t('rail.servers')} aria-orientation="vertical">
      <button type="button" role="tab" aria-selected={home} className={`guild-btn is-home${home ? ' is-active' : ''}`} title={t('rail.home')} aria-label={t('rail.home')} onClick={() => void navigate(homePath())}>
        <LogoMark size={30} />
        {homeCount > 0 && <span className="guild-badge">{count(homeCount)}</span>}
      </button>
      <span className="guild-sep" aria-hidden="true" />
      {guilds.map((g) => (
        <GuildButton key={g.id} guild={g} active={!home && g.id === activeGuildId} dragProps={drag(g)} />
      ))}
      <button type="button" className="guild-btn is-ghost" title={t('rail.addServer')} aria-label={t('rail.addServer')} onClick={add}>
        <Plus size={20} />
      </button>
      {superadmin && (
        <button type="button" className="guild-btn is-ghost" title={t('rail.allServers')} aria-label={t('rail.allServers')} onClick={() => openAdminSection('guilds')}>
          <Globe size={20} />
        </button>
      )}
    </div>
  );
}
