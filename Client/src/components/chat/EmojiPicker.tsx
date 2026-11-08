import { useEffect, useMemo, useRef, useState } from 'react';
import { useGuildStore } from '../../stores/guildStore';
import { openGuildDialog } from '../guilds/guildDialogs';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { getLanguage } from '../../i18n';
import { EMOJI_GROUPS, loadEmoji, recentEmoji, rememberEmoji, searchEmoji, type Emoji } from './emoji';
import { useEmojiStore } from '../../emojis/store';
import { EmojiImage } from '../../emojis/EmojiImage';
import { useMyPermissions } from '../../stores/permsStore';

/** Compact emoji picker: search, recent, categories. Picking keeps the picker open (like Discord with Shift). */
export function EmojiPicker({ onPick, onClose, customMode = 'none' }: { onPick: (emoji: string) => void; onClose: () => void; customMode?: 'none' | 'message' | 'reaction' }) {
  const { t } = useTranslation();
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<number | 'recent' | 'server'>(() => (recentEmoji().length > 0 ? 'recent' : 0));
  const custom = useEmojiStore(s => s.emojis);
  const myPermissions = useMyPermissions();
  const canUpload = myPermissions.includes('CREATE_EMOJIS') || myPermissions.includes('MANAGE_EMOJIS');
  useEffect(() => { if (customMode !== 'none' && !useEmojiStore.getState().loaded) void useEmojiStore.getState().load(); }, [customMode]);
  const [recent, setRecent] = useState(recentEmoji);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    loadEmoji(getLanguage() === 'ru' ? 'ru' : 'en').then(
      (list) => {
        if (alive) setAll(list);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.composer-emoji')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const shown = useMemo(() => {
    if (!all) return [];
    if (group === 'server' && !query.trim()) return [];
    if (query.trim()) return searchEmoji(all, query);
    if (group === 'recent') return recent.map((u) => all.find((e) => e.unicode === u) ?? { unicode: u, label: u, tags: [], group: 0 });
    return all.filter((e) => e.group === group);
  }, [all, query, group, recent]);

  const pick = (emoji: Emoji) => {
    rememberEmoji(emoji.unicode);
    setRecent(recentEmoji());
    onPick(emoji.unicode);
  };

  return (
    <div ref={ref} className="emoji-picker" role="dialog" aria-label={t('emoji.title')}>
      <label className="emoji-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={query} placeholder={t('emoji.search')} aria-label={t('emoji.search')} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {!query.trim() && (
        <div className="emoji-tabs" role="tablist" aria-label={t('emoji.categories')}>
          {customMode !== 'none' && <button type="button" role="tab" aria-selected={group === 'server'} className={group === 'server' ? 'is-active' : ''} title={t('serverEmoji.server')} aria-label={t('serverEmoji.server')} onClick={() => setGroup('server')}>🏠</button>}
          {recent.length > 0 && (
            <button type="button" role="tab" aria-selected={group === 'recent'} className={group === 'recent' ? 'is-active' : ''} title={t('emoji.groups.recent')} aria-label={t('emoji.groups.recent')} onClick={() => setGroup('recent')}>
              🕘
            </button>
          )}
          {EMOJI_GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={group === g.id ? 'is-active' : ''} title={t(`emoji.groups.${g.key}`)} aria-label={t(`emoji.groups.${g.key}`)} onClick={() => setGroup(g.id)}>
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid" role="listbox" aria-label={query.trim() ? t('emoji.results') : t('emoji.title')}>
        {failed && <p className="emoji-empty">{t('emoji.loadFailed')}</p>}
        {!failed && !all && <p className="emoji-empty">{t('common.loading')}</p>}
        {all && shown.length === 0 && group !== 'server' && !(customMode !== 'none' && query.trim() && custom.some(e => e.name.includes(query.toLowerCase().normalize('NFC')))) && <p className="emoji-empty">{t('emoji.nothing')}</p>}
        {customMode !== 'none' && (group === 'server' || query.trim()) && custom.filter(e => !query.trim() || e.name.includes(query.toLowerCase().normalize('NFC'))).map(e => <button key={e.id} type="button" role="option" aria-selected={false} className="emoji-cell" title={`:${e.name}:`} aria-label={`:${e.name}:`} onClick={() => onPick(customMode === 'reaction' ? `custom:${e.id}` : `:${e.name}:`)}><EmojiImage id={e.id} name={e.name} /></button>)}
        {group === 'server' && custom.length === 0 && <p className="emoji-empty">{t('serverEmoji.empty')}</p>}
        {shown.map((e) => (
          <button key={e.unicode} type="button" role="option" aria-selected={false} className="emoji-cell" title={e.label} aria-label={e.label} onClick={() => pick(e)}>
            {e.unicode}
          </button>
        ))}
      </div>
      {customMode !== 'none' && canUpload && <div className="emoji-server-tools"><span>{t('serverEmoji.server')}</span><button type="button" className="link-btn" onClick={() => { onClose(); const guildId = useGuildStore.getState().activeGuildId; if (guildId) openGuildDialog({ kind: 'settings', guildId, section: 'emojis' }); }}>{t('serverEmoji.manage')}</button></div>}
    </div>
  );
}
