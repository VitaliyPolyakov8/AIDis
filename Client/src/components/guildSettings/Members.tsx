import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Crown, Pencil, Search, UserMinus } from 'lucide-react';
import type { MemberView } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { rolesApi } from '../../api/roles';
import { friendlyError } from '../../api/errors';
import { memberDisplay, useGuildMembers, useGuildStore } from '../../stores/guildStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { usePermsStore } from '../../stores/permsStore';
import { toast } from '../../stores/uiStore';
import { formatFullDate } from '../../utils/time';
import { Avatar } from '../Avatar';
import { ConfirmDialog } from '../ConfirmDialog';
import { UserBadges } from '../profile/ProfileBits';
import { canActOnMember, canEditRole } from './hierarchy';
import type { GuildContext } from './context';

type Pending = { kind: 'kick' | 'ban'; member: MemberView; name: string } | null;

function NicknameRow({ ctx, member, onDone }: { ctx: GuildContext; member: MemberView; onDone: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(member.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const nickname = value.trim() || null;
      if (member.userId === ctx.selfId) await guildsApi.updateMyProfile(ctx.guild.id, { nickname });
      else await guildsApi.setNickname(ctx.guild.id, member.userId, nickname);
      await useGuildStore.getState().refreshMembers(ctx.guild.id);
      toast.success(t('gs.members.nicknameSaved'), 'member-nick');
      onDone();
    } catch (e) {
      toast.error(friendlyError(e, t('gs.members.failed')), 'member-nick');
      setBusy(false);
    }
  };
  return (
    <form
      className="input-row gs-nick-row"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input className="input" data-autofocus value={value} maxLength={32} onChange={(e) => setValue(e.target.value)} aria-label={t('gs.members.nickname')} placeholder={t('gs.members.nickname')} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {t('common.save')}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
        {t('common.cancel')}
      </button>
    </form>
  );
}

/** Everyone sees the list; roles, nicknames, kicks and bans follow permissions and the role order. */
export function MembersSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const members = useGuildMembers(ctx.guild.id);
  const users = usePresenceStore((s) => s.users);
  const badges = usePermsStore((s) => s.badges);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [nickFor, setNickFor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const assignable = ctx.rolesDesc.filter((r) => !r.isEveryone);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .map((m) => ({ member: m, user: users[m.userId], view: memberDisplay(users[m.userId], m, ctx.roles) }))
      .filter(({ user, view }) => !q || view.name.toLowerCase().includes(q) || (user?.username ?? '').toLowerCase().includes(q) || (user?.displayName ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.view.name.localeCompare(b.view.name));
  }, [members, users, ctx.roles, query]);

  const toggleRole = async (member: MemberView, roleId: string) => {
    setBusy(member.userId);
    const next = member.roleIds.includes(roleId) ? member.roleIds.filter((r) => r !== roleId) : [...member.roleIds, roleId];
    try {
      await guildsApi.setMemberRoles(ctx.guild.id, member.userId, next);
      useGuildStore.getState().applyMember(ctx.guild.id, { ...member, roleIds: next });
      if (member.userId === ctx.selfId) void useGuildStore.getState().refreshMe(ctx.guild.id);
    } catch (e) {
      toast.error(friendlyError(e, t('gs.members.failed')), 'member-role');
    } finally {
      setBusy(null);
    }
  };

  const toggleBadge = async (userId: string, current: string[], key: string) => {
    setBusy(userId);
    try {
      const nextKeys = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      await rolesApi.setUserBadges(
        userId,
        badges.filter((b) => nextKeys.includes(b.key)).map((b) => b.id),
      );
    } catch (e) {
      toast.error(friendlyError(e, t('gs.members.failed')), 'member-badge');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gs-section">
      <label className="input-with-icon gs-search">
        <Search size={15} aria-hidden="true" />
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('gs.members.search')} aria-label={t('gs.members.search')} />
      </label>
      <p className="field-hint">{t('gs.members.count', { count: members.length })}</p>
      {rows.length === 0 && <p className="field-hint">{t('gs.members.none')}</p>}
      <ul className="admin-list admin-members">
        {rows.map(({ member, user, view }) => {
          const self = member.userId === ctx.selfId;
          const above = canActOnMember(member, ctx.roles, ctx.rank, ctx.selfId, ctx.guild.ownerId);
          const canNick = (self && ctx.has('CHANGE_NICKNAME')) || (above && ctx.has('MANAGE_NICKNAMES'));
          const userBadges = user?.badges ?? [];
          return (
            <li key={member.userId} className={`admin-member${busy === member.userId ? ' is-busy' : ''}`}>
              <div className="admin-member-head">
                <Avatar userId={member.userId} name={view.name} avatarAttachmentId={view.avatarAttachmentId} size={32} />
                <span className="admin-row-name">
                  <span style={view.roleColor ? { color: view.roleColor } : undefined}>{view.name}</span> <span className="profile-muted">@{user?.username ?? '…'}</span>
                  <span className="field-hint gs-joined">{t('gs.members.joined', { date: formatFullDate(member.joinedAt) })}</span>
                </span>
                {member.userId === ctx.guild.ownerId && <Crown size={14} style={{ color: '#f0b232' }} aria-label={t('gs.members.owner')} />}
                {user && <UserBadges user={user} />}
                <span className="admin-row-actions">
                  {canNick && (
                    <button type="button" className="icon-btn" aria-label={`${t('gs.members.setNickname')}: ${view.name}`} title={t('gs.members.setNickname')} onClick={() => setNickFor(member.userId)}>
                      <Pencil size={15} />
                    </button>
                  )}
                  {above && ctx.has('KICK_MEMBERS') && (
                    <button
                      type="button"
                      className="icon-btn is-danger-hover"
                      aria-label={`${t('gs.members.kick')}: ${view.name}`}
                      title={t('gs.members.kick')}
                      onClick={() => setPending({ kind: 'kick', member, name: view.name })}
                    >
                      <UserMinus size={15} />
                    </button>
                  )}
                  {above && ctx.has('BAN_MEMBERS') && (
                    <button
                      type="button"
                      className="icon-btn is-danger-hover"
                      aria-label={`${t('gs.members.ban')}: ${view.name}`}
                      title={t('gs.members.ban')}
                      onClick={() => setPending({ kind: 'ban', member, name: view.name })}
                    >
                      <Ban size={15} />
                    </button>
                  )}
                </span>
              </div>
              {nickFor === member.userId && <NicknameRow ctx={ctx} member={member} onDone={() => setNickFor(null)} />}
              {(assignable.length > 0 || (ctx.superadmin && badges.length > 0)) && (
                <div className="chip-list">
                  {assignable.map((r) => {
                    const on = member.roleIds.includes(r.id);
                    const allowed = ctx.has('MANAGE_ROLES') && canEditRole(r, ctx.rank) && (self || above);
                    if (!on && !allowed) return null;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={`chip${on ? ' is-on' : ''}`}
                        style={r.color ? ({ '--chip-color': r.color } as CSSProperties) : undefined}
                        disabled={!allowed || busy === member.userId}
                        aria-pressed={on}
                        onClick={() => void toggleRole(member, r.id)}
                      >
                        {r.name}
                      </button>
                    );
                  })}
                  {ctx.superadmin &&
                    badges.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`chip is-badge${userBadges.includes(b.key) ? ' is-on' : ''}`}
                        style={{ '--chip-color': b.color } as CSSProperties}
                        disabled={busy === member.userId}
                        title={t('gs.members.badges')}
                        onClick={() => void toggleBadge(member.userId, userBadges, b.key)}
                      >
                        {b.label}
                      </button>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {pending && (
        <ConfirmDialog
          title={t(pending.kind === 'kick' ? 'gs.members.kickTitle' : 'gs.members.banTitle', { name: pending.name })}
          confirmLabel={t(pending.kind === 'kick' ? 'gs.members.kick' : 'gs.members.ban')}
          onClose={() => {
            setPending(null);
            setReason('');
          }}
          onConfirm={async () => {
            try {
              if (pending.kind === 'kick') await guildsApi.kick(ctx.guild.id, pending.member.userId);
              else await guildsApi.ban(ctx.guild.id, pending.member.userId, reason.trim() || undefined);
              useGuildStore.getState().dropMember(ctx.guild.id, pending.member.userId);
              toast.success(t('gs.members.done'), 'member-moderation');
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.members.failed')), { cause: e });
            }
          }}
        >
          <p>{t(pending.kind === 'kick' ? 'gs.members.kickBody' : 'gs.members.banBody')}</p>
          {pending.kind === 'ban' && (
            <label className="field">
              <span className="field-label">{t('gs.members.banReason')}</span>
              <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
