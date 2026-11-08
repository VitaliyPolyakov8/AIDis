import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { Channel } from '../../api/types';
import { galleryApi, type GalleryCategory, type GalleryItem } from '../../api/gallery';
import { friendlyError } from '../../api/errors';
import { formatMessageTimestamp } from '../../utils/time';
import { Modal } from '../Modal';
import { AttachmentView } from './AttachmentView';
import './gallery.css';

const CATEGORIES: GalleryCategory[] = ['images', 'videos', 'documents', 'links'];

/** Shared entry point for text channels, DMs and voice-channel chat headers. */
export function ChannelGalleryButton({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const [openedChannel, setOpenedChannel] = useState<string | null>(null);
  return <>
    <button type="button" className="icon-btn" aria-label={t('gallery.title')} title={t('gallery.title')} onClick={() => setOpenedChannel(channel.id)}><FolderOpen size={18} /></button>
    {openedChannel === channel.id && <ChannelGallery key={channel.id} channel={channel} onClose={() => setOpenedChannel(null)} />}
  </>;
}

function ChannelGallery({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<GalleryCategory>('images');
  const id = useId();
  const tabKeys = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? CATEGORIES.length - 1 : e.key === 'ArrowRight' ? (index + 1) % CATEGORIES.length : e.key === 'ArrowLeft' ? (index + CATEGORIES.length - 1) % CATEGORIES.length : null;
    if (next === null) return;
    e.preventDefault();
    const value = CATEGORIES[next];
    if (value) setCategory(value);
    document.getElementById(`${id}-${value}`)?.focus();
  };
  return <Modal title={`${t('gallery.title')} · ${channel.name}`} size="lg" className="channel-gallery" onClose={() => {
    // The existing attachment lightbox handles its own Escape before the gallery closes.
    if (!document.querySelector('.lightbox')) onClose();
  }}>
    <div className="gallery-tabs" role="tablist" aria-label={t('gallery.title')}>
      {CATEGORIES.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={category === value} tabIndex={category === value ? 0 : -1} onKeyDown={(e) => tabKeys(e, index)} onClick={() => setCategory(value)}>{t(`gallery.${value}`)}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${category}`}>
      <GalleryResults key={category} channelId={channel.id} category={category} />
    </div>
  </Modal>;
}

function GalleryResults({ channelId, category }: { channelId: string; category: GalleryCategory }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    galleryApi.list(channelId, category, cursor, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setItems((old) => [...old, ...page.items]);
      setNextCursor(page.nextCursor);
      setError(null);
      setLoading(false);
    }, (e: unknown) => {
      if (controller.signal.aborted) return;
      setError({ cause: e });
      setLoading(false);
    });
    return () => controller.abort();
  }, [channelId, category, cursor, attempt]);
  return <div className="gallery-results" aria-busy={loading}>
    <div className="gallery-grid">
      {items.map((item) => <article className="gallery-card" key={item.id}>
        <div className="gallery-meta"><span>{item.authorName}</span><time dateTime={item.createdAt}>{formatMessageTimestamp(item.createdAt)}</time></div>
        {item.attachment && <AttachmentView attachment={item.attachment} />}
        {item.links?.map((href) => <a className="gallery-link" key={href} href={href} target="_blank" rel="noopener noreferrer nofollow">{href}</a>)}
      </article>)}
    </div>
    {loading && <span className="spinner" role="status" aria-label={t('common.loading')} />}
    {error && <div role="alert"><p>{friendlyError(error.cause, t('gallery.failed'))}</p><button type="button" className="btn btn-secondary" onClick={() => { setLoading(true); setError(null); setAttempt((n) => n + 1); }}>{t('gallery.retry')}</button></div>}
    {!loading && !error && items.length === 0 && !nextCursor && <p className="popover-empty">{t('gallery.empty')}</p>}
    {!error && nextCursor && <button type="button" className="btn btn-secondary gallery-more" disabled={loading} onClick={() => { setLoading(true); setCursor(nextCursor); }}>{t('gallery.more')}</button>}
  </div>;
}
