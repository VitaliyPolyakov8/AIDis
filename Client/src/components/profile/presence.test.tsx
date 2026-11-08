import { asServerMembers } from '../../test/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

/** Member rows and the profile card can open DMs, which needs a router. */
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
import { alice, bob } from '../../test/fixtures';

vi.mock('../../api/users', () => ({
  usersApi: {
    getStatus: vi.fn(() => Promise.resolve({ status: 'ONLINE', customStatus: null })),
    setStatus: vi.fn((input: { status?: string; customStatus?: unknown }) => Promise.resolve({ status: input.status ?? 'ONLINE', customStatus: input.customStatus ?? null })),
    get: vi.fn(),
  },
}));

const { MembersSidebar } = await import('../MembersSidebar');
const { ProfilePopoutHost } = await import('./ProfilePopout');
const { StatusMenu } = await import('./StatusMenu');
const { usersApi } = await import('../../api/users');
const { usePresenceStore } = await import('../../stores/presenceStore');
const { useAuthStore } = await import('../../stores/authStore');
const { useStatusStore } = await import('../../stores/statusStore');
const { presenceState, customStatusExpiresAt, activeCustomStatus } = await import('../../utils/presence');

describe('presence helpers', () => {
  it('reads the new state and falls back to online/offline from a 0.2.x server', () => {
    expect(presenceState({ userId: 'x', status: 'online', state: 'dnd', lastSeenAt: null })).toBe('dnd');
    expect(presenceState({ userId: 'x', status: 'online', lastSeenAt: null })).toBe('online');
    expect(presenceState(undefined)).toBe('offline');
  });

  it('computes custom status expiry and hides expired ones', () => {
    const now = new Date('2026-10-06T10:00:00');
    expect(customStatusExpiresAt('never', now)).toBeNull();
    expect(new Date(customStatusExpiresAt('1h', now) ?? '').getTime() - now.getTime()).toBe(3_600_000);
    expect(new Date(customStatusExpiresAt('today', now) ?? '').getHours()).toBe(23);
    expect(activeCustomStatus({ customStatus: { text: 'x', expiresAt: '2000-01-01T00:00:00Z' } })).toBeNull();
  });
});

describe('members and profile card', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: alice });
    usePresenceStore.setState({
      users: { [alice.id]: alice, [bob.id]: bob, carol: { ...bob, id: 'carol', username: 'carol', displayName: 'Carol' } },
      presence: {
        [bob.id]: {
          userId: bob.id,
          status: 'online',
          state: 'away',
          lastSeenAt: null,
          customStatus: { text: 'Пошёл есть', expiresAt: null },
          activity: { type: 'playing', name: 'Helldivers 2' },
        },
        carol: { userId: 'carol', status: 'offline', state: 'offline', lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), customStatus: null, activity: null },
      },
      loaded: true,
    });
  });

  it('shows status, activity and last seen in the member list', async () => {
    await asServerMembers();
    render(<MembersSidebar />);
    const bobRow = screen.getByRole('button', { name: /^Bob/ });
    // 0.4.6: the gamepad icon says "playing"; the line shows the full game name, the tooltip the whole phrase.
    expect(bobRow).toHaveTextContent('Helldivers 2');
    expect(bobRow.querySelector('.activity-pill')).toHaveAttribute('title', 'Playing Helldivers 2');
    // 0.4.7: the game has its own row across the whole button, not inside the name column.
    const activityRow = bobRow.querySelector(':scope > .member-activity');
    expect(activityRow).not.toBeNull();
    expect(bobRow.querySelector('.member-text .activity-pill')).toBeNull();
    expect(activityRow).toHaveTextContent('Playing Helldivers 2');
    expect(bobRow.querySelector('.presence-dot.is-away')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Carol/ })).toHaveTextContent('5');
  });

  it('opens a compact profile with presence, custom status, activity and role', async () => {
    await asServerMembers();
    render(
      <>
        <MembersSidebar />
        <ProfilePopoutHost />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Bob/ }));
    const card = screen.getByRole('dialog', { name: 'Bob' });
    expect(card).toHaveTextContent('@bob');
    expect(card).toHaveTextContent('Away');
    expect(card).toHaveTextContent('Пошёл есть');
    expect(card).toHaveTextContent('Playing now');
    expect(card).toHaveTextContent('Helldivers 2');
    expect(card).not.toHaveTextContent('Last seen');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Carol/ }));
    const offline = screen.getByRole('dialog', { name: 'Carol' });
    expect(offline).toHaveTextContent('Offline');
    expect(within(offline).getByText(/5/)).toBeInTheDocument();
  });
});

describe('status menu', () => {
  let notifyResize: () => void;

  beforeEach(() => {
    useStatusStore.setState({ status: 'ONLINE', customStatus: null, supported: true });
    vi.mocked(usersApi.setStatus).mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the expanded custom status form above its anchor without losing input focus', () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 240, height: this.querySelector('form') ? 500 : 300 } as DOMRect;
    });
    const onClose = vi.fn();
    render(<StatusMenu x={20} y={700} onClose={onClose} />);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ top: '400px' });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Set a custom status' }));
    act(() => notifyResize?.());
    expect(menu).toHaveStyle({ top: '200px' });
    expect(screen.getByRole('textbox', { name: 'Custom status' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => notifyResize?.());
    expect(menu).toHaveStyle({ top: '400px' });
  });

  it('keeps outside click and Escape dismissal while the form is expanded', () => {
    const onClose = vi.fn();
    render(<StatusMenu x={20} y={700} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set a custom status' }));
    fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Custom status' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('sets Do Not Disturb and a custom status with an expiry', async () => {
    const onClose = vi.fn();
    render(<StatusMenu x={10} y={10} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Do Not Disturb/ }));
    });
    expect(usersApi.setStatus).toHaveBeenCalledWith({ status: 'DND' });
    expect(useStatusStore.getState().status).toBe('DND');
    expect(onClose).toHaveBeenCalled();
  });

  it('saves and clears a custom status', async () => {
    render(<StatusMenu x={10} y={10} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set a custom status' }));
    fireEvent.change(screen.getByLabelText('Custom status'), { target: { value: 'Работаю' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1h' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    const call = vi.mocked(usersApi.setStatus).mock.calls.at(-1)?.[0] as { customStatus: { text: string; expiresAt: string } };
    expect(call.customStatus.text).toBe('Работаю');
    expect(new Date(call.customStatus.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear custom status' }));
    });
    expect(vi.mocked(usersApi.setStatus).mock.calls.at(-1)?.[0]).toEqual({ customStatus: null });
  });
});
