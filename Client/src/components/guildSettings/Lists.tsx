import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Shield, UserPlus, X } from 'lucide-react';
import type { AuditEntry, BanView, InviteView } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { invitesApi, inviteUrl } from '../../api/invites';
import { friendlyError } from '../../api/errors';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { formatFullDate, formatMessageTimestamp } from '../../utils/time';
import { copyText } from '../../utils/imageClipboard';
import { Avatar } from '../Avatar';
import type { GuildContext } from './context';

const useUserName = () => {
  const users = usePresenceStore((s) => s.users);
  return (id: string | null) => (id ? (users[id]?.displayName ?? '…') : '');
};

/** Loads a list once and on demand (bans, invites). */
function useList<T>(load: () => Promise<T[]>, failed: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setItems, (e: unknown) => setError(friendlyError(e, failed)));
  }, [load, failed]);
  return { items, setItems, error };
}

export function BansSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const name = useUserName();
  const users = usePresenceStore((s) => s.users);
  const guildId = ctx.guild.id;
  const load = useCallback(() => guildsApi.bans(guildId).then((r) => r.bans), [guildId]);
  const { items, setItems, error } = useList<BanView>(load, t('gs.bans.failed'));
  const unban = async (userId: string) => {
    try {
      await guildsApi.unban(guildId, userId);
      setItems((list) => (list ?? []).filter((b) => b.userId !== userId));
      toast.success(t('gs.bans.unbanned'), 'unban');
    } catch (e) {
      toast.error(friendlyError(e, t('gs.members.failed')), 'unban');
    }
  };
  return (
    <div className="gs-section">
      {error && <p className="field-error">{error}</p>}
      {items === null && !error && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {items?.length === 0 && <p className="field-hint">{t('gs.bans.empty')}</p>}
      <ul className="admin-list">
        {items?.map((b) => (
          <li key={b.userId} className="admin-row">
            <Avatar userId={b.userId} name={name(b.userId)} avatarAttachmentId={users[b.userId]?.avatarAttachmentId ?? null} size={28} />
            <span className="admin-row-name">
              {name(b.userId)}
              <span className="field-hint">
                {b.reason ? `${t('gs.bans.reason', { reason: b.reason })} · ` : ''}
                {t('gs.bans.by', { name: name(b.bannedById), date: formatFullDate(b.createdAt) })}
              </span>
            </span>
            <span className="admin-row-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void unban(b.userId)}>
                {t('gs.bans.unban')}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InvitesSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const name = useUserName();
  const guildId = ctx.guild.id;
  const load = useCallback(() => invitesApi.list(guildId).then((r) => r.invites), [guildId]);
  const { items, setItems, error } = useList<InviteView>(load, t('gs.invites.failed'));
  const all = ctx.has('MANAGE_GUILD');
  // A new 7-day invite without a use limit, copied at once (the invite dialog has the other options).
  const create = async () => {
    try {
      const { invite } = await invitesApi.create(guildId, { maxAgeSeconds: 604800, maxUses: 0 });
      setItems((list) => [invite, ...(list ?? [])]);
      if (await copyText(inviteUrl(invite.code))) toast.success(t('guilds.invite.copied'), 'invite-copy');
    } catch (e) {
      toast.error(friendlyError(e, t('guilds.invite.failed')), 'invite-create');
    }
  };
  const revoke = async (code: string) => {
    try {
      await invitesApi.revoke(code);
      setItems((list) => (list ?? []).filter((i) => i.code !== code));
      toast.success(t('gs.invites.revoked'), 'invite-revoke');
    } catch (e) {
      toast.error(friendlyError(e, t('gs.members.failed')), 'invite-revoke');
    }
  };
  return (
    <div className="gs-section">
      {ctx.has('CREATE_INVITE') && (
        <button type="button" className="btn btn-secondary" onClick={() => void create()}>
          <UserPlus size={15} aria-hidden="true" /> {t('gs.invites.create')}
        </button>
      )}
      {!all && <p className="field-hint">{t('gs.invites.mineOnly')}</p>}
      {error && <p className="field-error">{error}</p>}
      {items === null && !error && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {items?.length === 0 && <p className="field-hint">{t('gs.invites.empty')}</p>}
      <ul className="admin-list">
        {items?.map((i) => (
          <li key={i.code} className="admin-row">
            <code className="gs-invite-code">{i.code}</code>
            <span className="admin-row-name">
              <span className="field-hint">{i.maxUses ? t('gs.invites.usesOf', { uses: i.uses, max: i.maxUses }) : t('gs.invites.uses', { uses: i.uses })}</span>
              <span className="field-hint">
                {i.expiresAt ? t('gs.invites.expires', { date: formatFullDate(i.expiresAt) }) : t('gs.invites.never')} · {t('gs.invites.by', { name: name(i.creatorId) })}
              </span>
            </span>
            <span className="admin-row-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label={`${t('guilds.invite.copy')}: ${i.code}`}
                onClick={() => void copyText(inviteUrl(i.code)).then((ok) => (ok ? toast.success(t('guilds.invite.copied'), 'invite-copy') : toast.error(t('guilds.invite.copyFailed'), 'invite-copy')))}
              >
                <Copy size={15} />
              </button>
              {(all || i.creatorId === ctx.selfId) && (
                <button type="button" className="icon-btn is-danger-hover" aria-label={`${t('gs.invites.revoke')}: ${i.code}`} title={t('gs.invites.revoke')} onClick={() => void revoke(i.code)}>
                  <X size={15} />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AuditSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const guildId = ctx.guild.id;
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = useCallback(
    (before?: string) => {
      guildsApi.audit(guildId, before).then(
        ({ entries: next }) => {
          setEntries((list) => [...(before ? (list ?? []) : []), ...next]);
          setMore(next.length === 50);
        },
        (e: unknown) => setError(friendlyError(e, t('admin.audit.failed'))),
      );
    },
    [guildId, t],
  );
  useEffect(() => load(), [load]);
  const describe = (e: AuditEntry) => {
    const d = e.details ?? {};
    const s = (...keys: string[]) => {
      for (const k of keys) if (typeof d[k] === 'string' && d[k]) return d[k];
      return '';
    };
    const target =
      e.targetType === 'user' && e.targetId ? (users[e.targetId]?.displayName ?? s('user')) : e.targetType === 'invite' ? (e.targetId ?? '') : s('name', 'channelName', 'module', 'user') || (e.targetId ?? '');
    return t(`admin.audit.actions.${e.action}`, { target, from: s('from', 'renamedFrom'), to: s('to'), channel: s('channel', 'channelName'), defaultValue: e.action });
  };
  return (
    <div className="gs-section">
      {error && <p className="field-error">{error}</p>}
      {entries === null && !error && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {entries?.length === 0 && <p className="field-hint">{t('admin.audit.empty')}</p>}
      <ul className="audit-list">
        {entries?.map((e) => {
          const actor = e.actorId ? users[e.actorId] : undefined;
          return (
            <li key={e.id} className="audit-row">
              {actor ? <Avatar userId={actor.id} name={actor.displayName} avatarAttachmentId={actor.avatarAttachmentId} size={24} /> : <Shield size={18} aria-hidden="true" />}
              <span className="audit-text">
                <strong>{actor?.displayName ?? t('admin.audit.system')}</strong> {describe(e)}
              </span>
              <time className="audit-time" dateTime={e.createdAt}>
                {formatMessageTimestamp(e.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
      {entries && more && entries.length > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(entries[entries.length - 1]?.id)}>
          {t('admin.audit.more')}
        </button>
      )}
    </div>
  );
}
