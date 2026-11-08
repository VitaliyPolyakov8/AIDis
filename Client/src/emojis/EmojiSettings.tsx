import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Trash, Upload, X } from 'lucide-react';
import { useEmojiStore } from './store';
import { emojisApi } from './api';
import { EmojiImage } from './EmojiImage';
import { useGuildStore } from '../stores/guildStore';
import type { Permission } from '../api/types';

const NO_PERMISSIONS: Permission[] = [];
import { useAuthStore } from '../stores/authStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { friendlyError, isApiError } from '../api/errors';
import type { ServerEmoji } from '../api/types';

/** 0.7.0: the emojis of one server (upload, rename, delete by that server's permissions). */
export function EmojiSettings({ guildId }: { guildId: string }) {
  const { t } = useTranslation();
  const all = useEmojiStore(s => s.emojis);
  const catalog = useMemo(() => all.filter((e) => e.guildId === guildId), [all, guildId]);
  const loaded = useEmojiStore(s => s.loaded);
  const loadError = useEmojiStore(s => s.error);
  const permissions = useGuildStore((s) => s.guilds.find((g) => g.id === guildId)?.me.permissions ?? NO_PERMISSIONS);
  const user = useAuthStore(s => s.user);
  const manage = user?.role === 'ADMIN' || permissions.includes('MANAGE_EMOJIS');
  const create = manage || permissions.includes('CREATE_EMOJIS');
  const [name, setName] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<ServerEmoji | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void useEmojiStore.getState().load(); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const problem = (value: unknown) => {
    if (isApiError(value)) {
      const keys: Record<string, string> = { EMOJI_NAME_INVALID: 'nameHint', EMOJI_NAME_TAKEN: 'nameTaken', EMOJI_FORMAT: 'format', EMOJI_DIMENSIONS: 'dimensions', EMOJI_LIMIT: 'limit', EMOJI_BUSY: 'busy', PAYLOAD_TOO_LARGE: 'size', FORBIDDEN: 'forbidden' };
      const key = keys[value.code]; if (key) return t(`serverEmoji.${key}`);
    }
    return friendlyError(value, t('serverEmoji.failed'));
  };
  const chooseFile = (next: File | undefined) => {
    setError(null); setPreview(null);
    if (!next) { setFile(null); return; }
    if (next.size > 512 * 1024) { setError(t('serverEmoji.size')); setFile(null); return; }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(next.type)) { setError(t('serverEmoji.format')); setFile(null); return; }
    setFile(next); setPreview(URL.createObjectURL(next));
    if (!name) setName(next.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 32));
  };
  const upload = async () => {
    if (!file || busy || !create) return;
    setBusy(true); setError(null);
    try {
      await emojisApi.create(guildId, name, file); await useEmojiStore.getState().load();
      setName(''); setFile(null); setPreview(null); if (input.current) input.current.value = '';
    } catch (e) { setError(problem(e)); } finally { setBusy(false); }
  };
  const rename = async (id: string) => {
    setBusy(true); setError(null);
    try { await emojisApi.rename(id, editName); await useEmojiStore.getState().load(); setEditing(null); }
    catch (e) { setError(problem(e)); } finally { setBusy(false); }
  };
  const canEdit = (emoji: ServerEmoji) => manage || (create && emoji.createdById === user?.id);
  return <div className="server-emojis-settings">
    <p className="field-hint">{t('serverEmoji.description')}</p>
    <div className="server-emoji-counter">{t('serverEmoji.count', { count: catalog.length, max: 100 })}</div>
    {create ? <form className="server-emoji-upload" onSubmit={e => { e.preventDefault(); void upload(); }}>
      <label>{t('serverEmoji.file')}<input ref={input} aria-label={t('serverEmoji.file')} type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={e => chooseFile(e.target.files?.[0])} /></label>
      <label>{t('serverEmoji.name')}<input className="input" aria-label={t('serverEmoji.name')} maxLength={32} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="party_cat" /></label>
      <span className="field-hint">{t('serverEmoji.nameHint')} {t('serverEmoji.size')} {t('serverEmoji.dimensions')}</span>
      {file && preview && <div className="server-emoji-preview"><img src={preview} alt={t('serverEmoji.preview')} /><span>:{name}:</span></div>}
      <button type="submit" className="btn btn-secondary" disabled={busy || !file || !/^[\p{L}\p{N}_]{2,32}$/u.test(name.normalize('NFC')) || catalog.length >= 100}><Upload size={15} />{t('serverEmoji.upload')}</button>
    </form> : <p className="field-hint">{t('serverEmoji.noUpload')}</p>}
    {error && <p className="alert alert-error" role="alert">{error}</p>}
    {loadError !== null && <p className="field-error" role="status">{t('serverEmoji.loadFailed')} <button type="button" className="link-btn" onClick={() => void useEmojiStore.getState().load()}>{t('common.retry')}</button></p>}
    {!loaded && <span role="status">{t('common.loading')}</span>}
    {loaded && catalog.length === 0 && <p className="field-hint">{t('serverEmoji.empty')}</p>}
    <div className="server-emoji-list">{catalog.map(emoji => <div className="server-emoji-row" key={emoji.id}>
      <span><EmojiImage id={emoji.id} name={emoji.name} /></span>
      {editing === emoji.id && canEdit(emoji) ? <>
        <input className="input" aria-label={t('serverEmoji.name')} maxLength={32} value={editName} disabled={busy} onChange={e => setEditName(e.target.value)} />
        <button type="button" className="icon-btn" disabled={busy} aria-label={t('common.save')} onClick={() => void rename(emoji.id)}><Check size={16} /></button>
        <button type="button" className="icon-btn" disabled={busy} aria-label={t('common.cancel')} onClick={() => setEditing(null)}><X size={16} /></button>
      </> : <><span className="server-emoji-name">:{emoji.name}:</span>{canEdit(emoji) && <>
        <button type="button" className="icon-btn" disabled={busy} aria-label={t('serverEmoji.rename', { name: emoji.name })} onClick={() => { setEditing(emoji.id); setEditName(emoji.name); }}><Pencil size={15} /></button>
        <button type="button" className="icon-btn" disabled={busy} aria-label={t('serverEmoji.delete', { name: emoji.name })} onClick={() => setDeleting(emoji)}><Trash size={15} /></button>
      </>}</>}
    </div>)}</div>
    {deleting && <ConfirmDialog title={t('serverEmoji.delete', { name: deleting.name })} confirmLabel={t('common.delete')} onClose={() => setDeleting(null)} onConfirm={async () => {
      try { await emojisApi.remove(deleting.id); await useEmojiStore.getState().load(); }
      catch (e) { throw new Error(problem(e), { cause: e }); }
    }}><p>{t('serverEmoji.deleteHint')}</p></ConfirmDialog>}
  </div>;
}
