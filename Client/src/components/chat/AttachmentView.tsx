import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react';
import { copyChatImage, openImageMenu } from './imageMenu';
import { apiUrl } from '../../config';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, FileArchive, FileAudio, FileText, FileVideo, ImageOff, Minus, Play, Plus, X, RotateCcw } from 'lucide-react';
import type { Attachment } from '../../api/types';
import { downloadAttachment } from '../../api/attachments';
import { friendlyError } from '../../api/errors';
import { useAttachmentStreamUrl, useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { formatBytes, isPreviewableImage } from '../../utils/format';
import { toast } from '../../stores/uiStore';
import { VoiceTranscript } from '../../voice-messages/VoiceTranscript';
import '../../voice-messages/voice-messages.css';

/** Inline players only for formats Chromium plays natively (never anything executable). */
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/flac']);
const ARCHIVE = /zip|rar|7z|tar|gzip|x-bzip/;

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export function attachmentKind(a: Pick<Attachment, 'mimeType'>): AttachmentKind {
  if (isPreviewableImage(a.mimeType)) return 'image';
  if (VIDEO_TYPES.has(a.mimeType)) return 'video';
  if (AUDIO_TYPES.has(a.mimeType)) return 'audio';
  return 'file';
}

function download(attachment: Attachment, failText: string) {
  return downloadAttachment(attachment).catch((e: unknown) => toast.error(friendlyError(e, failText)));
}

function fileTypeLabel(a: Attachment): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(a.originalName)?.[1];
  return (ext ?? a.mimeType.split('/')[1] ?? 'file').toUpperCase();
}

function FileCard({ attachment }: { attachment: Attachment }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const Icon = ARCHIVE.test(attachment.mimeType) || /\.(zip|rar|7z|tar|gz)$/i.test(attachment.originalName) ? FileArchive : FileText;
  return (
    <div className="file-card">
      <Icon size={28} className="file-card-icon" aria-hidden="true" />
      <div className="file-card-text">
        <span className="file-card-name" title={attachment.originalName}>
          {attachment.originalName}
        </span>
        <span className="file-card-size">
          {fileTypeLabel(attachment)} · {formatBytes(attachment.size)}
        </span>
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('attachments.downloadFile', { name: attachment.originalName })}
        title={t('common.download')}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void download(attachment, t('attachments.downloadFailed')).finally(() => setBusy(false));
        }}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <Download size={18} />}
      </button>
    </div>
  );
}

/**
 * Video / audio: a light card first; playback starts when the user presses play. 0.5.5: the file is
 * streamed with a signed link (Range requests: instant start and seeking, even for gigabytes)
 * instead of being downloaded into memory first.
 */
function MediaCard({ attachment, kind }: { attachment: Attachment; kind: 'video' | 'audio' }) {
  const { t } = useTranslation();
  const [started, setStarted] = useState(false);
  const { url, failed } = useAttachmentStreamUrl(started ? attachment.id : null);
  const Icon = kind === 'video' ? FileVideo : FileAudio;
  if (started && url) {
    return kind === 'video' ? (
      <div className="media-player is-video">
        {/* Never autoplays with sound: starts muted, the user unmutes. */}
        <video src={url} controls autoPlay muted playsInline preload="metadata" />
        <div className="media-player-name">{attachment.originalName}</div>
      </div>
    ) : (
      <div className="media-player is-audio">
        <FileAudio size={22} aria-hidden="true" />
        <div className="media-player-body">
          <span className="media-player-name">{attachment.originalName}</span>
          <audio src={url} controls autoPlay preload="metadata" />
        </div>
      </div>
    );
  }
  return (
    <div className={`file-card media-card is-${kind}`}>
      <button type="button" className="media-play" aria-label={t('attachments.play', { name: attachment.originalName })} disabled={started && !failed} onClick={() => setStarted(true)}>
        {started && !failed ? <span className="spinner" aria-hidden="true" /> : <Play size={18} />}
      </button>
      <div className="file-card-text">
        <span className="file-card-name" title={attachment.originalName}>
          <Icon size={14} aria-hidden="true" /> {attachment.originalName}
        </span>
        <span className="file-card-size">{failed ? t('attachments.mediaUnavailable') : `${fileTypeLabel(attachment)} · ${formatBytes(attachment.size)}`}</span>
      </div>
      <button type="button" className="icon-btn" aria-label={t('attachments.downloadFile', { name: attachment.originalName })} title={t('common.download')} onClick={() => void download(attachment, t('attachments.downloadFailed'))}>
        <Download size={18} />
      </button>
    </div>
  );
}

/** 0.5.0: the attachment's server URL (for "Copy image link"; opening it needs the AIDis login). */
function attachmentLink(attachment: Attachment): string {
  return new URL(apiUrl(`/api/v1/attachments/${attachment.id}/content`), window.location.href).href;
}

function Thumb({ attachment, onOpen, single }: { attachment: Attachment; onOpen: () => void; single: boolean }) {
  const { t } = useTranslation();
  const { url, failed } = useAttachmentUrl(attachment.id);
  if (failed) {
    return (
      <div className="image-attachment is-failed">
        <ImageOff size={20} aria-hidden="true" />
        <span>{t('attachments.imageUnavailable')}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`image-attachment${single ? '' : ' is-tile'}`}
      onClick={() => url && onOpen()}
      onContextMenu={(e) => {
        if (!url) return;
        openImageMenu(e, { src: url, link: attachmentLink(attachment), onOpen, onSave: () => void download(attachment, t('attachments.downloadFailed')) });
      }}
      aria-label={t('attachments.openImage', { name: attachment.originalName })}
      disabled={!url}
    >
      {url ? <img src={url} alt={attachment.originalName} loading="lazy" draggable={false} /> : <span className="image-placeholder" />}
    </button>
  );
}

export interface PanState {
  zoom: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

/**
 * 0.4.2: keeps a zoomed image inside the viewer. `base` = the image's size at 100 % (as laid out),
 * `view` = the stage. Along an axis where the scaled image fits it is centered; otherwise it can be
 * moved until its edge reaches the stage edge, never further. Pure (unit-tested).
 */
export function clampPan(state: PanState, base: { width: number; height: number }, view: { width: number; height: number }): PanState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom));
  const maxX = Math.max(0, (base.width * zoom - view.width) / 2);
  const maxY = Math.max(0, (base.height * zoom - view.height) / 2);
  const clamp = (v: number, max: number) => (max === 0 ? 0 : Math.min(max, Math.max(-max, v)));
  return { zoom, x: clamp(state.x, maxX), y: clamp(state.y, maxY) };
}

/** Zoom to `zoom` keeping the point under (cx, cy) (relative to the stage center) in place. */
export function zoomAt(state: PanState, zoom: number, cx: number, cy: number): PanState {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const k = next / state.zoom;
  return { zoom: next, x: cx - (cx - state.x) * k, y: cy - (cy - state.y) * k };
}

const RESET: PanState = { zoom: 1, x: 0, y: 0 };

/**
 * Fullscreen viewer: previous / next (arrows), zoom (wheel toward the cursor, +/-), drag to pan
 * while zoomed (0.4.2), double-click / reset button / "0" to reset, download, Esc to close.
 */
function Lightbox({ images, index, onIndex, onClose }: { images: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const current = images[index];
  const { url } = useAttachmentUrl(current?.id ?? null);
  const urlRef = useRef<string | null>(null);
  const currentRef = useRef<Attachment | null>(null);
  useEffect(() => {
    urlRef.current = url;
    currentRef.current = current ?? null;
  });
  const [pan, setPanState] = useState<PanState>(RESET);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /** Applies a new pan state, clamped to the current layout (100 % or less is always centered). */
  const setPan = useCallback((update: (p: PanState) => PanState) => {
    setPanState((p) => {
      const next = update(p);
      if (next.zoom <= 1) return { zoom: Math.max(MIN_ZOOM, next.zoom), x: 0, y: 0 };
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return next;
      return clampPan(next, { width: img.offsetWidth, height: img.offsetHeight }, { width: stage.clientWidth, height: stage.clientHeight });
    });
  }, []);
  const zoomBy = useCallback((delta: number) => setPan((p) => ({ ...p, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, p.zoom + delta)) })), [setPan]);
  const reset = useCallback(() => setPanState(RESET), []);

  const go = useCallback((delta: number) => {
    setPanState(RESET);
    onIndex((index + delta + images.length) % images.length);
  }, [index, images.length, onIndex]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === '+' || e.key === '=') zoomBy(0.25);
      else if (e.key === '-') zoomBy(-0.25);
      else if (e.key === '0') reset();
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString() && urlRef.current && currentRef.current) {
        // 0.5.0: Ctrl+C in the image viewer copies the picture (text selections keep normal copy).
        e.preventDefault();
        const att = currentRef.current;
        void copyChatImage({ src: urlRef.current, link: attachmentLink(att) });
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [go, onClose, zoomBy, reset]);

  // The window was resized: keep the picture inside the new stage.
  useEffect(() => {
    const onResize = () => setPan((p) => p);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setPan]);

  if (!current) return null;
  /** Cursor position relative to the stage center. */
  const fromCenter = (clientX: number, clientY: number) => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { cx: clientX - (r.left + r.width / 2), cy: clientY - (r.top + r.height / 2) } : { cx: 0, cy: 0 };
  };
  const onWheel = (e: WheelEvent) => {
    const { cx, cy } = fromCenter(e.clientX, e.clientY);
    setPan((p) => zoomAt(p, p.zoom + (e.deltaY < 0 ? 0.15 : -0.15), cx, cy));
  };
  const zoomed = pan.zoom > 1;
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={current.originalName} onClick={onClose}>
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">
          {current.originalName} · {formatBytes(current.size)}
          {images.length > 1 && <span className="lightbox-count"> {index + 1} / {images.length}</span>}
        </span>
        <button type="button" className="icon-btn" aria-label={t('attachments.zoomOut')} onClick={() => zoomBy(-0.25)}>
          <Minus size={18} />
        </button>
        <span className="lightbox-zoom">{Math.round(pan.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label={t('attachments.zoomIn')} onClick={() => zoomBy(0.25)}>
          <Plus size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('attachments.zoomReset')}
          title={t('attachments.zoomReset')}
          disabled={pan.zoom === 1 && pan.x === 0 && pan.y === 0}
          onClick={reset}
        >
          <RotateCcw size={17} />
        </button>
        <button type="button" className="icon-btn" aria-label={t('common.download')} title={t('common.download')} onClick={() => void download(current, t('attachments.downloadFailed'))}>
          <Download size={18} />
        </button>
        <button ref={closeRef} type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="lightbox-stage" ref={stageRef} onWheel={onWheel}>
        {url ? (
          <img
            ref={imgRef}
            src={url}
            alt={current.originalName}
            className={`${zoomed ? 'is-zoomed' : ''}${dragging ? ' is-dragging' : ''}`}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.zoom})` }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => openImageMenu(e, { src: url, link: attachmentLink(current), onSave: () => void download(current, t('attachments.downloadFailed')) })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const { cx, cy } = fromCenter(e.clientX, e.clientY);
              if (pan.zoom === 1) setPan((p) => zoomAt(p, 2, cx, cy));
              else reset();
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !zoomed) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: pan.x, y: pan.y };
              setDragging(true);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d?.id !== e.pointerId) return;
              setPan((p) => ({ ...p, x: d.x + e.clientX - d.startX, y: d.y + e.clientY - d.startY }));
            }}
            onPointerUp={(e) => {
              if (drag.current?.id !== e.pointerId) return;
              drag.current = null;
              setDragging(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            draggable={false}
          />
        ) : (
          <span className="spinner" aria-hidden="true" />
        )}
      </div>
      {images.length > 1 && (
        <>
          <button type="button" className="lightbox-nav is-prev" aria-label={t('attachments.previous')} onClick={(e) => { e.stopPropagation(); go(-1); }}>
            <ChevronLeft size={28} />
          </button>
          <button type="button" className="lightbox-nav is-next" aria-label={t('attachments.next')} onClick={(e) => { e.stopPropagation(); go(1); }}>
            <ChevronRight size={28} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** All attachments of a message: images as a gallery grid, then players and file cards. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter((a) => attachmentKind(a) === 'image');
  const others = attachments.filter((a) => attachmentKind(a) !== 'image');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className={`image-gallery count-${Math.min(images.length, 5)}`}>
          {images.map((a, i) => (
            <Thumb key={a.id} attachment={a} single={images.length === 1} onOpen={() => setOpen(i)} />
          ))}
        </div>
      )}
      {others.map((a) => {
        const kind = attachmentKind(a);
        return kind === 'video' || kind === 'audio' ? <MediaCard key={a.id} attachment={a} kind={kind} /> : <FileCard key={a.id} attachment={a} />;
      })}
      {others.filter(a => attachmentKind(a) === 'audio').map(a => <VoiceTranscript key={`voice:${a.id}`} attachmentId={a.id} />)}
      {open !== null && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Single attachment (kept for older call sites). */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  return <MessageAttachments attachments={[attachment]} />;
}
