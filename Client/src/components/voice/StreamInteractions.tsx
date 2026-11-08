import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MousePointer2 } from 'lucide-react';
import { normaliseVideoPoint, streamInteractions, useStreamInteractions, videoContentRect, type StreamReactionKind, type VideoRect } from '../../voice/streamInteractions';
import { usePresenceStore } from '../../stores/presenceStore';

const REACTIONS: { kind: StreamReactionKind; glyph: string; key: string }[] = [
  { kind: 'laugh', glyph: '😂', key: 'streamExtras.laugh' },
  { kind: 'clap', glyph: '👏', key: 'streamExtras.clap' },
  { kind: 'f', glyph: 'F', key: 'streamExtras.respects' },
];

/** All coordinates are relative to the contained video, never its black letterboxes. */
export function StreamInteractions({ owner, local, videoRef, ready }: { owner: string; local: boolean; videoRef: RefObject<HTMLVideoElement | null>; ready: boolean }) {
  const { t } = useTranslation();
  const stream = useStreamInteractions((s) => s.streams[owner]);
  const pointers = useStreamInteractions((s) => s.pointers);
  const reactions = useStreamInteractions((s) => s.reactions);
  const users = usePresenceStore((s) => s.users);
  const [armedGeneration, setArmedGeneration] = useState<string | null>(null);
  const [content, setContent] = useState<VideoRect | null>(null);
  const armed = !local && ready && stream?.pointers && !!stream.generation && armedGeneration === stream.generation;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const bounds = video.getBoundingClientRect();
      const rect = videoContentRect(bounds, video.videoWidth, video.videoHeight);
      const parent = video.parentElement?.getBoundingClientRect() ?? bounds;
      setContent(rect ? { ...rect, left: rect.left - parent.left, top: rect.top - parent.top } : null);
    };
    measure();
    const view = video.ownerDocument.defaultView;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(video);
    view?.addEventListener('resize', measure);
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    return () => { observer?.disconnect(); view?.removeEventListener('resize', measure); video.removeEventListener('loadedmetadata', measure); video.removeEventListener('resize', measure); };
  }, [videoRef, ready]);

  const ownPointers = local ? pointers.filter((hint) => hint.owner === owner) : [];
  const ownReactions = reactions.filter((hint) => hint.owner === owner);
  const sender = (identity: string) => users[identity]?.displayName ?? identity;
  return <>
    {content && ready && armed && <button
      type="button" className="stream-pointer-target" aria-label={t('streamExtras.placePointer')}
      style={{ left: content.left, top: content.top, width: content.width, height: content.height }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setArmedGeneration(null); } }}
      onClick={(event) => {
        event.stopPropagation();
        const video = videoRef.current; if (!video) return;
        const position = event.detail === 0 ? { x: 0.5, y: 0.5 } : normaliseVideoPoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, event.clientX, event.clientY);
        if (position) streamInteractions.point(owner, position);
      }}
    />}
    <div className="stream-transient-hints" aria-live="off">
      {ready && content && ownPointers.map((hint) => <span key={hint.id} className="stream-pointer-marker" style={{ left: content.left + hint.x * content.width, top: content.top + hint.y * content.height }}><MousePointer2 size={21} aria-hidden="true" /><span>{sender(hint.sender)}</span></span>)}
    </div>
    <div className="stream-reaction-feed" aria-live="polite" aria-atomic="false">
      {ownReactions.map((hint) => <span className="stream-reaction-bubble" key={hint.id}><span aria-label={t(REACTIONS.find((item) => item.kind === hint.reaction)!.key)}>{REACTIONS.find((item) => item.kind === hint.reaction)!.glyph}</span> <span>{sender(hint.sender)}</span></span>)}
    </div>
    <div className="stream-interaction-controls stream-overlay" role="group" aria-label={t('streamExtras.reactions')} onClick={(event) => event.stopPropagation()}>
      {local ? <button type="button" className={`stream-btn${stream?.pointers ? ' is-active' : ''}`} disabled={!ready || !stream?.generation} aria-pressed={stream?.pointers ?? false} aria-label={t('streamExtras.allowPointers')} title={t('streamExtras.allowPointers')} onClick={() => streamInteractions.setPointers(!stream?.pointers)}><MousePointer2 size={16} /></button>
        : stream?.pointers && <button type="button" className={`stream-btn${armed ? ' is-active' : ''}`} disabled={!ready} aria-pressed={!!armed} aria-label={t('streamExtras.pointer')} title={t('streamExtras.pointer')} onClick={() => setArmedGeneration(armed ? null : stream.generation)}><MousePointer2 size={16} /></button>}
      {REACTIONS.map(({ kind, glyph, key }) => <button key={kind} type="button" className="stream-btn" disabled={!ready || !stream?.generation} aria-label={t(key)} title={t(key)} onClick={() => streamInteractions.react(owner, kind)}>{glyph}</button>)}
    </div>
  </>;
}
