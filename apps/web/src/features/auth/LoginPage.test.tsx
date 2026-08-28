import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import { LoginPage } from './LoginPage';

vi.mock('../../lib/api/auth');

function renderLoginRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/inbox" element={<div>Inbox landing</div>} />
    </Routes>,
    { route: '/login' },
  );
}

describe('LoginPage', () => {
  it('shows the form once the session check resolves to unauthenticated', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));

    renderLoginRoute();

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  // 1. Login success
  it('navigates to the inbox after a successful login', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));
    vi.mocked(authApi.login).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });

    renderLoginRoute();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'demo@clinic.test');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Inbox landing')).toBeInTheDocument();
    expect(authApi.login).toHaveBeenCalledWith('demo@clinic.test', 'correct-password');
  });

  // 2. Login failure
  it('shows a generic, user-friendly error on invalid credentials and stays on the login form', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));
    vi.mocked(authApi.login).mockRejectedValue(new ApiError(401, 'Invalid email or password.'));

    renderLoginRoute();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'demo@clinic.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not sign in/i);
    // Never the raw backend message concatenated with anything token-shaped, and still on the form.
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('shows a distinct message for a network failure', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));
    vi.mocked(authApi.login).mockRejectedValue(new ApiError(0, 'Could not reach the server. Check your connection and try again.'));

    renderLoginRoute();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'demo@clinic.test');
    await user.type(screen.getByLabelText('Password'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
  });

  it('never renders the session token anywhere, even after a successful login', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));
    vi.mocked(authApi.login).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });

    renderLoginRoute();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'demo@clinic.test');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByText('Inbox landing')).toBeInTheDocument());
    expect(document.body.innerHTML).not.toMatch(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  });
});
