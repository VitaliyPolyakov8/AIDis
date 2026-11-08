import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { alice, bob, general, makeMessage } from './test/fixtures';

vi.mock('./api/messages', () => ({
  HISTORY_PAGE_SIZE: 50,
  messagesApi: { history: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), react: vi.fn(), pin: vi.fn(), pins: vi.fn(), search: vi.fn() },
}));
vi.mock('./api/channels', () => ({
  channelsApi: { list: vi.fn(), reads: vi.fn(), markRead: vi.fn(), setNotify: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), reorder: vi.fn() },
  dmsApi: { list: vi.fn(() => Promise.resolve({ dms: [] })), open: vi.fn(), update: vi.fn(), leave: vi.fn(), ring: vi.fn() },
}));

const { gameTheme, normalizeGameName } = await import('./utils/gameTheme');
const { mentionQueryAt, mentionCandidates } = await import('./components/chat/Composer');
const { MessageItem } = await import('./components/chat/MessageItem');
const { MessageText } = await import('./components/chat/MessageText');
const { MenuHost } = await import('./components/menu/MenuHost');
const { parseAudioStats } = await import('./voice/voiceDiagnostics');
const { attachmentKind } = await import('./components/chat/AttachmentView');
const { useReadStore } = await import('./stores/readStore');
const { useChatStore } = await import('./stores/chatStore');
const { useAuthStore } = await import('./stores/authStore');
const { usePresenceStore } = await import('./stores/presenceStore');
const { useStatusStore } = await import('./stores/statusStore');
const { shouldNotify } = await import('./desktop/notifications');
const { messagesApi } = await import('./api/messages');
const { channelsApi } = await import('./api/channels');
const { dmName } = await import('./utils/dm');
const { effectiveOverlay, sanitizeOverlay, profileFromSettings, DEFAULT_OVERLAY } = await import('./desktop/contract');

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  useReadStore.getState().reset();
  useChatStore.setState({ channels: [general], channelsLoaded: true });
  useAuthStore.setState({ status: 'authenticated', user: alice });
  usePresenceStore.setState({ users: { [alice.id]: alice, [bob.id]: bob }, loaded: true });
  useStatusStore.setState({ status: 'ONLINE' });
});

describe('game color themes', () => {
  it('curated games get their accent; unknown games a stable generated one', () => {
    expect(gameTheme('HELLDIVERS™ 2')).toMatchObject({ accent: '#ff8a3d', curated: true });
    expect(gameTheme('Escape from Tarkov').accent).toBe('#9fae6a');
    expect(gameTheme('Minecraft').curated).toBe(true);
    const a = gameTheme('Some Indie Game');
    expect(a.curated).toBe(false);
    expect(gameTheme('some indie game')).toEqual(a);
    expect(gameTheme('Another Indie Game').accent).not.toBe(a.accent);
    expect(normalizeGameName('  ELDEN   RING® ')).toBe('elden ring');
  });
});

describe('mentions', () => {
  it('detects "@partial" at the caret and ranks people', () => {
    expect(mentionQueryAt('hi @bo', 6)).toEqual({ start: 3, query: 'bo' });
    expect(mentionQueryAt('mail@bo', 7)).toBeNull();
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionCandidates([alice, bob], 'b').map((u) => u.id)).toEqual([bob.id]);
    expect(mentionCandidates([alice, bob], '').length).toBe(2);
  });

  it('renders known @usernames as mentions (others stay text)', () => {
    render(
      <MemoryRouter>
        <MessageText text="hey @bob and @nobody" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '@Bob' })).toHaveClass('mention');
    expect(screen.getByText(/@nobody/)).toBeInTheDocument();
  });
});

describe('messages v2', () => {
  it('shows the reply line, or "Original message deleted"', () => {
    const reply = makeMessage({ author: bob, replyToId: 'x', replyTo: { id: 'x', authorId: alice.id, authorName: 'Alice', content: 'кто играет?', deleted: false, hasAttachments: false } });
    const { rerender } = render(<MessageItem message={reply} grouped={false} isOwn={false} canDelete={false} selfId={alice.id} />);
    expect(screen.getByRole('button', { name: /@Alice/ })).toHaveTextContent('кто играет?');
    rerender(<MessageItem message={{ ...reply, replyTo: { ...reply.replyTo!, deleted: true, content: '' } }} grouped={false} isOwn={false} canDelete={false} selfId={alice.id} />);
    expect(screen.getByText('Original message deleted')).toBeInTheDocument();
  });

  it('reactions: counts, mine highlighted, toggling is optimistic and uses the server answer', async () => {
    const message = makeMessage({ author: bob, reactions: [{ emoji: '👍', count: 2, userIds: [bob.id, alice.id] }] });
    useChatStore.setState({ byChannel: { [general.id]: { messages: [message], hasMore: false, hasNewer: false, loadingNewer: false, status: 'ready', loadingOlder: false, error: null } } });
    vi.mocked(messagesApi.react).mockResolvedValueOnce({ channelId: general.id, reactions: [{ emoji: '👍', count: 1, userIds: [bob.id] }] });
    function Live() {
      const m = useChatStore((s) => s.byChannel[general.id]?.messages[0]);
      return m ? <MessageItem message={m} grouped={false} isOwn={false} canDelete={false} selfId={alice.id} /> : null;
    }
    render(<Live />);
    const chip = screen.getByTitle(/reacted with 👍/);
    expect(chip).toHaveClass('is-mine');
    expect(chip).toHaveTextContent('2');
    fireEvent.click(chip);
    await waitFor(() => expect(messagesApi.react).toHaveBeenCalledWith(message.id, '👍', false));
    await waitFor(() => expect(screen.getByTitle(/reacted with 👍/)).not.toHaveClass('is-mine'));
  });

  it('message menu: reply sets the composer target, pin only with permission', async () => {
    const message = makeMessage({ author: bob });
    render(
      <>
        <MessageItem message={message} grouped={false} isOwn={false} canDelete={false} canPin={false} selfId={alice.id} />
        <MenuHost />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Pin message' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(useChatStore.getState().replyTo[general.id]?.id).toBe(message.id);
  });

  it('mentions of me are highlighted', () => {
    render(<MessageItem message={makeMessage({ author: bob, content: '@alice hi', mentions: [alice.id] })} grouped={false} isOwn={false} canDelete={false} selfId={alice.id} />);
    expect(document.querySelector('.message.is-mentioned')).not.toBeNull();
  });
});

describe('unread state', () => {
  it('counts others\' messages and mentions; marking read is debounced to the server', async () => {
    vi.useFakeTimers();
    try {
      useReadStore.setState({ reads: { [general.id]: { channelId: general.id, lastReadAt: '2026-01-01T00:00:00.000Z', unread: 0, mentions: 0, notifyMode: null } } });
      const store = useReadStore.getState();
      store.onMessage(makeMessage({ author: bob }), alice.id);
      store.onMessage(makeMessage({ author: bob, mentions: [alice.id] }), alice.id);
      store.onMessage(makeMessage({ author: alice }), alice.id);
      expect(useReadStore.getState().reads[general.id]).toMatchObject({ unread: 2, mentions: 1 });
      vi.mocked(channelsApi.markRead).mockResolvedValue({ read: { channelId: general.id, lastReadAt: new Date().toISOString(), unread: 0, mentions: 0, notifyMode: null } });
      const last = makeMessage({ author: bob });
      useReadStore.getState().markRead(general.id, last);
      expect(useReadStore.getState().reads[general.id]).toMatchObject({ unread: 0, mentions: 0 });
      expect(channelsApi.markRead).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(channelsApi.markRead).toHaveBeenCalledWith(general.id, last.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notification rules: own never, DND never, channel mode, mentions', () => {
    const fromBob = makeMessage({ author: bob });
    const mentionMe = makeMessage({ author: bob, mentions: [alice.id] });
    expect(shouldNotify(makeMessage({ author: alice }), { ignoreFocus: true }).notify).toBe(false);
    expect(shouldNotify(fromBob, { ignoreFocus: true }).notify).toBe(true);
    useReadStore.setState({ reads: { [general.id]: { channelId: general.id, lastReadAt: '', unread: 0, mentions: 0, notifyMode: 'MENTIONS' } } });
    expect(shouldNotify(fromBob, { ignoreFocus: true }).notify).toBe(false);
    expect(shouldNotify(mentionMe, { ignoreFocus: true })).toEqual({ notify: true, mention: true });
    useReadStore.setState({ reads: { [general.id]: { channelId: general.id, lastReadAt: '', unread: 0, mentions: 0, notifyMode: 'NONE' } } });
    expect(shouldNotify(mentionMe, { ignoreFocus: true }).notify).toBe(false);
    useReadStore.setState({ reads: {} });
    useStatusStore.setState({ status: 'DND' });
    expect(shouldNotify(mentionMe, { ignoreFocus: true }).notify).toBe(false);
  });
});

describe('DMs, media, diagnostics, overlay profiles', () => {
  it('names DMs after the other people (or the group title)', () => {
    const users = { [alice.id]: alice, [bob.id]: bob };
    expect(dmName({ memberIds: [alice.id, bob.id], title: null }, users, alice.id)).toBe('Bob');
    expect(dmName({ memberIds: [alice.id, bob.id], title: 'Squad' }, users, alice.id)).toBe('Squad');
  });

  it('classifies attachments: images, playable video / audio, other files', () => {
    expect(attachmentKind({ mimeType: 'image/png' })).toBe('image');
    expect(attachmentKind({ mimeType: 'video/mp4' })).toBe('video');
    expect(attachmentKind({ mimeType: 'video/quicktime' })).toBe('file');
    expect(attachmentKind({ mimeType: 'audio/mpeg' })).toBe('audio');
    expect(attachmentKind({ mimeType: 'application/zip' })).toBe('file');
    expect(attachmentKind({ mimeType: 'image/svg+xml' })).toBe('file');
  });

  it('parses voice stats: codec, bitrate, jitter, loss, RTT, transport', () => {
    const report = (bytes: number, ts: number) =>
      new Map<string, Record<string, unknown>>([
        ['o', { id: 'o', type: 'outbound-rtp', kind: 'audio', bytesSent: bytes, timestamp: ts, codecId: 'c' }],
        ['c', { id: 'c', type: 'codec', mimeType: 'audio/opus' }],
        ['r', { id: 'r', type: 'remote-inbound-rtp', kind: 'audio', jitter: 0.012, fractionLost: 0.02, roundTripTime: 0.045 }],
        ['p', { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.04, localCandidateId: 'l' }],
        ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }],
      ]);
    const first = parseAudioStats(report(10_000, 1000), null);
    const second = parseAudioStats(report(16_000, 2000), first.counters);
    expect(second.diag).toEqual({ codec: 'opus', bitrateKbps: 48, jitterMs: 12, lossPercent: 2, rttMs: 40, candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' });
  });

  it('overlay: per-game profile overrides layout; old settings migrate', () => {
    const base = sanitizeOverlay({ ...DEFAULT_OVERLAY, scale: 100, corner: 'top-left' });
    const withProfile = sanitizeOverlay({ ...base, profiles: { 'Helldivers 2': { ...profileFromSettings(base), corner: 'bottom-right', scale: 80 } } });
    expect(effectiveOverlay(withProfile, 'Helldivers 2')).toMatchObject({ corner: 'bottom-right', scale: 80 });
    expect(effectiveOverlay(withProfile, 'Other')).toMatchObject({ corner: 'top-left', scale: 100 });
    expect(effectiveOverlay(withProfile, null).corner).toBe('top-left');
    expect(sanitizeOverlay({ showMessages: false }).messageMode).toBe('off');
    expect(sanitizeOverlay({}).messageMode).toBe('all');
    expect(sanitizeOverlay({ profiles: { x: { scale: 999, corner: 'nowhere' } } }).profiles.x).toMatchObject({ scale: 150, corner: 'top-left' });
  });
});
