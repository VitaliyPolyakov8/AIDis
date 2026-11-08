import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, TriangleAlert, X } from 'lucide-react';
import { desktop } from '../../desktop/bridge';
import {
  blocksTyping,
  DEFAULT_KEYBINDS,
  findConflict,
  formatBinding,
  HOTKEY_ACTIONS,
  hotkeyKind,
  keyFromCode,
  modifierKeyFromCode,
  keyFromMouseButton,
  validateBinding,
  type HotkeyAction,
  type HotkeyGroup,
} from '../../desktop/contract';
import { useDesktopStore } from '../../desktop/desktopStore';
import { displayBinding } from '../../desktop/keyLabels';

const GROUPS: HotkeyGroup[] = ['voice', 'streaming', 'overlay', 'application'];
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

function modifiersLabel(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean).join(' + ');
}

function KeybindRow({
  action,
  capturing,
  onCapture,
  onDone,
}: {
  action: HotkeyAction;
  capturing: boolean;
  onCapture: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const keybinds = useDesktopStore((s) => s.settings.keybinds);
  const failed = useDesktopStore((s) => s.hotkeyStatus.failed.includes(action));
  const update = useDesktopStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const binding = keybinds[action];
  const hold = hotkeyKind(action) === 'hold';

  useEffect(() => {
    if (!capturing) return;

    const commit = (next: string) => {
      const problem = validateBinding(action, next);
      if (problem) {
        setError(t(`desktop.keybinds.errors.${problem}`));
        onDone();
        return;
      }
      const conflict = findConflict(useDesktopStore.getState().settings.keybinds, action, next);
      if (conflict) {
        setError(t('desktop.keybinds.errors.conflictWith', { action: t(`desktop.keybinds.actions.${conflict}`) }));
        onDone();
        return;
      }
      void update({ keybinds: { [action]: next } }).then((result) => {
        if (!result.ok) {
          setError(
            result.error === 'conflict' && result.conflictWith
              ? t('desktop.keybinds.errors.conflictWith', { action: t(`desktop.keybinds.actions.${result.conflictWith}`) })
              : t(`desktop.keybinds.errors.${result.error}`),
          );
        }
      });
      onDone();
    };

    /** The one modifier held so far with nothing else pressed (code), 'mixed', or null. */
    let loneModifier: string | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        onDone();
        return;
      }
      if (MODIFIER_CODES.has(e.code)) {
        // 0.4.2: a modifier pressed and released on its own becomes the binding (Right Ctrl).
        if (!loneModifier) loneModifier = e.code;
        else loneModifier = 'mixed';
        setPreview(modifiersLabel(e));
        return;
      }
      loneModifier = 'mixed';
      const key = keyFromCode(e.code);
      if (!key) {
        setError(t('desktop.keybinds.errors.unsupportedKey'));
        onDone();
        return;
      }
      commit(formatBinding({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key }));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const single = loneModifier === e.code ? modifierKeyFromCode(e.code) : null;
      if (single) {
        commit(single);
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.shiftKey) loneModifier = null;
      setPreview(modifiersLabel(e));
    };
    const onMouseDown = (e: MouseEvent) => {
      const key = keyFromMouseButton(e.button);
      if (!key) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!hold) {
        setError(t('desktop.keybinds.errors.mouseNotAllowed'));
        onDone();
        return;
      }
      commit(key);
    };
    // Side buttons would otherwise act as "back"/"forward".
    const swallow = (e: MouseEvent) => {
      if (keyFromMouseButton(e.button)) e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('auxclick', swallow, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
    };
  }, [capturing, action, hold, onDone, t, update]);

  const label = capturing
    ? preview
      ? `${preview} + …`
      : t('desktop.keybinds.pressKeys')
    : binding
      ? displayBinding(binding)
      : t('desktop.keybinds.notSet');

  return (
    <div className="keybind-row">
      <div className="keybind-text">
        <span className="setting-row-title">{t(`desktop.keybinds.actions.${action}`)}</span>
        {hold && <span className="field-hint">{t('desktop.keybinds.pttHint')}</span>}
        {binding && !error && blocksTyping(action, binding) && <span className="field-hint">{t('desktop.keybinds.blocksTyping')}</span>}
        {failed && binding && !error && (
          <span className="keybind-error">
            <TriangleAlert size={13} aria-hidden="true" />
            {t('desktop.keybinds.errors.registerFailed')}
          </span>
        )}
        {error && (
          <span className="keybind-error" role="alert">
            <TriangleAlert size={13} aria-hidden="true" />
            {error}
          </span>
        )}
      </div>
      <div className="keybind-actions">
        <button
          type="button"
          className={`keybind-chip${capturing ? ' is-capturing' : ''}${binding ? '' : ' is-empty'}`}
          aria-label={t('desktop.keybinds.change', { action: t(`desktop.keybinds.actions.${action}`) })}
          onClick={() => {
            if (capturing) {
              onDone();
              return;
            }
            setError(null);
            setPreview('');
            onCapture();
          }}
        >
          {label}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t('desktop.keybinds.clear')}
          title={t('desktop.keybinds.clear')}
          disabled={!binding || capturing}
          onClick={() => {
            setError(null);
            void update({ keybinds: { [action]: null } });
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** Settings → Keybinds (desktop only). Global hotkeys work while AIDis is minimized or in the background. */
export function KeybindsSettings() {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);
  const pttAvailable = useDesktopStore((s) => s.hotkeyStatus.pttAvailable);
  const update = useDesktopStore((s) => s.update);

  // Pause the OS-level hotkeys while recording so the pressed combination reaches this page.
  useEffect(() => {
    desktop?.hotkeys.setCapturing(capturing !== null);
  }, [capturing]);
  useEffect(() => () => desktop?.hotkeys.setCapturing(false), []);

  const done = useCallback(() => setCapturing(null), []);

  return (
    <div className="settings-stack">
      <p className="field-hint">{t('desktop.keybinds.intro')}</p>
      {!pttAvailable && <p className="alert alert-warn">{t('desktop.keybinds.pttUnavailable')}</p>}
      {GROUPS.map((group) => (
        <div key={group} className="settings-card">
          <h4 className="settings-card-title">{t(`desktop.keybinds.groups.${group}`)}</h4>
          {HOTKEY_ACTIONS.filter((a) => a.group === group).map(({ id }) => (
            <KeybindRow key={id} action={id} capturing={capturing === id} onCapture={() => setCapturing(id)} onDone={done} />
          ))}
        </div>
      ))}
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setCapturing(null);
            void update({ keybinds: DEFAULT_KEYBINDS });
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          {t('desktop.keybinds.reset')}
        </button>
      </div>
    </div>
  );
}
