import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ImagePlus } from 'lucide-react';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { Modal } from '../Modal';
import { checkImage, IMAGE_TYPES, uploadImage } from './imageUpload';
import { enterGuild } from './enterGuild';
import { closeGuildDialog, openGuildDialog } from './guildDialogs';

/** 0.7.0: create a server (name, optional icon). */
export function CreateGuildDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const [name, setName] = useState(() => t('guilds.create.namePlaceholder', { name: me?.displayName ?? '' }).slice(0, 100));
  const [icon, setIcon] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const pick = (file: File | undefined) => {
    if (!file) return;
    const problem = checkImage(file);
    if (problem) {
      setError(t(problem === 'type' ? 'guilds.create.iconType' : 'guilds.create.iconSize'));
      return;
    }
    setError(null);
    setIcon(file);
    setPreview(URL.createObjectURL(file));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { guild } = await guildsApi.create(name.trim());
      let created = guild;
      if (icon) {
        // The server exists already: a failed icon upload is reported but does not undo it.
        try {
          const iconAttachmentId = await uploadImage(icon);
          const { guild: updated } = await guildsApi.update(guild.id, { iconAttachmentId });
          created = { ...guild, ...updated, me: guild.me };
        } catch (e) {
          toast.error(friendlyError(e, t('guilds.create.failed')), 'guild-icon');
        }
      }
      const path = await enterGuild(created);
      toast.success(t('guilds.create.created', { name: created.name }), 'guild-created');
      closeGuildDialog();
      void navigate(path);
    } catch (e) {
      setError(friendlyError(e, t('guilds.create.failed')));
      setBusy(false);
    }
  };

  return (
    <Modal title={t('guilds.create.title')} onClose={closeGuildDialog} size="sm">
      <form
        className="guild-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <p className="field-hint">{t('guilds.create.hint')}</p>
        <div className="guild-create-icon">
          <button type="button" className="guild-icon-pick" onClick={() => fileRef.current?.click()} aria-label={t('guilds.create.iconPick')}>
            {preview ? <img src={preview} alt="" /> : <ImagePlus size={26} aria-hidden="true" />}
          </button>
          <span className="guild-create-icon-actions">
            <span className="field-label">{t('guilds.create.icon')}</span>
            <span className="guild-create-icon-buttons">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
                {t('guilds.create.iconPick')}
              </button>
              {icon && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setIcon(null);
                    setPreview(null);
                  }}
                >
                  {t('guilds.create.iconRemove')}
                </button>
              )}
            </span>
          </span>
          <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        <label className="field">
          <span className="field-label">{t('guilds.create.name')}</span>
          <input className="input" data-autofocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions modal-actions-split">
          <button type="button" className="btn btn-ghost" onClick={() => openGuildDialog({ kind: 'join' })}>
            {t('guilds.create.haveInvite')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {t('guilds.create.submit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
