import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import type { StaffSummary } from '../../lib/api/types';
import { RequireAuth } from './RequireAuth';

vi.mock('../../lib/api/auth');

function renderProtectedRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<div>Login screen</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/inbox" element={<div>Protected inbox</div>} />
      </Route>
    </Routes>,
    { route: '/inbox' },
  );
}

describe('RequireAuth', () => {
  // 3. Unauthenticated redirect
  it('redirects to /login when there is no valid session', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockRejectedValue(new ApiError(401, 'Authentication required.'));

    renderProtectedRoute();

    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(screen.queryByText('Protected inbox')).not.toBeInTheDocument();
  });

  it('renders the protected route once a valid session is confirmed', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });

    renderProtectedRoute();

    expect(await screen.findByText('Protected inbox')).toBeInTheDocument();
  });

  it('shows a loading state while the session check is in flight, never a flash of the protected content', async () => {
    let resolveStaff!: (value: StaffSummary) => void;
    vi.mocked(authApi.fetchCurrentStaff).mockReturnValue(new Promise<StaffSummary>((resolve) => (resolveStaff = resolve)));

    renderProtectedRoute();

    expect(screen.queryByText('Protected inbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();

    resolveStaff({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });
    expect(await screen.findByText('Protected inbox')).toBeInTheDocument();
  });
});
