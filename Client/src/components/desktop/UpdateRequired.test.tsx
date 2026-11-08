import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../session', () => ({ startSession: vi.fn(() => Promise.resolve()), endSession: vi.fn() }));

const { AppShell } = await import('../../pages/AppShell');
const { useUiStore } = await import('../../stores/uiStore');
const { useAuthStore } = await import('../../stores/authStore');
const { alice } = await import('../../test/fixtures');

describe('0.7.0 mandatory update', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'authenticated', user: alice });
  });

  it('replaces the whole app with the update screen, which cannot be closed', async () => {
    useUiStore.setState({ updateRequired: true });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<p>Inside the app</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'AIDis needs to be updated' })).toBeInTheDocument();
    expect(screen.queryByText('Inside the app')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    useUiStore.setState({ updateRequired: false });
  });
});
