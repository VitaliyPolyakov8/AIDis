import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crown, ImagePlus, Trash } from 'lucide-react';
import type { NotifyMode } from '../../api/types';
import { guildsApi, type GuildPatch } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildChannels, useGuildMembers, useGuildStore } from '../../stores/guildStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { ConfirmDialog } from '../ConfirmDialog';
import { GuildIcon } from '../guilds/GuildIcon';
import { checkImage, IMAGE_TYPES, uploadImage } from '../guilds/imageUpload';
import { homePath } from '../guilds/routes';
import { closeGuildDialog } from '../guilds/guildDialogs';
import type { GuildContext } from './context';

const NOTIFY_MODES: NotifyMode[] = ['ALL', 'MENTIONS', 'NONE'];

function ImageField({ label, attachmentId, onPick, onRemove, busy, wide }: { label: string; attachmentId: string | null; onPick: (file: File) => void; onRemove: () => void; busy: boolean; wide?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const { url } = useAttachmentUrl(attachmentId);
  return (
    <div className="gs-image-field">
      <span className="field-label">{label}</span>
      <button type="button" className={`gs-image-pick${wide ? ' is-wide' : ''}`} disabled={busy} onClick={() => ref.current?.click()} aria-label={`${label}: ${t('gs.overview.upload')}`}>
        {url ? <img src={url} alt="" /> : <ImagePlus size={22} aria-hidden="true" />}
      </button>
      <span className="gs-image-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => ref.current?.click()}>
          {t('gs.overview.upload')}
        </button>
        {attachmentId && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRemove}>
            {t('gs.overview.remove')}
          </button>
        )}
      </span>
      <input
        ref={ref}
        type="file"
        hidden
        accept={IMAGE_TYPES.join(',')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onPick(file);
        }}
      />
    </div>
  );
}

function DangerZone({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { guild } = ctx;
  const members = useGuildMembers(guild.id);
  const users = usePresenceStore((s) => s.users);
  const [heir, setHeir] = useState('');
  const [confirm, setConfirm] = useState<'transfer' | 'delete' | null>(null);
  const [typed, setTyped] = useState('');
  const candidates = useMemo(
    () =>
      members
        .filter((m) => m.userId !== guild.ownerId)
        .map((m) => ({ id: m.userId, name: m.nickname ?? users[m.userId]?.displayName ?? m.userId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members, users, guild.ownerId],
  );
  const heirName = candidates.find((c) => c.id === heir)?.name ?? '';
  return (
    <section className="gs-danger">
      <h4 className="gs-subtitle">{t('gs.overview.danger')}</h4>
      <div className="gs-danger-row">
        <span>
          <strong>{t('gs.overview.transfer')}</strong>
          <span className="field-hint">{t('gs.overview.transferHint')}</span>
        </span>
        <span className="input-row">
          <select className="input" value={heir} onChange={(e) => setHeir(e.target.value)} aria-label={t('gs.overview.transferPick')}>
            <option value="">{t('gs.overview.transferPick')}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary" disabled={!heir} onClick={() => setConfirm('transfer')}>
            <Crown size={15} aria-hidden="true" /> {t('gs.overview.transfer')}
          </button>
        </span>
      </div>
      <div className="gs-danger-row">
        <span>
          <strong>{t('gs.overview.delete')}</strong>
          <span className="field-hint">{t('gs.overview.deleteHint')}</span>
        </span>
        <button type="button" className="btn btn-danger" onClick={() => setConfirm('delete')}>
          <Trash size={15} aria-hidden="true" /> {t('gs.overview.delete')}
        </button>
      </div>
      {confirm === 'transfer' && (
        <ConfirmDialog
          title={t('gs.overview.transferTitle', { name: guild.name, user: heirName })}
          confirmLabel={t('gs.overview.transfer')}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              const { guild: updated } = await guildsApi.transfer(guild.id, heir);
              useGuildStore.getState().applyGuild(updated);
              await useGuildStore.getState().refreshMe(guild.id);
              toast.success(t('gs.overview.transferred'), 'guild-transfer');
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.overview.failed')), { cause: e });
            }
          }}
        >
          <p>{t('gs.overview.transferBody')}</p>
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={t('gs.overview.deleteTitle', { name: guild.name })}
          confirmLabel={t('gs.overview.delete')}
          confirmDisabled={typed !== guild.name}
          onClose={() => {
            setConfirm(null);
            setTyped('');
          }}
          onConfirm={async () => {
            try {
              await guildsApi.remove(guild.id, typed);
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.overview.failed')), { cause: e });
            }
            useGuildStore.getState().removeGuild(guild.id);
            toast.info(t('gs.overview.deleted'), 'guild-deleted');
            closeGuildDialog();
            void navigate(homePath());
          }}
        >
          <p>{t('gs.overview.deleteHint')}</p>
          <label className="field">
            <span className="field-label">{t('gs.overview.deleteType')}</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={guild.name} data-autofocus />
          </label>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Name, icon, banner, system channel, default notifications; transfer and delete for the owner. */
export function OverviewSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const { guild } = ctx;
  const channels = useGuildChannels(guild.id);
  const textChannels = useMemo(() => channels.filter((c) => c.type === 'TEXT').sort((a, b) => a.position - b.position), [channels]);
  const [name, setName] = useState(guild.name);
  const [systemChannelId, setSystemChannelId] = useState(guild.systemChannelId);
  const [defaultNotifyMode, setDefaultNotifyMode] = useState<NotifyMode>(guild.defaultNotifyMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = ctx.has('MANAGE_GUILD');

  const save = async (patch: GuildPatch, quiet = false) => {
    setBusy(true);
    setError(null);
    try {
      const { guild: updated } = await guildsApi.update(guild.id, patch);
      useGuildStore.getState().applyGuild(updated);
      if (!quiet) toast.success(t('gs.overview.saved'), 'guild-save');
    } catch (e) {
      setError(friendlyError(e, t('gs.overview.failed')));
    } finally {
      setBusy(false);
    }
  };

  const image = (field: 'iconAttachmentId' | 'bannerAttachmentId') => ({
    onPick: (file: File) => {
      const problem = checkImage(file);
      if (problem) {
        setError(t(problem === 'type' ? 'guilds.create.iconType' : 'guilds.create.iconSize'));
        return;
      }
      setBusy(true);
      uploadImage(file).then(
        (id) => void save({ [field]: id }),
        (e: unknown) => {
          setError(friendlyError(e, t('gs.overview.failed')));
          setBusy(false);
        },
      );
    },
    onRemove: () => void save({ [field]: null }),
  });

  const dirty = name.trim() !== guild.name || systemChannelId !== guild.systemChannelId || defaultNotifyMode !== guild.defaultNotifyMode;

  return (
    <div className="gs-section">
      {canEdit ? (
        <form
          className="gs-overview"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && name.trim()) void save({ name: name.trim(), systemChannelId, defaultNotifyMode });
          }}
        >
          <div className="gs-overview-head">
            <span className="gs-overview-icon">
              <GuildIcon name={guild.name} iconAttachmentId={guild.iconAttachmentId} size={80} />
            </span>
            <ImageField label={t('gs.overview.icon')} attachmentId={guild.iconAttachmentId} busy={busy} {...image('iconAttachmentId')} />
            <ImageField label={t('gs.overview.banner')} attachmentId={guild.bannerAttachmentId} busy={busy} wide {...image('bannerAttachmentId')} />
          </div>
          <label className="field">
            <span className="field-label">{t('gs.overview.name')}</span>
            <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('gs.overview.systemChannel')}</span>
            <select className="input" value={systemChannelId ?? ''} onChange={(e) => setSystemChannelId(e.target.value || null)}>
              <option value="">{t('gs.overview.none')}</option>
              {textChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <span className="field-hint">{t('gs.overview.systemChannelHint')}</span>
          </label>
          <label className="field">
            <span className="field-label">{t('gs.overview.defaultNotify')}</span>
            <select className="input" value={defaultNotifyMode} onChange={(e) => setDefaultNotifyMode(e.target.value as NotifyMode)}>
              {NOTIFY_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`notify.${m}`)}
                </option>
              ))}
            </select>
            <span className="field-hint">{t('gs.overview.defaultNotifyHint')}</span>
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty || !name.trim()}>
              {t('gs.overview.save')}
            </button>
          </div>
        </form>
      ) : (
        <p className="field-hint">{t('gs.noAccess')}</p>
      )}
      {(ctx.owner || ctx.superadmin) && <DangerZone ctx={ctx} />}
    </div>
  );
}
