import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus } from 'lucide-react';
import { guildsApi, type MemberProfilePatch } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildStore, useMemberDisplay } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { Modal } from '../Modal';
import { Avatar } from '../Avatar';
import { checkImage, IMAGE_TYPES, uploadImage } from './imageUpload';
import { closeGuildDialog } from './guildDialogs';

export const BIO_MAX = 190;

/** 0.7.0: how I look on one server (nickname, avatar, banner, about me); empty = my global profile. */
export function ServerProfileDialog({ guildId }: { guildId: string }) {
  const { t } = useTranslation();
  const selfId = useAuthStore((s) => s.user?.id ?? '');
  const guild = useGuildStore((s) => s.guilds.find((g) => g.id === guildId));
  const profile = guild?.me.profile;
  const shown = useMemberDisplay(guildId, selfId);
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);
  const { url: bannerUrl } = useAttachmentUrl(shown.bannerAttachmentId);
  if (!guild || !profile) return null;
  const canNick = guild.me.permissions.includes('CHANGE_NICKNAME') || guild.me.permissions.includes('ADMINISTRATOR') || guild.ownerId === selfId;

  const save = async (patch: MemberProfilePatch, okText = t('profile.server.saved')) => {
    setBusy(true);
    setError(null);
    try {
      const { member } = await guildsApi.updateMyProfile(guildId, patch);
      const current = useGuildStore.getState().guilds.find((g) => g.id === guildId);
      if (current)
        useGuildStore
          .getState()
          .applyGuild({ ...current, me: { ...current.me, profile: { nickname: member.nickname, avatarAttachmentId: member.avatarAttachmentId, bannerAttachmentId: member.bannerAttachmentId, bio: member.bio } } });
      useGuildStore.getState().applyMember(guildId, member);
      toast.success(okText, 'server-profile');
    } catch (e) {
      setError(friendlyError(e, t('profile.server.failed')));
    } finally {
      setBusy(false);
    }
  };

  const pick = (field: 'avatarAttachmentId' | 'bannerAttachmentId') => (file: File | undefined) => {
    if (!file) return;
    const problem = checkImage(file);
    if (problem) {
      setError(t(problem === 'type' ? 'guilds.create.iconType' : 'guilds.create.iconSize'));
      return;
    }
    setBusy(true);
    uploadImage(file).then(
      (id) => void save({ [field]: id }),
      (e: unknown) => {
        setError(friendlyError(e, t('profile.server.failed')));
        setBusy(false);
      },
    );
  };

  const dirty = (nickname.trim() || null) !== profile.nickname || (bio.trim() || null) !== profile.bio;

  return (
    <Modal title={t('profile.server.title', { name: guild.name })} onClose={closeGuildDialog} size="sm">
      <form
        className="server-profile"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save({ ...(canNick ? { nickname: nickname.trim() || null } : {}), bio: bio.trim() || null });
        }}
      >
        <p className="field-hint">{t('profile.server.hint')}</p>
        <div className="server-profile-preview" style={bannerUrl ? { backgroundImage: `url("${bannerUrl}")` } : undefined}>
          <Avatar userId={selfId} name={shown.name} avatarAttachmentId={shown.avatarAttachmentId} size={64} />
          <strong>{shown.name}</strong>
        </div>
        <div className="gs-image-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => avatarRef.current?.click()}>
            <ImagePlus size={14} aria-hidden="true" /> {t('profile.server.avatar')}
          </button>
          {profile.avatarAttachmentId && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ avatarAttachmentId: null })}>
              {t('profile.server.avatarReset')}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => bannerRef.current?.click()}>
            <ImagePlus size={14} aria-hidden="true" /> {t('profile.server.banner')}
          </button>
          {profile.bannerAttachmentId && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ bannerAttachmentId: null })}>
              {t('profile.server.bannerReset')}
            </button>
          )}
          <input ref={avatarRef} type="file" hidden accept={IMAGE_TYPES.join(',')} onChange={(e) => pick('avatarAttachmentId')(e.target.files?.[0])} />
          <input ref={bannerRef} type="file" hidden accept={IMAGE_TYPES.join(',')} onChange={(e) => pick('bannerAttachmentId')(e.target.files?.[0])} />
        </div>
        <label className="field">
          <span className="field-label">{t('profile.server.nickname')}</span>
          <input className="input" data-autofocus value={nickname} maxLength={32} disabled={!canNick} placeholder={shown.name} onChange={(e) => setNickname(e.target.value)} />
          {!canNick && <span className="field-hint">{t('profile.server.noNickname')}</span>}
        </label>
        <label className="field">
          <span className="field-label">{t('profile.bio')}</span>
          <textarea className="input" rows={3} value={bio} maxLength={BIO_MAX} onChange={(e) => setBio(e.target.value)} placeholder={t('profile.server.bioPlaceholder')} />
          <span className="field-hint">
            {bio.length}/{BIO_MAX}
          </span>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions modal-actions-split">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setNickname('');
              setBio('');
              void save({ ...(canNick ? { nickname: null } : {}), avatarAttachmentId: null, bannerAttachmentId: null, bio: null }, t('profile.server.resetDone'));
            }}
          >
            {t('profile.server.reset')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
