import type { ToastItem, ToastUpdate } from '../main/toasts';

/**
 * 0.5.0 notification window page: renders the card stack bottom-up (newest at the bottom, like
 * Discord), slides cards in and out, and reports hover / click / close to the main process.
 * Everything is plain text (textContent); images are data: URLs only (see the page's CSP).
 */
interface Bridge {
  onUpdate(callback: (update: ToastUpdate) => void): () => void;
  send(action: unknown): void;
}
const bridge = (window as unknown as { aidisToast: Bridge }).aidisToast;
const stack = document.getElementById('stack') as HTMLOListElement;
const cards = new Map<number, HTMLLIElement>();
let icon: string | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(t: ToastItem): HTMLLIElement {
  const li = el('li', `toast${t.mention ? ' is-mention' : ''}`);
  const avatar = el('span', 'toast-avatar');
  if (t.avatar) {
    const img = el('img', '');
    img.src = t.avatar;
    img.alt = '';
    avatar.append(img);
  } else {
    avatar.textContent = t.initials;
    avatar.style.background = t.color;
  }
  const body = el('div', 'toast-body');
  const head = el('div', 'toast-head');
  const name = el('span', 'toast-name', t.author);
  if (t.nameColor) name.style.color = t.nameColor;
  head.append(name);
  if (t.channelLabel) head.append(el('span', 'toast-channel', t.channelLabel));
  body.append(head, el('div', 'toast-text', t.body));
  const app = el('span', 'toast-app');
  if (icon) {
    const img = el('img', '');
    img.src = icon;
    img.alt = 'AIDis';
    app.append(img);
  }
  const close = el('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    bridge.send({ type: 'close', id: t.id });
  });
  li.append(app, avatar, body, close);
  li.addEventListener('click', () => bridge.send({ type: 'open', id: t.id }));
  return li;
}

function render(list: ToastItem[]): void {
  const keep = new Set(list.map((t) => t.id));
  for (const [id, node] of cards) {
    if (keep.has(id)) continue;
    cards.delete(id);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }
  for (const t of list) {
    if (cards.has(t.id)) continue;
    const node = card(t);
    cards.set(t.id, node);
    stack.append(node);
    requestAnimationFrame(() => node.classList.add('is-in'));
  }
}

let hover = false;
function setHover(next: boolean): void {
  if (next === hover) return;
  hover = next;
  bridge.send({ type: 'hover', hover });
}
// The window is click-through until the mouse is over a card (mouse moves are still forwarded).
document.addEventListener('mousemove', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  setHover(target?.closest('.toast') != null);
});
document.addEventListener('mouseleave', () => setHover(false));

bridge.onUpdate((update) => {
  icon = update.icon;
  render(update.toasts);
});
