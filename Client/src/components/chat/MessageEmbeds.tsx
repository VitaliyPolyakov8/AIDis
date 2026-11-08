import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import type { Embed, GifEmbed, LinkEmbed } from '../../api/types';
import { apiUrl } from '../../config';
import { openImageMenu } from './imageMenu';

/** Cards and GIFs under a message. Everything shown is plain text from the server; no remote HTML. */
export function MessageEmbeds({ embeds }: { embeds: Embed[] }) {
  if (embeds.length === 0) return null;
  return <div className="message-embeds">{embeds.map((embed) => (embed.type === 'gif' ? <GifView key={`gif:${embed.provider}:${embed.id}`} gif={embed} /> : <LinkCard key={`link:${embed.url}`} embed={embed} />))}</div>;
}

/** Image URLs are paths of the AIDis image proxy (or already absolute for local previews). */
function src(path: string): string {
  return /^(https?:|blob:|data:)/.test(path) ? path : apiUrl(path);
}

const MAX_GIF = 300;

function fit(width: number | null, height: number | null, max: number): { width: number; height: number } {
  const w = width ?? max;
  const h = height ?? max;
  const scale = Math.min(1, max / w, max / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function GifView({ gif }: { gif: GifEmbed }) {
  const { t } = useTranslation();
  // Reduced motion: nothing animates until the user asks for it.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const size = fit(gif.media.width, gif.media.height, MAX_GIF);
  if (!playing) {
    return (
      <button type="button" className="embed-gif is-paused" style={size} aria-label={t('embeds.playGif')} onClick={() => setPlaying(true)}>
        <span className="embed-gif-badge">GIF</span>
        <Play size={26} aria-hidden="true" />
      </button>
    );
  }
  return (
    <a
      className="embed-gif"
      href={gif.url}
      target="_blank"
      rel="noopener noreferrer"
      title={gif.title ?? 'GIF'}
      style={size}
      onContextMenu={(e) => openImageMenu(e, { src: src(gif.media.url), link: gif.url, onOpen: () => window.open(gif.url, '_blank', 'noopener') })}
    >
      <img src={src(gif.media.url)} alt={gif.title ?? 'GIF'} width={size.width} height={size.height} loading="lazy" decoding="async" draggable={false} />
    </a>
  );
}

function LinkCard({ embed }: { embed: LinkEmbed }) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  const big = embed.provider === 'youtube' || embed.provider === 'steam';
  const image = embed.image && !imageFailed ? embed.image : null;
  return (
    <article className={`embed-card is-${embed.provider}${big ? ' has-big-image' : ''}`}>
      <div className="embed-card-body">
        {embed.siteName && <div className="embed-site">{embed.siteName}</div>}
        {embed.author && <div className="embed-author">{embed.author}</div>}
        {embed.title && (
          <a className="embed-title" href={embed.url} target="_blank" rel="noopener noreferrer">
            {embed.title}
          </a>
        )}
        {embed.description && <p className="embed-description">{embed.description}</p>}
        {embed.provider === 'steam' && (embed.free || embed.price) && <div className="embed-price">{embed.free ? t('embeds.free') : embed.price}</div>}
        {big && image && (
          <a
            className="embed-image-big"
            href={embed.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-hidden="true"
            tabIndex={-1}
            onContextMenu={(e) => openImageMenu(e, { src: src(image.url), link: new URL(src(image.url), window.location.href).href, onOpen: () => window.open(embed.url, '_blank', 'noopener') })}
          >
            <img src={src(image.url)} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
            {embed.provider === 'youtube' && (
              <span className="embed-play" aria-hidden="true">
                <Play size={22} fill="currentColor" />
              </span>
            )}
          </a>
        )}
      </div>
      {!big && image && (
        <a
          className="embed-thumb"
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-hidden="true"
          tabIndex={-1}
          onContextMenu={(e) => openImageMenu(e, { src: src(image.url), link: new URL(src(image.url), window.location.href).href, onOpen: () => window.open(embed.url, '_blank', 'noopener') })}
        >
          <img src={src(image.url)} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
        </a>
      )}
    </article>
  );
}
