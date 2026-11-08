import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { gifFailure, gifsApi, type GifFailure, type GifProvider } from '../../api/gifs';
import type { GifResult } from '../../api/types';
import { apiUrl } from '../../config';

type Failure = GifFailure;
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; results: GifResult[]; nextPage: number | null; more: 'idle' | 'loading' | Failure }
  | { kind: 'disabled' }
  | { kind: 'error'; failure: Failure };

const PROVIDER_NAMES: Record<GifProvider, string> = { klipy: 'KLIPY', giphy: 'GIPHY', tenor: 'Tenor' };

const failureOf = gifFailure;

/** Proxied media is a server path; KLIPY media is KLIPY's own https URL, used exactly as returned. */
const imageSrc = (path: string) => (/^https:/.test(path) ? path : apiUrl(path));

/**
 * GIF browser: trending when empty, search as you type (debounced), "load more" when the provider
 * pages. Click sends the GIF. The server decides the provider; it is only used for attribution.
 */
export function GifPicker({ onPick, onClose }: { onPick: (gif: GifResult) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Remembered across searches so the placeholder stays right while results load.
  // KLIPY is known up front, so "Search KLIPY" shows even while loading or after an error.
  const [provider, setProvider] = useState<GifProvider | null>(() => gifsApi.clientProvider());
  const ref = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(
      () => {
        setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }));
        gifsApi.search(query).then(
          (res) => {
            if (id !== seq.current) return;
            setProvider(res.provider ?? gifsApi.clientProvider());
            setState(res.enabled ? { kind: 'ready', results: res.results, nextPage: res.nextPage ?? null, more: 'idle' } : { kind: 'disabled' });
          },
          (error: unknown) => {
            if (id === seq.current) setState({ kind: 'error', failure: failureOf(error) });
          },
        );
      },
      query ? 350 : 0,
    );
    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = () => {
    if (state.kind !== 'ready' || state.nextPage === null || state.more === 'loading') return;
    const id = seq.current;
    const page = state.nextPage;
    setState({ ...state, more: 'loading' });
    gifsApi.search(query, 24, page).then(
      (res) => {
        if (id !== seq.current) return;
        setState((s) => {
          if (s.kind !== 'ready') return s;
          // Appended exactly in the provider's order: nothing reordered, removed or inserted.
          return { kind: 'ready', results: [...s.results, ...res.results], nextPage: res.nextPage ?? null, more: 'idle' };
        });
      },
      (error: unknown) => {
        if (id === seq.current) setState((s) => (s.kind === 'ready' ? { ...s, more: failureOf(error) } : s));
      },
    );
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.composer-gif')) onClose();
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

  const pick = (gif: GifResult) => {
    onPick(gif);
    // Provider share analytics (KLIPY), straight from this app; failures never affect sending.
    gifsApi.registerShare(gif, query);
  };

  // KLIPY requires "Search KLIPY" as the search placeholder; other providers keep the usual one.
  const placeholder = provider === 'klipy' ? t('gif.searchKlipy') : t('gif.search');

  return (
    <div ref={ref} className="gif-picker" role="dialog" aria-label={t('gif.title')}>
      <label className="emoji-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={query} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="gif-grid" role="listbox" aria-label={query ? t('gif.results') : t('gif.trending')}>
        {state.kind === 'loading' && <p className="emoji-empty">{t('common.loading')}</p>}
        {state.kind === 'disabled' && <p className="emoji-empty">{t('gif.disabled')}</p>}
        {state.kind === 'error' && <p className="emoji-empty">{t(`gif.${state.failure}`)}</p>}
        {state.kind === 'ready' && state.results.length === 0 && <p className="emoji-empty">{t('gif.nothing')}</p>}
        {state.kind === 'ready' &&
          state.results.map((gif, index) => (
            <button key={`${index}:${gif.provider}:${gif.id}`} type="button" role="option" aria-selected={false} className="gif-cell" title={gif.title ?? 'GIF'} onClick={() => pick(gif)}>
              <img src={imageSrc(gif.previewProxy)} alt={gif.title ?? 'GIF'} loading="lazy" decoding="async" style={{ aspectRatio: `${gif.preview.width} / ${gif.preview.height}` }} />
            </button>
          ))}
      </div>
      {state.kind === 'ready' && state.nextPage !== null && (
        <button type="button" className="gif-more" disabled={state.more === 'loading'} onClick={loadMore}>
          {state.more === 'loading' ? t('common.loading') : state.more === 'idle' ? t('gif.more') : t(`gif.${state.more}`)}
        </button>
      )}
      {state.kind === 'ready' && provider && <div className="gif-attribution">{t('gif.poweredBy', { provider: PROVIDER_NAMES[provider] })}</div>}
    </div>
  );
}
