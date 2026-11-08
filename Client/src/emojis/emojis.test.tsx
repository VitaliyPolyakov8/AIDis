import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageText } from '../components/chat/MessageText';
import { EmojiPicker } from '../components/chat/EmojiPicker';
import { EmojiSettings } from './EmojiSettings';
import { EmojiGlyph } from './EmojiImage';
import { useEmojiStore } from './store';
import { emojisApi } from './api';
import { useAuthStore } from '../stores/authStore';
import type { ServerEmoji } from '../api/types';
import { createEmojiDraft, emojiShortcodes } from './tokens';
import { ttsText } from '../voice/tts';
import { MessageItem } from '../components/chat/MessageItem';
import { bob, GUILD_ID, makeMessage, setGuildPermissions } from '../test/fixtures';

const blobRequest = vi.hoisted(() => vi.fn(async () => new Blob(['image'], { type: 'image/png' })));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), requestBlob: blobRequest, request: vi.fn() }));
vi.mock('../components/chat/emoji', async original => ({
  ...await original<typeof import('../components/chat/emoji')>(),
  loadEmoji: async () => [{ unicode: '😀', label: 'Grinning face', tags: ['smile'], group: 0 }],
}));
const emoji: ServerEmoji = { id: 'da05ad72-c596-4f88-9355-b9e51c6dce2e', name: 'улыбка', width: 32, height: 32, animated: false, createdById: 'alice', createdAt: '2026-11-03T12:00:00Z', guildId: GUILD_ID };
beforeEach(async () => {
  useEmojiStore.setState({ emojis: [emoji], loaded: true, error: null });
  await setGuildPermissions([]);
  useAuthStore.setState({ user: { id: 'alice', role: 'USER' } as never });
  vi.spyOn(emojisApi, 'list').mockResolvedValue({ emojis: [emoji] }); blobRequest.mockClear();
});
afterEach(() => { useEmojiStore.getState().reset(); });
describe('server emoji use', () => {
  it('renders stable message tokens as local authenticated images and keeps Unicode text', async () => {
    render(<MessageText text={`Hello 😀 <:old_name:${emoji.id}>!`} />);
    const image = await screen.findByRole('img', { name: ':улыбка:' });
    expect(image).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(screen.getByText('Hello 😀')).toBeInTheDocument();
    expect(blobRequest).toHaveBeenCalledWith(`/api/v1/emojis/${emoji.id}/content`);
  });
  it('keeps deleted emoji readable and does not rewrite a token inside a URL', () => {
    useEmojiStore.setState({ emojis: [] });
    const url = `https://example.test/%3C%3Aold_name%3A${emoji.id}%3E`;
    render(<MessageText text={`<:gone:${emoji.id}> ${url}`} />);
    expect(screen.getByText(':gone:')).toBeInTheDocument(); expect(blobRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('link')).toHaveAttribute('href', url);
  });
  it.each(['message', 'reaction'] as const)('inserts the correct stable value in %s mode', async mode => {
    const pick = vi.fn(); render(<EmojiPicker customMode={mode} onPick={pick} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Server emojis' }));
    fireEvent.click(await screen.findByRole('option', { name: ':улыбка:' }));
    expect(pick).toHaveBeenCalledWith(mode === 'message' ? ':улыбка:' : `custom:${emoji.id}`);
  });
  it('does not offer custom emoji to Unicode-only consumers such as profile status', () => {
    render(<EmojiPicker onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.queryByRole('tab', { name: 'Server emojis' })).not.toBeInTheDocument();
  });
  it('shows readable shortcodes when editing and does not read internal identifiers aloud', () => {
    expect(emojiShortcodes(`<:old_name:${emoji.id}>`, [emoji])).toBe(':улыбка:');
    expect(ttsText(`<:old_name:${emoji.id}>`, () => null, 'link')).toBe(':old_name:');
  });
  it('preserves original IDs when an emoji is renamed or its old name is reused while editing', () => {
    const original = `<:old_name:${emoji.id}> original`;
    const draft = createEmojiDraft(original, [{ ...emoji, name: 'smile' }]);
    expect(draft.text).toBe(':smile: original');
    // The draft must keep its captured IDs even if the catalog changes before Save.
    useEmojiStore.setState({ emojis: [{ ...emoji, name: 'grin' }, { ...emoji, id: 'bb05ad72-c596-4f88-9355-b9e51c6dce2e', name: 'smile' }] });
    expect(draft.restore(':smile: edited https://example.test/:smile:')).toBe(`<:old_name:${emoji.id}> edited https://example.test/:smile:`);
  });
  it('keeps server emoji references readable in reply previews', () => {
    const reply = makeMessage({ content: 'A reply', replyTo: { id: 'original', authorId: bob.id, authorName: bob.displayName, content: `<:old_name:${emoji.id}> hello`, deleted: false, hasAttachments: false } });
    const { container } = render(<MessageItem message={reply} grouped={false} isOwn={false} canDelete={false} />);
    expect(container.querySelector('.reply-preview')).toHaveTextContent(':old_name: hello');
    expect(container.querySelector('.reply-preview')).not.toHaveTextContent(emoji.id);
  });
  it('renders custom reactions without exposing opaque IDs, including a deleted fallback', async () => {
    const { rerender } = render(<EmojiGlyph value={`custom:${emoji.id}`} />);
    expect(await screen.findByRole('img', { name: ':улыбка:' })).toBeInTheDocument();
    act(() => useEmojiStore.setState({ emojis: [] })); rerender(<EmojiGlyph value={`custom:${emoji.id}`} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.getByText(':emoji:')).toBeInTheDocument();
  });
  it('retries a transient image failure after the catalog refreshes on reconnect', async () => {
    blobRequest.mockRejectedValueOnce(new Error('Temporary network failure'));
    render(<EmojiGlyph value={`custom:${emoji.id}`} />);
    await waitFor(() => expect(blobRequest).toHaveBeenCalledTimes(1));
    await act(async () => { await useEmojiStore.getState().load(); });
    expect(await screen.findByRole('img', { name: ':улыбка:' })).toBeInTheDocument();
    expect(blobRequest).toHaveBeenCalledTimes(2);
  });
});
describe('emoji role controls and session lifecycle', () => {
  it('hides upload from a normal user and exposes it after the role permission is granted', async () => {
    render(<EmojiSettings guildId={GUILD_ID} />);
    expect(screen.queryByLabelText('Emoji file')).not.toBeInTheDocument();
    await act(() => setGuildPermissions(['CREATE_EMOJIS']));
    expect(screen.getByLabelText('Emoji file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete :улыбка:' })).toBeInTheDocument();
    act(() => useAuthStore.setState({ user: { id: 'bob', role: 'USER' } as never }));
    expect(screen.queryByRole('button', { name: 'Delete :улыбка:' })).not.toBeInTheDocument();
    await act(() => setGuildPermissions(['MANAGE_EMOJIS']));
    expect(screen.getByRole('button', { name: 'Delete :улыбка:' })).toBeInTheDocument();
  });
  it('rejects a large file before an upload request', async () => {
    await setGuildPermissions(['CREATE_EMOJIS']); const create = vi.spyOn(emojisApi, 'create');
    render(<EmojiSettings guildId={GUILD_ID} />);
    fireEvent.change(screen.getByLabelText('Emoji file'), { target: { files: [new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('512'); expect(create).not.toHaveBeenCalled();
  });
  it('does not restore another account catalog from a request that finishes after logout', async () => {
    let resolve: ((value: { emojis: ServerEmoji[] }) => void) | undefined;
    vi.spyOn(emojisApi, 'list').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = useEmojiStore.getState().load(); useEmojiStore.getState().reset(); resolve?.({ emojis: [emoji] }); await pending;
    expect(useEmojiStore.getState().emojis).toEqual([]); expect(useEmojiStore.getState().loaded).toBe(false);
  });
});
