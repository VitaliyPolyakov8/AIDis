import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { alice, general, makeMessage } from '../../test/fixtures';

vi.mock('../../api/gifs', async (importOriginal) => ({ ...(await importOriginal<object>()), gifsApi: { search: vi.fn(), registerShare: vi.fn(), clientProvider: vi.fn(() => null) } }));

const { insertAtCaret, recentEmoji, rememberEmoji, searchEmoji, loadEmoji } = await import('./emoji');
const { MessageEmbeds } = await import('./MessageEmbeds');
const { GifPicker } = await import('./GifPicker');
const { EmojiPicker } = await import('./EmojiPicker');
const { Composer } = await import('./Composer');
const { gifsApi } = await import('../../api/gifs');
const { ApiError } = await import('../../api/errors');
const { useAuthStore } = await import('../../stores/authStore');
const { useChatStore } = await import('../../stores/chatStore');
const { sanitizeSettings } = await import('../../stores/settingsStore');

const gif = {
  provider: 'tenor' as const,
  id: '123',
  url: 'https://tenor.com/view/cat-123',
  title: 'cat',
  media: { url: 'https://media.tenor.com/a/cat.gif', width: 498, height: 280 },
  preview: { url: 'https://media.tenor.com/a/tiny.gif', width: 220, height: 124 },
  previewProxy: '/api/v1/embeds/image?u=p&s=x',
  mediaProxy: '/api/v1/embeds/image?u=m&s=y',
};

describe('emoji', () => {
  beforeEach(() => localStorage.clear());

  it('inserts at the caret (or over a selection), not at the end', () => {
    expect(insertAtCaret('Привет мир', 7, 7, '🙂')).toEqual({ value: 'Привет 🙂мир', caret: 9 });
    expect(insertAtCaret('abcdef', 1, 4, '🎉')).toEqual({ value: 'a🎉ef', caret: 3 });
    expect(insertAtCaret('', 5, 5, '👍')).toEqual({ value: '👍', caret: 2 });
  });

  it('keeps recent emoji per device, newest first, without duplicates', () => {
    rememberEmoji('😀');
    rememberEmoji('🔥');
    rememberEmoji('😀');
    expect(recentEmoji()).toEqual(['😀', '🔥']);
  });

  it('loads Unicode emoji with localized names and searches them', async () => {
    const ru = await loadEmoji('ru');
    expect(ru.length).toBeGreaterThan(1500);
    expect(searchEmoji(ru, 'кот').map((e) => e.unicode)).toContain('🐱');
    const en = await loadEmoji('en');
    expect(searchEmoji(en, 'fire').map((e) => e.unicode)).toContain('🔥');
  });

  it('picker: search and pick (remembered as recent)', async () => {
    const onPick = vi.fn();
    render(<EmojiPicker onPick={onPick} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji' }), { target: { value: 'fire' } });
    const fire = await screen.findByRole('option', { name: 'fire' });
    fireEvent.click(fire);
    expect(onPick).toHaveBeenCalledWith('🔥');
    expect(recentEmoji()[0]).toBe('🔥');
  });
});

describe('composer: emoji at caret, GIF sending', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: alice });
    vi.mocked(gifsApi.search).mockResolvedValue({ enabled: true, provider: 'tenor', results: [gif] });
  });

  it('puts the emoji where the caret is', async () => {
    render(<Composer channel={general} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'ab' } });
    (box as HTMLTextAreaElement).setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji' }), { target: { value: 'fire' } });
    fireEvent.click(await screen.findByRole('option', { name: 'fire' }));
    expect(box).toHaveValue('a🔥b');
  });

  it('sends a picked GIF as its own message with a structured GIF', async () => {
    const send = vi.fn(() => Promise.resolve());
    useChatStore.setState({ sendMessage: send });
    render(<Composer channel={general} />);
    fireEvent.click(screen.getByRole('button', { name: 'GIF' }));
    const option = await screen.findByRole('option', { name: 'cat' });
    expect(option.querySelector('img')?.getAttribute('src')).toContain('/api/v1/embeds/image?u=p');
    fireEvent.click(option);
    expect(send).toHaveBeenCalledWith(general.id, alice, '', [], gif, null);
  });
});

describe('GIF picker states', () => {
  it('explains when GIFs are not configured or the provider is down', async () => {
    vi.mocked(gifsApi.search).mockResolvedValueOnce({ enabled: false, provider: null, results: [] });
    const { unmount } = render(<GifPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/GIFs are not set up yet/)).toBeInTheDocument();
    unmount();
    vi.mocked(gifsApi.search).mockRejectedValueOnce(new Error('503'));
    render(<GifPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('GIF service is temporarily unavailable.')).toBeInTheDocument();
  });

  it('other providers keep the usual placeholder and no KLIPY attribution', async () => {
    vi.mocked(gifsApi.search).mockResolvedValueOnce({ enabled: true, provider: 'giphy', results: [{ ...gif, provider: 'giphy' }] });
    render(<GifPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'cat' });
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Search GIFs');
    expect(screen.getByText('Powered by GIPHY')).toBeInTheDocument();
    expect(screen.queryByText(/KLIPY/)).not.toBeInTheDocument();
  });

  it('shows the rate-limit message from the server', async () => {
    vi.mocked(gifsApi.search).mockRejectedValueOnce(new ApiError('http', 503, 'GIF_RATE_LIMITED', 'GIF service is temporarily unavailable.'));
    render(<GifPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('GIF service is temporarily unavailable. Please try again later.')).toBeInTheDocument();
  });
});

describe('embeds', () => {
  it('renders YouTube, Steam and website cards from plain fields, images through the proxy', () => {
    const embeds =
      makeMessage({
        embeds: [
          {
            type: 'link',
            provider: 'youtube',
            url: 'https://youtu.be/x',
            siteName: 'YouTube',
            title: 'Video',
            description: null,
            author: 'Channel',
            price: null,
            free: false,
            image: { url: '/api/v1/embeds/image?u=yt&s=1', width: 480, height: 360 },
          },
          { type: 'link', provider: 'steam', url: 'https://store.steampowered.com/app/1/', siteName: 'Steam', title: 'Game', description: 'Desc', author: null, price: '1999 руб.', free: false, image: null },
          { type: 'link', provider: 'website', url: 'https://blog.example/a', siteName: 'blog.example', title: '<b>Post</b>', description: 'Text', author: null, price: null, free: false, image: null },
        ],
      }).embeds ?? [];
    const { container } = render(<MessageEmbeds embeds={embeds} />);
    expect(screen.getByRole('link', { name: 'Video' })).toHaveAttribute('href', 'https://youtu.be/x');
    expect(container.querySelector('.embed-card.is-youtube img')?.getAttribute('src')).toMatch(/\/api\/v1\/embeds\/image\?u=yt/);
    expect(screen.getByText('1999 руб.')).toBeInTheDocument();
    // Text is text: no HTML from sites is ever rendered.
    expect(screen.getByRole('link', { name: '<b>Post</b>' })).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('GIF keeps its aspect ratio within 300 px and waits for a click with reduced motion', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      render(
        <MessageEmbeds embeds={[{ type: 'gif', provider: 'tenor', id: '1', url: 'https://tenor.com/view/1', title: 'cat', media: { url: '/api/v1/embeds/image?u=m&s=1', width: 600, height: 300 }, preview: null }]} />,
      );
      const paused = screen.getByRole('button', { name: 'Play GIF' });
      expect(paused).toHaveStyle({ width: '300px', height: '150px' });
      fireEvent.click(paused);
      expect(screen.getByRole('img', { name: 'cat' })).toHaveAttribute('loading', 'lazy');
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('noise suppression setting', () => {
  it('migrates the old on/off switch and keeps valid modes', () => {
    expect(sanitizeSettings({ noiseSuppression: false }).noiseSuppressionMode).toBe('off');
    expect(sanitizeSettings({}).noiseSuppressionMode).toBe('standard');
    expect(sanitizeSettings({ noiseSuppressionMode: 'strong' }).noiseSuppressionMode).toBe('strong');
    expect(sanitizeSettings({ noiseSuppressionMode: 'max' as never }).noiseSuppressionMode).toBe('standard');
  });
});

describe('live link previews', () => {
  it('a message.updated with embeds replaces the message (preview arrives after sending)', async () => {
    const message = makeMessage({ content: 'see https://blog.example/a' });
    useChatStore.setState({ channels: [general], byChannel: { [general.id]: { messages: [message], hasMore: false, hasNewer: false, loadingNewer: false, status: 'ready', loadingOlder: false, error: null } } });
    act(() => {
      useChatStore
        .getState()
        .applyUpdated({
          ...message,
          embeds: [{ type: 'link', provider: 'website', url: 'https://blog.example/a', siteName: 'blog', title: 'Post', description: null, author: null, price: null, free: false, image: null }],
        });
    });
    await waitFor(() => expect(useChatStore.getState().byChannel[general.id]?.messages[0]?.embeds).toHaveLength(1));
  });
});
