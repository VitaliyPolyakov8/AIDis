import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { invitesApi } from '../../api/invites';
import type { InvitePreview } from '../../api/types';
import { friendlyError } from '../../api/errors';
import { toast } from '../../stores/uiStore';
import { formatFullDate } from '../../utils/time';
import { GuildIcon } from './GuildIcon';
import { enterGuild } from './enterGuild';
import { guildPath } from './routes';

export type PreviewState = { status: 'loading' } | { status: 'ready'; invite: InvitePreview } | { status: 'error'; message: string };

/** Loads an invite preview (name, icon, member counts) for a code. */
export function useInvitePreview(code: string | null): PreviewState {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ code: string; state: PreviewState } | null>(null);
  useEffect(() => {
    if (!code) return;
    let alive = true;
    invitesApi.preview(code).then(
      ({ invite }) => alive && setResult({ code, state: { status: 'ready', invite } }),
      (e: unknown) => alive && setResult({ code, state: { status: 'error', message: friendlyError(e, t('guilds.card.invalid')) } }),
    );
    return () => {
      alive = false;
    };
  }, [code, t]);
  return result && result.code === code ? result.state : { status: 'loading' };
}

/** Accepts an invite and opens the server. */
export function useJoinInvite() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const join = async (invite: InvitePreview, onDone?: () => void): Promise<string | null> => {
    if (invite.alreadyMember) {
      onDone?.();
      void navigate(guildPath(invite.guild.id));
      return null;
    }
    setBusy(true);
    try {
      const { guild, channelId } = await invitesApi.accept(invite.code);
      const path = await enterGuild(guild, channelId);
      toast.success(t('guilds.join.joined', { name: guild.name }), 'guild-joined');
      onDone?.();
      void navigate(path);
      return null;
    } catch (e) {
      return friendlyError(e, t('guilds.join.failed'));
    } finally {
      setBusy(false);
    }
  };
  return { join, busy };
}

/** The invite's server with the Join / Open button (dialog, invite page and chat card). */
export function InvitePreviewCard({ state, compact = false, onDone }: { state: PreviewState; compact?: boolean; onDone?: () => void }) {
  const { t } = useTranslation();
  const { join, busy } = useJoinInvite();
  const [error, setError] = useState<string | null>(null);
  if (state.status === 'loading') return <div className={`invite-card${compact ? ' is-compact' : ''} is-loading`}>{t('guilds.join.loading')}</div>;
  if (state.status === 'error')
    return (
      <div className={`invite-card${compact ? ' is-compact' : ''} is-invalid`} role="status">
        {state.message}
      </div>
    );
  const { invite } = state;
  return (
    <div className={`invite-card${compact ? ' is-compact' : ''}`}>
      {compact && <span className="invite-card-kicker">{t('guilds.card.title')}</span>}
      <div className="invite-card-body">
        <span className="invite-card-icon">
          <GuildIcon name={invite.guild.name} iconAttachmentId={invite.guild.iconAttachmentId} size={compact ? 44 : 64} />
        </span>
        <span className="invite-card-text">
          <strong className="invite-card-name">{invite.guild.name}</strong>
          <span className="invite-card-counts">
            <span className="invite-card-online">{t('guilds.join.online', { count: invite.onlineCount })}</span>
            <span>{t('guilds.join.members', { count: invite.memberCount })}</span>
          </span>
          {invite.expiresAt && !compact && <span className="field-hint">{t('guilds.join.expires', { date: formatFullDate(invite.expiresAt) })}</span>}
        </span>
        <button
          type="button"
          className={`btn ${invite.alreadyMember ? 'btn-secondary' : 'btn-success'}`}
          disabled={busy}
          onClick={() => {
            setError(null);
            void join(invite, onDone).then((message) => setError(message));
          }}
        >
          {invite.alreadyMember ? t('guilds.join.open') : t('guilds.join.submit')}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
