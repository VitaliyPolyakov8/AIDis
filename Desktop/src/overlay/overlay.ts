/// <reference lib="dom" />
/**
 * AIDis in-game overlay page. The same page runs in two separate transparent windows (0.4.0):
 * "#list" (voice participants) and "#chat" (message notifications + quick reply), each placed and
 * dragged independently. See src/main/overlay.ts.
 *
 * Plain DOM, no framework, no timers running while nothing changes: it re-renders only when the
 * main process sends a new call state, a message or settings. Rows are reused (keyed by user id),
 * so a speaking change only flips a class. Message expiry uses one timeout per message.
 */
import type { OverlayMessage, OverlayParticipant, OverlaySettings, OverlayVoiceState } from '../../../Client/src/desktop/contract';
import type { OverlayPanel, OverlayUpdate } from '../main/overlay';
import { frameScale } from '../../../Client/src/cosmetics/frameFit';

type OverlaySend = 'toggleMute' | 'toggleDeafen' | 'done' | { type: 'watch'; id: string } | { type: 'reply'; channelId: string; replyToId: string | null; text: string };

interface OverlayBridge {
  onUpdate(callback: (update: OverlayUpdate) => void): () => void;
  send(action: OverlaySend): void;
}

declare global {
  interface Window {
    aidisOverlay: OverlayBridge;
  }
}

const STRINGS = {
  ru: {
    interact: 'Настройка overlay',
    hint: 'Перетащите, чтобы переместить. Горячая клавиша или «Готово» вернёт прозрачность для кликов.',
    chatInteract: 'Сообщения',
    chatHint: 'Нажмите на сообщение, чтобы ответить.',
    done: 'Готово',
    mute: 'Микрофон',
    deafen: 'Звук',
    recent: 'Последние сообщения',
    noMessages: 'Сообщений пока нет',
    nobody: 'Никто не говорит',
    replyPlaceholder: 'Ответить…',
    replyTo: 'Ответ для',
    send: 'Отправить',
    watch: 'Смотреть трансляцию',
    live: 'В ЭФИРЕ',
    watching: 'Смотрит трансляцию',
    profile: 'Профиль игры',
  },
  en: {
    interact: 'Overlay setup',
    hint: 'Drag to move. The hotkey or "Done" makes it click-through again.',
    chatInteract: 'Messages',
    chatHint: 'Click a message to reply.',
    done: 'Done',
    mute: 'Microphone',
    deafen: 'Sound',
    recent: 'Recent messages',
    noMessages: 'No messages yet',
    nobody: 'Nobody is speaking',
    replyPlaceholder: 'Reply…',
    replyTo: 'Replying to',
    send: 'Send',
    watch: 'Watch stream',
    live: 'LIVE',
    watching: 'Watching a stream',
    profile: 'Game profile',
  },
};

const RECENT_MS = 8000;
const INACTIVE_MS = 30_000;

// lucide icons (MIT), inline so the page needs no network or extra files.
const ICON = {
  eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  micOff:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  headphoneOff:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14h-1.343"/><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343"/><path d="m2 2 20 20"/><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"/></svg>',
  headphones:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 3 9-3 9 19-9Z"/><path d="M6 12h16"/></svg>',
};

const panel: OverlayPanel = location.hash === '#chat' ? 'chat' : 'list';
let settings: OverlaySettings | null = null;
let interactive = false;
let lang: 'ru' | 'en' = 'en';
let game: string | null = null;
let voice: OverlayVoiceState = { inCall: false, channelName: '', participants: [], micEnabled: true, deafened: false };
let messages: OverlayMessage[] = [];
let recent: OverlayMessage[] | null = null;
let recentTimer: ReturnType<typeof setTimeout> | null = null;
let replyTarget: OverlayMessage | null = null;
const messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSpoke = new Map<string, number>();
let inactiveTimer: ReturnType<typeof setTimeout> | null = null;

const root = document.getElementById('root') as HTMLDivElement;
const header = el('div', 'ov-header');
const list = el('ul', 'ov-list');
const chat = el('div', 'ov-chat');
const composer = el('form', 'ov-reply');
root.append(header, ...(panel === 'list' ? [list] : [chat, composer]));
const rows = new Map<string, HTMLLIElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const OVERLAY_FONTS = new Set(['unbounded', 'comfortaa', 'lobster', 'caveat', 'press-start', 'russo-one']);

/** 0.5.6: the same name style as in the app (color, gradient, glow, bundled font). */
function applyNameStyle(target: HTMLElement, s: { nameColor?: string | null; nameColor2?: string | null; nameGlow?: boolean; nameFont?: string | null }): void {
  const hex = (v: string | null | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  const first = hex(s.nameColor);
  const second = hex(s.nameColor2);
  if (first && second) {
    target.classList.add('ov-name-gradient');
    target.style.backgroundImage = `linear-gradient(90deg, ${first}, ${second})`;
  } else if (first) target.style.color = first;
  if (s.nameGlow) {
    target.classList.add('ov-name-glow');
    target.style.setProperty('--ov-name-glow', first ?? '#8c9bff');
  }
  if (s.nameFont && OVERLAY_FONTS.has(s.nameFont)) target.classList.add(`ov-font-${s.nameFont}`);
}

function avatar(src: string | null, color: string, initials: string, cosmeticFrame: string | null = null): HTMLElement {
  const box = el('span', 'ov-avatar');
  if (src && src.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.className = 'ov-avatar-img';
    img.src = src;
    img.alt = '';
    box.append(img);
  } else {
    box.style.background = color;
    box.textContent = initials;
  }
  if (!cosmeticFrame || !/^[a-z_]{1,32}$/.test(cosmeticFrame)) return box;
  // 0.5.1: the user's animated avatar frame (files shipped next to this page, see build).
  // 0.5.6: it sits in an outer box next to the round avatar, never inside it: the avatar clips to a
  // circle (and is greyed while silent), which cut the frame to an arc and shifted it up-left.
  const wrap = el('span', 'ov-avatar-wrap');
  const frame = document.createElement('img');
  frame.className = 'ov-cosmetic-frame';
  frame.src = `frames/${cosmeticFrame}.webp`;
  frame.alt = '';
  wrap.style.setProperty('--ov-frame-scale', String(frameScale(cosmeticFrame)));
  wrap.append(box, frame);
  return wrap;
}

function applyConfig(): void {
  if (!settings) return;
  const corner = (panel === 'list' ? settings.custom : settings.chatCustom) ? 'top-left' : settings.corner;
  root.className = `overlay panel-${panel} is-${corner} is-${settings.mode}${interactive ? ' is-interactive' : ''}${settings.showSpeaking ? '' : ' no-speaking'}`;
  root.style.setProperty('--ov-bg-alpha', String(settings.opacity / 100));
  renderHeader();
  if (panel === 'list') renderParticipants();
  else {
    renderChat();
    renderComposer();
  }
}

function renderHeader(): void {
  header.replaceChildren();
  if (!interactive) return;
  const t = STRINGS[lang];
  if (panel === 'chat') {
    header.append(el('div', 'ov-header-title', t.chatInteract), el('div', 'ov-header-hint', t.chatHint));
    return;
  }
  const title = el('div', 'ov-header-title', t.interact);
  if (game && settings?.profiles[game]) title.append(el('span', 'ov-profile', ` · ${t.profile}: ${game}`));
  const hint = el('div', 'ov-header-hint', t.hint);
  const actions = el('div', 'ov-header-actions');
  const mic = el('button', `ov-btn${voice.micEnabled ? '' : ' is-off'}`);
  mic.type = 'button';
  mic.innerHTML = voice.micEnabled ? ICON.mic : ICON.micOff;
  mic.title = t.mute;
  mic.setAttribute('aria-pressed', String(!voice.micEnabled));
  mic.addEventListener('click', () => window.aidisOverlay.send('toggleMute'));
  const deaf = el('button', `ov-btn${voice.deafened ? ' is-off' : ''}`);
  deaf.type = 'button';
  deaf.innerHTML = voice.deafened ? ICON.headphoneOff : ICON.headphones;
  deaf.title = t.deafen;
  deaf.setAttribute('aria-pressed', String(voice.deafened));
  deaf.addEventListener('click', () => window.aidisOverlay.send('toggleDeafen'));
  const done = el('button', 'ov-btn ov-done', t.done);
  done.type = 'button';
  done.addEventListener('click', () => window.aidisOverlay.send('done'));
  if (voice.inCall) actions.append(mic, deaf);
  actions.append(done);
  header.append(title, hint, actions);
}

/** "Speaking only" (mode minimal): silent people are hidden; speakers appear immediately. */
function visibleParticipants(): OverlayParticipant[] {
  if (!settings || !settings.showParticipants || !voice.inCall) return [];
  const now = Date.now();
  for (const p of voice.participants) if (p.speaking) lastSpoke.set(p.id, now);
  if (settings.mode === 'minimal' && !interactive) return voice.participants.filter((p) => p.speaking);
  if (settings.hideInactive && !interactive) {
    return voice.participants.filter((p) => p.speaking || now - (lastSpoke.get(p.id) ?? 0) < INACTIVE_MS);
  }
  return voice.participants;
}

/** One timeout for the next person to fade out (auto-hide inactive), instead of polling. */
function scheduleInactive(): void {
  if (inactiveTimer) clearTimeout(inactiveTimer);
  inactiveTimer = null;
  if (!settings?.hideInactive || settings.mode === 'minimal') return;
  const now = Date.now();
  let next = Infinity;
  for (const p of voice.participants) {
    const t = lastSpoke.get(p.id);
    if (!p.speaking && t !== undefined && now - t < INACTIVE_MS) next = Math.min(next, t + INACTIVE_MS - now);
  }
  if (next !== Infinity) inactiveTimer = setTimeout(renderParticipants, next + 50);
}

function renderParticipants(): void {
  if (panel !== 'list') return;
  const t = STRINGS[lang];
  const shown = visibleParticipants();
  const keep = new Set(shown.map((p) => p.id));
  for (const [id, row] of rows) {
    if (!keep.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  shown.forEach((p, index) => {
    let row = rows.get(p.id);
    const signature = `${p.name}|${p.avatar ?? ''}|${p.color}|${p.initials}|${p.streaming ? 1 : 0}|${interactive ? 1 : 0}|${p.frame ?? ''}|${p.nameColor ?? ''}|${p.nameColor2 ?? ''}|${p.nameGlow ? 1 : 0}|${p.nameFont ?? ''}|${p.cosmeticFrame ?? ''}`;
    if (!row || row.dataset.sig !== signature) {
      const fresh = el('li', 'ov-row');
      fresh.dataset.sig = signature;
      // 0.4.1: the profile frame is drawn only while speaking (CSS, see overlay.css).
      // 0.5.6: the animated frame replaces the old speaking ring (they stacked).
      if (p.frame && !p.cosmeticFrame) fresh.classList.add(`frame-${p.frame}`);
      const nameEl = el('span', 'ov-name', p.name);
      // 0.5.0: the user's nickname color (validated #rrggbb; CSSOM, allowed by the page's CSP).
      applyNameStyle(nameEl, p);
      fresh.append(avatar(p.avatar, p.color, p.initials, p.cosmeticFrame ?? null), nameEl, el('span', 'ov-icons'));
      if (p.streaming) {
        const live = el('span', 'ov-live', t.live);
        fresh.append(live);
        // Participant switching: in interaction mode a streamer row switches the main window to their stream.
        if (interactive && !p.isSelf) {
          fresh.classList.add('is-clickable');
          fresh.title = t.watch;
          fresh.addEventListener('click', () => window.aidisOverlay.send({ type: 'watch', id: p.id }));
        }
      }
      if (row) row.replaceWith(fresh);
      row = fresh;
      rows.set(p.id, row);
    }
    row.classList.toggle('is-speaking', p.speaking && settings?.showSpeaking !== false);
    row.classList.toggle('is-self', p.isSelf);
    const icons = row.querySelector('.ov-icons');
    if (icons) {
      icons.innerHTML = `${p.watching ? ICON.eye : ''}${p.micMuted ? ICON.micOff : ''}${p.deafened ? ICON.headphoneOff : ''}`;
      if (p.watching) icons.setAttribute('aria-label', t.watching);
      else icons.removeAttribute('aria-label');
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  list.classList.toggle('is-empty', shown.length === 0);
  scheduleInactive();
}

function renderChat(): void {
  if (panel !== 'chat') return;
  chat.replaceChildren();
  if (!settings) return;
  const t = STRINGS[lang];
  const source = recent ?? (settings.messageMode !== 'off' && settings.mode === 'extended' ? messages.slice(-settings.messageCount) : settings.messageMode !== 'off' ? messages.slice(-1) : []);
  if (recent) chat.append(el('div', 'ov-chat-title', t.recent));
  if (recent && recent.length === 0) chat.append(el('div', 'ov-msg ov-msg-empty', t.noMessages));
  for (const m of source) {
    const item = el(interactive ? 'button' : 'div', `ov-msg${m.mention ? ' is-mention' : ''}${replyTarget?.id === m.id ? ' is-target' : ''}`);
    if (item instanceof HTMLButtonElement) {
      item.type = 'button';
      item.addEventListener('click', () => {
        replyTarget = replyTarget?.id === m.id ? null : m;
        renderChat();
        renderComposer();
        composer.querySelector('input')?.focus();
      });
    }
    const body = el('div', 'ov-msg-body');
    const meta = el('div', 'ov-msg-meta');
    const authorEl = el('span', 'ov-msg-author', m.authorName);
    applyNameStyle(authorEl, m);
    meta.append(authorEl);
    if (m.channelLabel) meta.append(el('span', 'ov-msg-channel', m.channelLabel));
    body.append(meta, el('span', 'ov-msg-text', m.text));
    item.append(avatar(m.avatar, m.color, m.initials), body);
    chat.append(item);
  }
}

/** Quick reply (interaction mode): one line, sent by the main window like any message. */
function renderComposer(): void {
  if (panel !== 'chat') return;
  composer.replaceChildren();
  const t = STRINGS[lang];
  const shown = recent ?? messages;
  const target = replyTarget ?? shown[shown.length - 1] ?? null;
  composer.hidden = !interactive || !target?.channelId;
  if (composer.hidden || !target?.channelId) return;
  const label = el('div', 'ov-reply-label', `${t.replyTo} ${target.authorName}${target.channelLabel ? ` · ${target.channelLabel}` : ''}`);
  const row = el('div', 'ov-reply-row');
  const input = document.createElement('input');
  input.className = 'ov-reply-input';
  input.maxLength = 2000;
  input.placeholder = t.replyPlaceholder;
  input.spellcheck = true;
  input.lang = lang;
  input.setAttribute('aria-label', t.replyPlaceholder);
  const button = el('button', 'ov-btn ov-send');
  button.type = 'submit';
  button.innerHTML = ICON.send;
  button.title = t.send;
  row.append(input, button);
  composer.append(label, row);
  composer.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !target.channelId) return;
    window.aidisOverlay.send({ type: 'reply', channelId: target.channelId, replyToId: replyTarget ? target.id : null, text });
    input.value = '';
    replyTarget = null;
    renderChat();
    renderComposer();
  };
}

function addMessage(message: OverlayMessage): void {
  if (!settings || settings.messageMode === 'off') return;
  messages = [...messages.filter((m) => m.id !== message.id), message].slice(-5);
  const timer = setTimeout(() => {
    messageTimers.delete(message.id);
    // In interaction mode messages stay so they can be answered.
    if (interactive) return;
    messages = messages.filter((m) => m.id !== message.id);
    renderChat();
  }, settings.messageSeconds * 1000);
  messageTimers.set(message.id, timer);
  renderChat();
  renderComposer();
}

window.aidisOverlay.onUpdate((update) => {
  switch (update.type) {
    case 'config': {
      const wasInteractive = interactive;
      settings = update.settings;
      interactive = update.interactive;
      lang = update.language;
      game = update.game;
      if (settings.messageMode === 'off') {
        for (const timer of messageTimers.values()) clearTimeout(timer);
        messageTimers.clear();
        messages = [];
      }
      if (wasInteractive && !interactive) {
        replyTarget = null;
        recent = null;
      }
      // Rows depend on interaction mode (clickable streamers): rebuild them.
      if (wasInteractive !== interactive) {
        for (const row of rows.values()) row.remove();
        rows.clear();
      }
      applyConfig();
      break;
    }
    case 'state':
      voice = update.state;
      if (!voice.inCall) lastSpoke.clear();
      renderHeader();
      renderParticipants();
      break;
    case 'message':
      addMessage(update.message);
      break;
    case 'recent':
      recent = update.messages;
      if (recentTimer) clearTimeout(recentTimer);
      recentTimer = null;
      // Interaction mode keeps the list until "Done"; the hotkey shows it for a few seconds.
      if (!interactive) {
        recentTimer = setTimeout(() => {
          recent = null;
          recentTimer = null;
          renderChat();
        }, RECENT_MS);
      }
      renderChat();
      renderComposer();
      break;
  }
});
