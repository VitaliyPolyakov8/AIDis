import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SetupGate } from './SetupPage';
import { setupApi } from '../api/setup';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/authStore';
import { alice, tokenPair } from '../test/fixtures';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SetupGate>
        <Routes>
          <Route path="/login" element={<p>Login page</p>} />
          <Route path="/channels/:guildId" element={<p>Server page</p>} />
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
      </SetupGate>
    </MemoryRouter>,
  );
}

async function fillAll(code = 'Kq7mPz3xWv9rTb2nHs8dLc4f') {
  await userEvent.type(await screen.findByLabelText('Setup code'), code);
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.type(screen.getByLabelText('Username'), 'alice');
  await userEvent.type(screen.getByLabelText('Password'), 'alice-password-1');
  await userEvent.type(screen.getByLabelText('Repeat the password'), 'alice-password-1');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.type(screen.getByLabelText('Server name'), 'Our place');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(screen.getByRole('radio', { name: 'By invite' }));
  await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
}

describe('first-run wizard (browser)', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'unauthenticated', user: null, notice: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the wizard on any address while setup is needed', async () => {
    vi.spyOn(setupApi, 'status').mockResolvedValue({ needed: true });
    renderAt('/login');
    expect(await screen.findByText('Set up AIDis')).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('gets out of the way when setup is done or the server is older', async () => {
    vi.spyOn(setupApi, 'status').mockResolvedValue({ needed: false });
    const done = renderAt('/login');
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    done.unmount();
    vi.spyOn(setupApi, 'status').mockRejectedValue(new ApiError('http', 404, 'NOT_FOUND', 'no route'));
    renderAt('/login');
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('takes the code from ?code=, creates the administrator and shows the invite link', async () => {
    vi.spyOn(setupApi, 'status').mockResolvedValue({ needed: true });
    const complete = vi.spyOn(setupApi, 'complete').mockResolvedValue({ ...tokenPair(1), user: { ...alice, role: 'ADMIN' }, guildId: 'g1', inviteCode: 'abcd2345' });
    renderAt('/setup?code=Kq7mPz3xWv9rTb2nHs8dLc4f');
    expect(await screen.findByLabelText('Setup code')).toHaveValue('Kq7mPz3xWv9rTb2nHs8dLc4f');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'alice-password-1');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'alice-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Server name'), 'Our place');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: 'By invite' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('AIDis is ready')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\/invite\/abcd2345$/)).toBeInTheDocument();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ code: 'Kq7mPz3xWv9rTb2nHs8dLc4f', username: 'alice', displayName: 'alice', guildName: 'Our place', registrationMode: 'invite' }));
    expect(useAuthStore.getState().status).toBe('authenticated');
    await userEvent.click(screen.getByRole('button', { name: 'Open AIDis' }));
    expect(await screen.findByText('Server page')).toBeInTheDocument();
  });

  it('checks the passwords before sending and shows a wrong code as text', async () => {
    vi.spyOn(setupApi, 'status').mockResolvedValue({ needed: true });
    vi.spyOn(setupApi, 'complete').mockRejectedValue(new ApiError('http', 403, 'SETUP_CODE_INVALID', 'raw'));
    renderAt('/');
    await userEvent.type(await screen.findByLabelText('Setup code'), 'wrong-code-wrong-code-000');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'alice-password-1');
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'other-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Repeat the password'));
    await userEvent.type(screen.getByLabelText('Repeat the password'), 'alice-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Server name'), 'Our place');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText(/setup code is wrong/i)).toBeInTheDocument();
  });

  it('fills everything through the helper (smoke)', async () => {
    vi.spyOn(setupApi, 'status').mockResolvedValue({ needed: true });
    vi.spyOn(setupApi, 'complete').mockResolvedValue({ ...tokenPair(2), user: { ...alice, role: 'ADMIN' }, guildId: 'g1', inviteCode: 'zz99yy88' });
    renderAt('/');
    await fillAll();
    expect(await screen.findByText('AIDis is ready')).toBeInTheDocument();
  });
});
