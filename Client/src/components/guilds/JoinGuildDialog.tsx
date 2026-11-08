import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeInviteInput } from '../../api/invites';
import { Modal } from '../Modal';
import { closeGuildDialog, openGuildDialog } from './guildDialogs';
import { InvitePreviewCard, useInvitePreview } from './InvitePreviewCard';

/** 0.7.0: join a server by invite code or link (preview first). */
export function JoinGuildDialog({ initialCode }: { initialCode?: string }) {
  const { t } = useTranslation();
  const [input, setInput] = useState(initialCode ?? '');
  const [code, setCode] = useState<string | null>(initialCode ? normalizeInviteInput(initialCode) : null);
  const [error, setError] = useState<string | null>(null);
  const preview = useInvitePreview(code);

  const find = () => {
    const next = normalizeInviteInput(input);
    setError(next ? null : t('guilds.join.invalid'));
    setCode(next);
  };

  return (
    <Modal title={t('guilds.join.title')} onClose={closeGuildDialog} size="sm">
      <form
        className="guild-join"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <label className="field">
          <span className="field-label">{t('guilds.join.field')}</span>
          <span className="field-hint">{t('guilds.join.hint')}</span>
          <span className="input-row">
            <input
              className="input"
              data-autofocus
              value={input}
              placeholder={t('guilds.join.placeholder')}
              onChange={(e) => {
                setInput(e.target.value);
                // A pasted link or code is looked up at once.
                const pasted = normalizeInviteInput(e.target.value);
                if (pasted && pasted !== code) {
                  setError(null);
                  setCode(pasted);
                }
              }}
            />
            <button type="submit" className="btn btn-secondary" disabled={!input.trim()}>
              {t('guilds.join.find')}
            </button>
          </span>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {code && <InvitePreviewCard state={preview} onDone={closeGuildDialog} />}
        <div className="modal-actions modal-actions-split">
          <button type="button" className="btn btn-ghost" onClick={() => openGuildDialog({ kind: 'create' })}>
            {t('guilds.join.createInstead')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={closeGuildDialog}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
