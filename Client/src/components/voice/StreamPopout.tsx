import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Maximize, Pin, PinOff, Undo2 } from 'lucide-react';
import { create } from 'zustand';
import { desktop } from '../../desktop/bridge';
import { voice } from '../../voice/voiceService';
import { liveStreams, parseStreamKey, useVoiceStore } from '../../voice/voiceStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { StreamTile } from './StreamView';

/**
 * 0.4.5 "Pop Out": a watched stream in its own window (desktop app).
 *
 * The window is a same-origin child window of the main page (window.open), and the stream tile
 * is rendered into it with a React portal. The SAME LiveKit track and MediaStream keep playing:
 * nothing is re-subscribed, the streamer does not republish, the source and quality stay.
 * Closing the window brings the stream back into the main window. The shell remembers the window's
 * size and position (and keeps it on a connected monitor); "always on top" goes through the shell.
 */
interface PopoutEntry {
  identity: string;
  win: Window;
  container: HTMLElement;
  overlay: boolean;
}

export const usePopoutStore = create<{ popouts: string[]; entries: PopoutEntry[] }>(() => ({ popouts: [], entries: [] }));
export const usePopouts = () => usePopoutStore((s) => s.popouts);

export const popoutName = (identity: string, overlay = false) => `aidis-popout-${overlay ? 'overlay-' : ''}${identity.replace(/[^a-zA-Z0-9-]/g, '')}`;

/** Copies the page's stylesheets and theme attributes into the pop-out document. */
function mirrorStyles(target: Document): void {
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) target.head.appendChild(node.cloneNode(true));
  const root = document.documentElement;
  target.documentElement.className = `${root.className} is-popout`;
  const theme = root.getAttribute('data-ui-theme');
  if (theme) target.documentElement.setAttribute('data-ui-theme', theme);
  else target.documentElement.removeAttribute('data-ui-theme');
  target.documentElement.lang = root.lang;
}

/** Opens the window (from the click, as browsers require) and starts watching the stream. */
export function openStreamPopout(identity: string, overlay = false): void {
  const existing = usePopoutStore.getState().entries.find((e) => e.identity === identity);
  if (existing?.overlay === overlay) return;
  if (existing) closeStreamPopout(identity);
  const win = window.open('about:blank', popoutName(identity, overlay), overlay ? 'width=480,height=300' : 'width=960,height=560');
  if (!win) return;
  voice.watchShare(identity);
  win.document.title = 'AIDis';
  mirrorStyles(win.document);
  const container = win.document.createElement('div');
  container.className = 'stream-popout-root';
  win.document.body.appendChild(container);
  // Closed by the user (window X): the stream goes back into the main window.
  win.addEventListener('pagehide', () => closeStreamPopout(identity, false));
  usePopoutStore.setState((s) => ({ popouts: [...s.popouts, identity], entries: [...s.entries, { identity, win, container, overlay }] }));
}

export function closeStreamPopout(identity: string, closeWindow = true): void {
  const entry = usePopoutStore.getState().entries.find((e) => e.identity === identity);
  usePopoutStore.setState((s) => ({ popouts: s.popouts.filter((id) => id !== identity), entries: s.entries.filter((e) => e.identity !== identity) }));
  if (closeWindow && entry && !entry.win.closed) entry.win.close();
}

function setWindowTitle(win: Window, name: string): void {
  win.document.title = name ? `${name} — AIDis` : 'AIDis';
}

function PopoutChrome({ identity, win, children, overlay }: { identity: string; win: Window; children: ReactNode; overlay: boolean }) {
  const { t } = useTranslation();
  const [onTop, setOnTop] = useState(false);
  return (
    <div className={`stream-popout${overlay ? ' is-video-overlay' : ''}`}>
      {children}
      <div className="stream-popout-bar">
        {overlay && <span className="stream-overlay-drag" title={t('streamExtras.overlayHint')}>{t('streamExtras.overlay')}</span>}
        {!overlay && <>
        <button
          type="button"
          className={`stream-btn${onTop ? ' is-active' : ''}`}
          aria-pressed={onTop}
          title={t('voice.alwaysOnTop')}
          aria-label={t('voice.alwaysOnTop')}
          onClick={() => {
            desktop?.streams?.setAlwaysOnTop(popoutName(identity), !onTop);
            setOnTop(!onTop);
          }}
        >
          {onTop ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
        </>}
        <button
          type="button"
          className="stream-btn"
          title={t('voice.fullscreen')}
          aria-label={t('voice.fullscreen')}
          onClick={() => {
            if (win.document.fullscreenElement) void win.document.exitFullscreen().catch(() => undefined);
            else void win.document.documentElement.requestFullscreen().catch(() => undefined);
          }}
        >
          <Maximize size={16} />
        </button>
        <button type="button" className="stream-btn" title={t('voice.popIn')} aria-label={t('voice.popIn')} onClick={() => closeStreamPopout(identity)}>
          <Undo2 size={16} />
        </button>
      </div>
    </div>
  );
}

function StreamPopoutWindow({ entry }: { entry: PopoutEntry }) {
  const { identity, win, container } = entry;
  // 0.5.0: `identity` here is the stream key (screen: the user id, camera: user id + "#camera").
  const userId = parseStreamKey(identity).identity;
  // Select the (stable) participant object; the stream ref is derived (a new object every render
  // inside a zustand selector would loop).
  const participant = useVoiceStore((s) => s.participants.find((p) => p.identity === userId));
  const stream = useMemo(() => (participant ? liveStreams([participant]).find((st) => st.key === identity) : undefined), [participant, identity]);
  const name = usePresenceStore((s) => s.users[userId]?.displayName) ?? stream?.presenter.name ?? '';

  // The stream ended (or we left voice): close the window.
  useEffect(() => {
    if (!stream) closeStreamPopout(identity);
  }, [stream, identity]);

  useEffect(() => {
    setWindowTitle(win, name);
  }, [win, name]);

  if (!stream) return null;
  return createPortal(
    <PopoutChrome identity={identity} win={win} overlay={entry.overlay}>
      <StreamTile stream={stream} focused multi={false} poppedOut />
    </PopoutChrome>,
    container,
  );
}

/** Mounted once at the app level, so pop-outs survive switching channels in the main window. */
export function StreamPopoutHost() {
  const entries = usePopoutStore((s) => s.entries);
  const inCall = useVoiceStore((s) => s.status === 'connected' || s.status === 'reconnecting');
  useEffect(() => {
    if (!inCall) for (const e of usePopoutStore.getState().entries) closeStreamPopout(e.identity);
  }, [inCall]);
  return (
    <>
      {entries.map((entry) => (
        <StreamPopoutWindow key={entry.identity} entry={entry} />
      ))}
    </>
  );
}
