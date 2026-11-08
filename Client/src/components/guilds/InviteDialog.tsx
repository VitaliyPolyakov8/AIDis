import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2 } from 'lucide-react';
import { invitesApi, inviteUrl, MAX_AGES, MAX_USES } from '../../api/invites';
import type { InviteView } from '../../api/types';
import { friendlyError } from '../../api/errors';
import { useGuildStore } from '../../stores/guildStore';
import { toast } from '../../stores/uiStore';
import { copyText } from '../../utils/imageClipboard';
import { Modal } from '../Modal';
import { closeGuildDialog } from './guildDialogs';

const DEFAULT_AGE = 604800;
const DEFAULT_USES = 0;

/** 0.7.0: an invite link for a server (expiry and max uses), made when the dialog opens. */
export function InviteDialog({ guildId, channelId }: { guildId: string; channelId?: string | null }) {
  const { t } = useTranslation();
  const guildName = useGuildStore((s) => s.guilds.find((g) => g.id === guildId)?.name ?? '');
  const [maxAge, setMaxAge] = useState<number>(DEFAULT_AGE);
  const [maxUses, setMaxUses] = useState<number>(DEFAULT_USES);
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [madeWith, setMadeWith] = useState<{ age: number; uses: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const make = useCallback(
    async (age: number, uses: number) => {
      setBusy(true);
      setError(null);
      try {
        const { invite: created } = await invitesApi.create(guildId, { maxAgeSeconds: age, maxUses: uses, channelId: channelId ?? null });
        setInvite(created);
        setMadeWith({ age, uses });
      } catch (e) {
        setError(friendlyError(e, t('guilds.invite.failed')));
      } finally {
        setBusy(false);
      }
    },
    [guildId, channelId, t],
  );

  // The first link is made when the dialog opens (state is only set when the answer arrives).
  useEffect(() => {
    let alive = true;
    invitesApi.create(guildId, { maxAgeSeconds: DEFAULT_AGE, maxUses: DEFAULT_USES, channelId: channelId ?? null }).then(
      ({ invite: created }) => {
        if (!alive) return;
        setInvite(created);
        setMadeWith({ age: DEFAULT_AGE, uses: DEFAULT_USES });
        setBusy(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(friendlyError(e, t('guilds.invite.failed')));
        setBusy(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [guildId, channelId, t]);

  const link = invite ? inviteUrl(invite.code) : '';
  const copy = async () => {
    if (!link) return;
    if (await copyText(link)) toast.success(t('guilds.invite.copied'), 'invite-copy');
    else toast.error(t('guilds.invite.copyFailed'), 'invite-copy');
  };
  const ageLabel = (age: number) => t(`guilds.invite.ages.a${age}`);
  const usesLabel = (uses: number) => (uses === 0 ? t('guilds.invite.unlimited') : String(uses));
  const changed = !madeWith || madeWith.age !== maxAge || madeWith.uses !== maxUses;

  return (
    <Modal title={t('guilds.invite.title', { name: guildName })} onClose={closeGuildDialog} size="sm">
      <div className="guild-invite">
        <p className="field-hint">{t('guilds.invite.hint')}</p>
        <label className="field">
          <span className="field-label">{t('guilds.invite.link')}</span>
          <span className="input-row">
            <span className="input-with-icon">
              <Link2 size={16} aria-hidden="true" />
              <input className="input" readOnly value={link} aria-busy={busy} onFocus={(e) => e.currentTarget.select()} />
            </span>
            <button type="button" className="btn btn-primary" disabled={!link} onClick={() => void copy()}>
              <Copy size={15} aria-hidden="true" /> {t('guilds.invite.copy')}
            </button>
          </span>
          {invite && madeWith && <span className="field-hint">{t('guilds.invite.summary', { age: ageLabel(madeWith.age), uses: usesLabel(madeWith.uses) })}</span>}
        </label>
        <div className="guild-invite-options">
          <label className="field">
            <span className="field-label">{t('guilds.invite.expires')}</span>
            <select className="input" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
              {MAX_AGES.map((age) => (
                <option key={age} value={age}>
                  {ageLabel(age)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('guilds.invite.uses')}</span>
            <select className="input" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
              {MAX_USES.map((uses) => (
                <option key={uses} value={uses}>
                  {usesLabel(uses)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={closeGuildDialog}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy || !changed} onClick={() => void make(maxAge, maxUses)}>
            {t('guilds.invite.regenerate')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
