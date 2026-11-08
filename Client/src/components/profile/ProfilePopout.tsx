import { useCallback, type CSSProperties } from 'react';
import { friendsErrorText, useFriendsStore } from '../../stores/friendsStore';
import { bannerUrl } from '../../cosmetics/catalog';
import { PlatformIcons } from './PlatformIcons';
import { nameStyleOf } from './nameStyle';
import { GameShelf } from '../../games/GameShelf';
import { Confetti } from './Confetti';
import { isBirthdayToday } from '../../utils/season';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Cake, MessageCircle, Pencil, UserMinus, UserPlus } from 'lucide-react';
import { Avatar } from '../Avatar';
import { usePresenceStore } from '../../stores/presenceStore';
import { useAuthStore } from '../../stores/authStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useStatusStore } from '../../stores/statusStore';
import { useGuildRoles, useGuildStore, useMemberDisplay } from '../../stores/guildStore';
import { toast, useUiStore } from '../../stores/uiStore';
import { activeCustomStatus, ownPresenceState, presenceState } from '../../utils/presence';
import { formatLastSeen } from '../../utils/time';
import { gameTheme } from '../../utils/gameTheme';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { friendlyError } from '../../api/errors';
import { usePopover } from './usePopover';
import { useProfilePopout, type ProfileTarget } from './profileState';
import { FramedAvatar, UserBadges } from './ProfileBits';
import { useOpenDm } from '../dm/DmDialogs';
import { GameActivityCard } from './GameArt';
import { useLocalGame } from '../../desktop/localGame';

const close = () => useProfilePopout.setState({ target: null });

/** Banner: the user's image, else a gradient from their accent color (or the game they play). */
function Banner({ attachmentId, accent, game, bannerId }: { attachmentId: string | null | undefined; accent: string; game: string | null; bannerId?: string | null }) {
  // 0.5.1: a built-in animated banner wins over an uploaded image.
  const builtIn = bannerUrl(bannerId);
  const uploaded = useAttachmentUrl(builtIn ? null : (attachmentId ?? null)).url;
  const url = builtIn ?? uploaded;
  const theme = game ? gameTheme(game) : null;
  const style = url
    ? { backgroundImage: `url("${url}")` }
    : { background: theme ? `linear-gradient(135deg, ${theme.accent2}, ${theme.accent})` : `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 35%, #0f1220))` };
  return <div className={`profile-banner${url ? ' has-image' : ''}`} style={style} aria-hidden="true" />;
}

/** 0.7.0: write (friends), add / accept a friend request, or remove a friend. */
function FriendActions({ userId, username, onMessage }: { userId: string; username: string; onMessage: () => void }) {
  const { t } = useTranslation();
  const friend = useFriendsStore((s) => s.friendIds.includes(userId));
  const incoming = useFriendsStore((s) => s.incoming.includes(userId));
  const outgoing = useFriendsStore((s) => s.outgoing.includes(userId));
  const run = (action: () => Promise<unknown>, done: string) =>
    void action().then(
      () => toast.success(done, 'friend-action'),
      (e: unknown) => toast.error(friendsErrorText(e), 'friend-action'),
    );
  if (friend) {
    return (
      <>
        <button type="button" className="btn btn-primary btn-sm" onClick={onMessage}>
          <MessageCircle size={14} aria-hidden="true" /> {t('dm.message')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => useFriendsStore.getState().remove(userId), t('friends.removeDone'))}>
          <UserMinus size={14} aria-hidden="true" /> {t('friends.remove')}
        </button>
      </>
    );
  }
  if (incoming) {
    return (
      <button type="button" className="btn btn-success btn-sm" onClick={() => run(() => useFriendsStore.getState().accept(userId), t('friends.accepted'))}>
        <UserPlus size={14} aria-hidden="true" /> {t('friends.accept')}
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-sm" disabled={outgoing} onClick={() => run(() => useFriendsStore.getState().request(username), t('friends.requestSent'))}>
      <UserPlus size={14} aria-hidden="true" /> {outgoing ? t('friends.requestSent') : t('friends.add')}
    </button>
  );
}

function Card({ target }: { target: ProfileTarget }) {
  const { t } = useTranslation();
  const user = usePresenceStore((s) => s.users[target.userId]);
  const view = usePresenceStore((s) => s.presence[target.userId]);
  const selfId = useAuthStore((s) => s.user?.id);
  const ownStatus = useStatusStore((s) => s.status);
  const ownCustom = useStatusStore((s) => s.customStatus);
  const connected = useConnectionStore((s) => s.socket === 'connected');
  // 0.7.0: roles of the open server (none on Home / in DMs).
  const guildId = useGuildStore((s) => s.activeGuildId);
  const roles = useGuildRoles(guildId);
  const memberRoleIds = useGuildStore((s) => (guildId ? s.byGuild[guildId]?.members.find((m) => m.userId === target.userId)?.roleIds : undefined));
  const shown = useMemberDisplay(guildId, target.userId);
  const localGame = useLocalGame((s) => s.info);
  const onClose = useCallback(() => close(), []);
  const { ref, style } = usePopover(target.x, target.y, onClose);
  const openDm = useOpenDm();
  if (!user) return null;
  const isSelf = user.id === selfId;
  const state = isSelf ? ownPresenceState(ownStatus, connected) : presenceState(view);
  const custom = isSelf ? activeCustomStatus({ customStatus: ownCustom }) : activeCustomStatus(view);
  const activity = state === 'offline' || state === 'invisible' ? null : view?.activity;
  const lastSeen = view?.lastSeenAt ?? user.lastSeenAt;
  const accent = user.accentColor ?? '#5b7cff';
  const myRoles = roles.filter((r) => !r.isEveryone && memberRoleIds?.includes(r.id)).sort((a, b) => b.position - a.position);
  const nameStyle = nameStyleOf(user);
  // 0.5.5 profile theme: a gradient of the two chosen colors behind the whole card.
  const theme = user.accentColor && user.accentColor2 ? { '--profile-theme-1': user.accentColor, '--profile-theme-2': user.accentColor2 } : null;
  const birthday = isBirthdayToday(user.birthday, new Date());
  return (
    <div
      ref={ref}
      className={`profile-card${theme ? ' has-theme' : ''}${birthday ? ' is-birthday' : ''}`}
      role="dialog"
      aria-label={shown.name}
      style={{ ...style, '--profile-accent': accent, ...theme } as CSSProperties}
    >
      {birthday && <Confetti />}
      <Banner attachmentId={shown.bannerAttachmentId} accent={accent} game={activity?.name ?? null} bannerId={user.profileBannerId} />
      <div className="profile-card-head">
        <span className="profile-card-avatar">
          <FramedAvatar frame={user.profileFrame} size={84}>
            <Avatar userId={user.id} name={shown.name} avatarAttachmentId={shown.avatarAttachmentId} size={84} status={state} />
          </FramedAvatar>
        </span>
        <UserBadges user={user} size={16} />
        <PlatformIcons userId={user.id} size={15} />
      </div>
      <div className="profile-card-names">
        <span className="profile-card-name">
          <span className={nameStyle.className} style={nameStyle.style}>
            {shown.name}
          </span>
          {birthday && <Cake size={18} className="profile-birthday-cake" role="img" aria-label={t('profile.birthdayToday')} />}
        </span>
        <span className="profile-card-username">@{user.username}</span>
      </div>
      <div className="profile-card-status">
        <span className={`status-pill is-${state}`}>{t(`status.state.${state}`)}</span>
        {custom && (
          <span className="status-chip-custom" title={custom.text}>
            {custom.emoji && <span className="custom-emoji">{custom.emoji}</span>}
            <span className="custom-status-text">{custom.text}</span>
          </span>
        )}
      </div>
      {activity && <GameActivityCard activity={activity} icon={isSelf && localGame?.name === activity.name ? localGame.icon : null} />}
      <div className="profile-card-body">
        {birthday && <p className="profile-birthday-line">{t('profile.birthdayLine', { name: user.displayName })}</p>}
        {shown.bio && (
          <section className="profile-section">
            <h3>{t('profile.bio')}</h3>
            <p className="profile-bio">{shown.bio}</p>
          </section>
        )}
        {user.profileTags && user.profileTags.length > 0 && (
          <section className="profile-section">
            <h3>{t('profile.tags')}</h3>
            <div className="chip-list">
              {user.profileTags.map((tag) => {
                const tagTheme = gameTheme(tag);
                return (
                  <span key={tag} className="tag-chip" style={{ '--game-accent': tagTheme.accent, '--game-soft': tagTheme.soft } as CSSProperties}>
                    {tag}
                  </span>
                );
              })}
            </div>
          </section>
        )}
        {(user.role === 'ADMIN' || myRoles.length > 0) && (
          <section className="profile-section">
            <h3>{t('profile.roles')}</h3>
            <div className="chip-list">
              {user.role === 'ADMIN' && (
                <span className="role-chip" style={{ '--chip-color': '#f0b232' } as CSSProperties}>
                  {t('members.admin')}
                </span>
              )}
              {myRoles.map((r) => (
                <span key={r.id} className="role-chip" style={{ '--chip-color': r.color ?? '#8e95a5' } as CSSProperties}>
                  {r.name}
                </span>
              ))}
            </div>
          </section>
        )}
        <GameShelf userId={user.id} isSelf={isSelf} />
        {state === 'offline' && (
          <section className="profile-section">
            <h3>{t('profile.lastSeen')}</h3>
            <p className="profile-muted">{formatLastSeen(lastSeen)}</p>
          </section>
        )}
      </div>
      <div className="profile-card-actions">
        {isSelf ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              close();
              useUiStore.getState().openSettings('profile');
            }}
          >
            <Pencil size={14} aria-hidden="true" /> {t('profile.edit')}
          </button>
        ) : (
          <FriendActions
            userId={user.id}
            username={user.username}
            onMessage={() => {
              close();
              openDm(user.id).catch((e: unknown) => toast.error(friendlyError(e, t('dm.failed')), 'dm-open'));
            }}
          />
        )}
      </div>
    </div>
  );
}

export function ProfilePopoutHost() {
  const target = useProfilePopout((s) => s.target);
  if (!target) return null;
  return createPortal(<Card key={`${target.userId}:${target.x}:${target.y}`} target={target} />, document.body);
}
