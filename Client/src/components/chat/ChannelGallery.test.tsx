import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { general, games } from '../../test/fixtures';
import { i18next } from '../../i18n';

vi.mock('../../api/gallery', () => ({ galleryApi: { list: vi.fn() } }));
const { galleryApi } = await import('../../api/gallery');
const { ChannelGalleryButton } = await import('./ChannelGallery');
const list = vi.mocked(galleryApi.list);
const link = (id: string, href: string) => ({ id, messageId: id, authorName: 'Alice', createdAt: '2026-10-01T12:00:00Z', links: [href] });

describe('channel gallery', () => {
  beforeEach(() => { list.mockReset(); });
  afterEach(() => { void i18next.changeLanguage('en'); });

  it('opens from the header, switches categories and appends older pages with safe links', async () => {
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<MemoryRouter><ChannelGalleryButton channel={general} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Channel files' }));
    expect(await screen.findByText('No files or links here yet.')).toBeInTheDocument();
    list.mockResolvedValueOnce({ items: [link('new', 'https://example.com/new')], nextCursor: 'older' });
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }));
    expect(await screen.findByRole('link', { name: 'https://example.com/new' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    list.mockResolvedValueOnce({ items: [link('old', 'https://example.com/old')], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByRole('link', { name: 'https://example.com/old' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'https://example.com/new' })).toBeInTheDocument();
    expect(list.mock.calls[2]?.slice(0, 3)).toEqual([general.id, 'links', 'older']);
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
  });

  it('ignores late responses from another category and closes on channel change', async () => {
    let finish!: (value: { items: ReturnType<typeof link>[]; nextCursor: null }) => void;
    list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<MemoryRouter><ChannelGalleryButton channel={general} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Channel files' }));
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    await act(async () => finish({ items: [link('late', 'https://late.example')], nextCursor: null }));
    expect(screen.queryByRole('link', { name: 'https://late.example' })).not.toBeInTheDocument();
    expect(list.mock.calls[0]?.[3]?.aborted).toBe(true);
    view.rerender(<MemoryRouter><ChannelGalleryButton channel={games} /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retries failed loads and offers continuation for an empty sparse link page', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    render(<MemoryRouter><ChannelGalleryButton channel={general} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Channel files' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    list.mockResolvedValueOnce({ items: [], nextCursor: 'continue' });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load older' })).toBeEnabled());
    expect(screen.queryByText('No files or links here yet.')).not.toBeInTheDocument();
  });

  it('changes UI language without reloading and duplicating the current page', async () => {
    list.mockResolvedValue({ items: [link('same', 'https://example.com/same')], nextCursor: null });
    render(<MemoryRouter><ChannelGalleryButton channel={general} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Channel files' }));
    await screen.findByRole('link', { name: 'https://example.com/same' });
    await act(async () => { await i18next.changeLanguage('ru'); });
    expect(screen.getAllByRole('link', { name: 'https://example.com/same' })).toHaveLength(1);
  });
});
