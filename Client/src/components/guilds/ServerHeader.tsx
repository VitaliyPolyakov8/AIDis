import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, BellRing, CheckCheck, ChevronDown, Folder, Hash, IdCard, LogOut, Settings, UserPlus } from 'lucide-react';
import type { MyGuildView, NotifyMode, Permission } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildStore } from '../../stores/guildStore';
import { useReadStore } from '../../stores/readStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { openMenu, type MenuEntry } from '../menu/MenuHost';
import { openCreateChannel } from '../admin/ChannelDialog';
import { openGuildDialog } from './guildDialogs';

/** Any of these opens "Server settings" (each section checks its own permission). */
export const SETTINGS_PERMISSIONS: readonly Permission[] = [
  'MANAGE_GUILD',
  'MANAGE_ROLES',
  'MANAGE_CHANNELS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'VIEW_AUDIT_LOG',
  'CREATE_EMOJIS',
  'MANAGE_EMOJIS',
  'CREATE_SOUNDS',
  'MANAGE_SOUNDS',
  'MANAGE_NICKNAMES',
];

async function setServerNotify(guild: MyGuildView, mode: NotifyMode | null, failed: string) {
  const before = guild.me.notifyMode;
  useGuildStore.getState().applyGuild({ ...guild, me: { ...guild.me, notifyMode: mode } });
  try {
    await guildsApi.updateMySettings(guild.id, { notifyMode: mode });
    // Channels without their own setting follow the server: unread badges change.
    await useReadStore.getState().load();
  } catch (e) {
    const current = useGuildStore.getState().guilds.find((g) => g.id === guild.id);
    if (current) useGuildStore.getState().applyGuild({ ...current, me: { ...current.me, notifyMode: before } });
    toast.error(friendlyError(e, failed), 'guild-notify');
  }
}

/** Server name at the top of the channel list; the Discord-like server menu. */
export function ServerHeader({ guild }: { guild: MyGuildView }) {
  const { t } = useTranslation();
  const selfId = useAuthStore((s) => s.user?.id);
  const has = (p: Permission) => guild.me.permissions.includes(p);

  const open = (e: ReactMouseEvent) => {
    const entries: MenuEntry[] = [];
    if (has('CREATE_INVITE')) entries.push({ label: t('server.invite'), icon: <UserPlus size={15} />, onSelect: () => openGuildDialog({ kind: 'invite', guildId: guild.id }) });
    if (SETTINGS_PERMISSIONS.some(has)) entries.push({ label: t('server.settings'), icon: <Settings size={15} />, onSelect: () => openGuildDialog({ kind: 'settings', guildId: guild.id }) });
    if (has('MANAGE_CHANNELS')) {
      entries.push({ label: t('channels.newChannel'), icon: <Hash size={15} />, onSelect: () => openCreateChannel(guild.id, 'TEXT') });
      entries.push({ label: t('channels.newCategory'), icon: <Folder size={15} />, onSelect: () => openCreateChannel(guild.id, 'CATEGORY') });
    }
    if (entries.length > 0) entries.push({ kind: 'separator' });
    entries.push({
      label: t('server.markAllRead'),
      icon: <CheckCheck size={15} />,
      onSelect: () => {
        const reads = useReadStore.getState();
        const channels = useGuildStore.getState().byGuild[guild.id]?.channels ?? [];
        for (const c of channels) if ((reads.reads[c.id]?.unread ?? 0) > 0) reads.markAllRead(c.id);
      },
    });
    const mode = guild.me.notifyMode;
    const pick = (m: NotifyMode | null) => () => void setServerNotify(guild, m, t('notify.failed'));
    entries.push(
      { kind: 'title', label: t('server.notifications') },
      { label: `${t('server.notifyDefault')} (${t(`notify.${guild.defaultNotifyMode}`)})`, icon: <Bell size={15} />, onSelect: pick(null), checked: mode === null },
      { label: t('notify.ALL'), icon: <Bell size={15} />, onSelect: pick('ALL'), checked: mode === 'ALL' },
      { label: t('notify.MENTIONS'), icon: <BellRing size={15} />, onSelect: pick('MENTIONS'), checked: mode === 'MENTIONS' },
      { label: t('notify.NONE'), icon: <BellOff size={15} />, onSelect: pick('NONE'), checked: mode === 'NONE' },
      { kind: 'separator' },
      { label: t('server.profile'), icon: <IdCard size={15} />, onSelect: () => openGuildDialog({ kind: 'profile', guildId: guild.id }) },
    );
    if (guild.ownerId !== selfId) entries.push({ label: t('server.leave'), icon: <LogOut size={15} />, danger: true, onSelect: () => openGuildDialog({ kind: 'leave', guildId: guild.id }) });
    openMenu(e, entries, guild.name);
  };

  return (
    <button type="button" className="rail-header server-header" title={t('server.menuTitle')} onClick={open}>
      <span className="server-name">{guild.name}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}
