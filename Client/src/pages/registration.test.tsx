import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { VerifyEmailPage } from './VerifyEmailPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import { registrationApi } from '../api/registration';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/authStore';
import { alice } from '../test/fixtures';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/" element={<p>Main app</p>} />
        <Route path="/channels/:guildId/:channelId" element={<p>Server channel</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('0.7.1 registration pages', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'unauthenticated', user: null, notice: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the login page offers sign-up only while registration is on', async () => {
    vi.spyOn(registrationApi, 'state').mockResolvedValue({ mode: 'off', mail: true });
    const off = renderAt('/login');
    expect(await screen.findByText('Forgot your password?')).toBeInTheDocument();
    expect(screen.queryByText('Sign up')).not.toBeInTheDocument();
    off.unmount();

    vi.spyOn(registrationApi, 'state').mockResolvedValue({ mode: 'open', mail: true });
    renderAt('/login');
    expect(await screen.findByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
  });

  it('"Forgot your password?" needs working mail', async () => {
    const state = vi.spyOn(registrationApi, 'state').mockResolvedValue({ mode: 'open', mail: false });
    renderAt('/login');
    await waitFor(() => expect(state).toHaveBeenCalled());
    expect(await screen.findByRole('link', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByText('Forgot your password?')).not.toBeInTheDocument();
  });

  it('after sending the form shows "Check your e-mail"', async () => {
    vi.spyOn(registrationApi, 'state').mockResolvedValue({ mode: 'open', mail: true });
    const register = vi.spyOn(registrationApi, 'register').mockResolvedValue({ ok: true });
    renderAt('/register');
    await userEvent.type(await screen.findByLabelText('Username'), 'newbie');
    await userEvent.type(screen.getByLabelText('E-mail'), 'newbie@example.org');
    await userEvent.type(screen.getByLabelText('Password'), 'newbie-password-1');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'newbie-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Check your e-mail')).toBeInTheDocument();
    expect(screen.getByText(/newbie@example\.org/)).toBeInTheDocument();
    expect(register).toHaveBeenCalledWith({ username: 'newbie', displayName: 'newbie', email: 'newbie@example.org', password: 'newbie-password-1', inviteCode: undefined });
  });

  it('the register form checks the passwords match before sending', async () => {
    vi.spyOn(registrationApi, 'state').mockResolvedValue({ mode: 'open', mail: true });
    const register = vi.spyOn(registrationApi, 'register');
    renderAt('/register');
    await userEvent.type(await screen.findByLabelText('Username'), 'newbie');
    await userEvent.type(screen.getByLabelText('E-mail'), 'newbie@example.org');
    await userEvent.type(screen.getByLabelText('Password'), 'newbie-password-1');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'other-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('/verify?token=x confirms the e-mail and logs in on the server of the invite', async () => {
    const verify = vi.spyOn(registrationApi, 'verifyEmail').mockResolvedValue({
      accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'r.r',
      refreshTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: 'Bearer',
      sessionId: 's1',
      user: alice,
      guildId: 'g1',
      channelId: 'c1',
    });
    renderAt('/verify?token=x');
    expect(await screen.findByText('Server channel')).toBeInTheDocument();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('x');
    expect(useAuthStore.getState()).toMatchObject({ status: 'authenticated', sessionId: 's1' });
  });

  it('shows TOKEN_INVALID as text', async () => {
    vi.spyOn(registrationApi, 'verifyEmail').mockRejectedValue(new ApiError('http', 400, 'TOKEN_INVALID', 'raw'));
    renderAt('/verify?token=old');
    expect(await screen.findByText('This link is invalid, already used or expired.')).toBeInTheDocument();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('a reset link sets a new password once and says to log in again', async () => {
    const confirm = vi.spyOn(registrationApi, 'confirmReset').mockResolvedValue(undefined);
    renderAt('/reset-password?token=tok');
    await userEvent.type(screen.getByLabelText('New password'), 'brand-new-password-1');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'brand-new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save the password' }));
    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('tok', 'brand-new-password-1');
  });
});
