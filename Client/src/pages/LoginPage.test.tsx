import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '../stores/authStore';
import { ApiError } from '../api/errors';
import { alice } from '../test/fixtures';
import { savePendingInvite, takePendingInvite } from '../components/guilds/inviteLinks';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>Main app</p>} />
        <Route path="/invite/:code" element={<p>Invite page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'unauthenticated', user: null, notice: null });
    sessionStorage.clear();
  });

  it('0.7.0: after logging in, an invite opened before login is shown', () => {
    savePendingInvite('abcd2345');
    useAuthStore.setState({ status: 'authenticated', user: alice });
    renderLogin();
    expect(screen.getByText('Invite page')).toBeInTheDocument();
    expect(takePendingInvite()).toBeNull();
  });

  it('has no registration or recovery links', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText(/sign up|create account|forgot/i)).not.toBeInTheDocument();
  });

  it('validates empty fields without calling the server', async () => {
    const login = vi.fn();
    useAuthStore.setState({ login });
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByText('Enter your username.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, 'Incorrect username or password.'],
    ['ACCOUNT_DISABLED', 403, 'This account has been disabled. Contact the administrator.'],
    ['RATE_LIMITED', 429, 'Too many attempts. Please wait a minute and try again.'],
  ])('shows a friendly message for %s', async (code, status, text) => {
    useAuthStore.setState({ login: vi.fn().mockRejectedValue(new ApiError('http', status, code, 'raw server text')) });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('shows a network error', async () => {
    useAuthStore.setState({ login: vi.fn().mockRejectedValueOnce(ApiError.network()) });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server");
  });

  it('shows a server-unavailable error', async () => {
    useAuthStore.setState({ login: vi.fn().mockRejectedValueOnce(new ApiError('http', 502, 'SERVER_UNAVAILABLE', 'HTTP 502')) });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
  });

  it('logs in with trimmed username and the remember flag, then redirects', async () => {
    const login = vi.fn().mockImplementation(() => {
      useAuthStore.setState({ status: 'authenticated', user: alice });
      return Promise.resolve();
    });
    useAuthStore.setState({ login });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), '  alice ');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByLabelText('Keep me logged in on this device'));
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(login).toHaveBeenCalledWith('alice', 'correct horse', false);
    expect(await screen.findByText('Main app')).toBeInTheDocument();
  });
});
