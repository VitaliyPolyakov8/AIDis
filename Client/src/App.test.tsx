import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { RequireAuth } from './App';
import { useAuthStore } from './stores/authStore';
import { alice } from './test/fixtures';

function renderProtected() {
  return render(
    <MemoryRouter initialEntries={['/channels/x']}>
      <Routes>
        <Route path="/login" element={<p>Login screen</p>} />
        <Route
          path="/channels/:id"
          element={
            <RequireAuth>
              <p>Secret chat</p>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('protected routes', () => {
  it('redirects to /login when unauthenticated', () => {
    useAuthStore.setState({ status: 'unauthenticated', user: null });
    renderProtected();
    expect(screen.getByText('Login screen')).toBeInTheDocument();
    expect(screen.queryByText('Secret chat')).not.toBeInTheDocument();
  });

  it('shows a loading screen while the session is being restored', () => {
    useAuthStore.setState({ status: 'unknown', user: null });
    renderProtected();
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your session');
  });

  it('renders the page when authenticated', () => {
    useAuthStore.setState({ status: 'authenticated', user: alice });
    renderProtected();
    expect(screen.getByText('Secret chat')).toBeInTheDocument();
  });

  it('offers a retry instead of logging out when the server is unreachable', () => {
    useAuthStore.setState({ status: 'offline', user: null });
    renderProtected();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
