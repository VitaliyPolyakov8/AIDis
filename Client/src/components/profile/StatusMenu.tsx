import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Settings, X } from 'lucide-react';
import type { StatusPreference } from '../../api/types';
import { friendlyError } from '../../api/errors';
import { useStatusStore } from '../../stores/statusStore';
import { toast, useUiStore } from '../../stores/uiStore';
import { customStatusExpiresAt, type CustomStatusExpiry } from '../../utils/presence';
import { usePopover } from './usePopover';

const STATUSES: { id: StatusPreference; dot: string }[] = [
  { id: 'ONLINE', dot: 'online' },
  { id: 'AWAY', dot: 'away' },
  { id: 'DND', dot: 'dnd' },
  { id: 'INVISIBLE', dot: 'invisible' },
];
const EXPIRY: CustomStatusExpiry[] = ['never', '1h', '4h', 'today'];
/** 0.4.0 status emoji presets (kept small; any single emoji is accepted by the server). */
const STATUS_EMOJI = ['🎮', '☕', '💼', '🎧', '🍕', '😴', '📺', '🏃', '🔥', '🤒'];

/** Status picker opened from the user panel: Online / Away / DND / Invisible + custom status. */
export function StatusMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const { t } = useTranslation();
  const status = useStatusStore((s) => s.status);
  const custom = useStatusStore((s) => s.customStatus);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(custom?.text ?? '');
  const [emoji, setEmoji] = useState<string | null>(custom?.emoji ?? null);
  const [expiry, setExpiry] = useState<CustomStatusExpiry>('never');
  const [busy, setBusy] = useState(false);
  const { ref, style } = usePopover(x, y, onClose, true);

  const pick = async (next: StatusPreference) => {
    try {
      await useStatusStore.getState().setStatus(next);
      onClose();
    } catch (error) {
      toast.error(friendlyError(error, t('status.saveFailed')), 'status');
    }
  };

  const saveCustom = async (value: { text: string; expiresAt: string | null; emoji?: string | null } | null) => {
    setBusy(true);
    try {
      await useStatusStore.getState().setCustomStatus(value);
      setEditing(false);
      if (!value) setText('');
    } catch (error) {
      toast.error(friendlyError(error, t('status.saveFailed')), 'status');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div ref={ref} className="context-menu status-menu" role="menu" aria-label={t('status.title')} style={style}>
      <div className="context-menu-title">{t('status.title')}</div>
      {STATUSES.map(({ id, dot }) => (
        <button
          key={id}
          type="button"
          role="menuitemradio"
          aria-checked={status === id}
          className={`context-menu-item status-option${status === id ? ' is-active' : ''}`}
          onClick={() => void pick(id)}
        >
          <span className={`presence-dot is-${dot} status-option-dot`} aria-hidden="true" />
          <span className="status-option-text">
            <span>{t(`status.pref.${id}`)}</span>
            {(id === 'DND' || id === 'INVISIBLE' || id === 'AWAY') && <span className="status-option-hint">{t(`status.hint.${id}`)}</span>}
          </span>
          {status === id && <Check size={15} aria-hidden="true" />}
        </button>
      ))}
      <div className="context-menu-separator" role="separator" />
      {editing ? (
        <form
          className="status-custom-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = text.trim();
            if (value) void saveCustom({ text: value.slice(0, 128), expiresAt: customStatusExpiresAt(expiry), emoji });
          }}
        >
          <input
            className="input"
            value={text}
            maxLength={128}
            autoFocus
            placeholder={t('status.customPlaceholder')}
            aria-label={t('status.custom')}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="status-emoji-row" role="radiogroup" aria-label={t('status.emoji')}>
            {STATUS_EMOJI.map((e) => (
              <button key={e} type="button" role="radio" aria-checked={emoji === e} className={`status-emoji${emoji === e ? ' is-active' : ''}`} onClick={() => setEmoji(emoji === e ? null : e)}>
                {e}
              </button>
            ))}
          </div>
          <label className="status-custom-expiry">
            <span>{t('status.clearAfter')}</span>
            <select className="select" value={expiry} onChange={(e) => setExpiry(e.target.value as CustomStatusExpiry)}>
              {EXPIRY.map((option) => (
                <option key={option} value={option}>
                  {t(`status.expiry.${option}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="status-custom-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
              {t('common.save')}
            </button>
          </div>
        </form>
      ) : custom ? (
        <div className="status-custom-current">
          <span className="status-custom-text" title={custom.text}>
            {custom.emoji && <span className="custom-emoji">{custom.emoji}</span>}
            {custom.text}
          </span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('status.editCustom')} title={t('status.editCustom')} onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('status.clearCustom')} title={t('status.clearCustom')} disabled={busy} onClick={() => void saveCustom(null)}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <button type="button" role="menuitem" className="context-menu-item" onClick={() => setEditing(true)}>
          <Pencil size={15} aria-hidden="true" />
          {t('status.setCustom')}
        </button>
      )}
      <div className="context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          onClose();
          useUiStore.getState().openSettings('account');
        }}
      >
        <Settings size={15} aria-hidden="true" />
        {t('status.profileSettings')}
      </button>
    </div>,
    document.body,
  );
}
