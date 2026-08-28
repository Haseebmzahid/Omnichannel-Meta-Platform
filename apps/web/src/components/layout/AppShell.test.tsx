import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import * as authApi from '../../lib/api/auth';
import { AppShell } from './AppShell';

vi.mock('../../lib/api/auth');

function renderShell() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<div>Login screen</div>} />
      <Route element={<AppShell />}>
        <Route path="/inbox" element={<div>Inbox content</div>} />
      </Route>
    </Routes>,
    { route: '/inbox' },
  );
}

describe('AppShell', () => {
  it('renders the sidebar with Inbox, Staff, and Knowledge navigation', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });

    renderShell();

    expect(await screen.findByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Knowledge' })).toBeInTheDocument();
  });

  it("shows the authenticated staff member's name and role", async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'MANAGER', clinicId: 'c1' });

    renderShell();

    expect(await screen.findByText('Dr. Amina')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toBeInTheDocument();
  });

  // 6. Logout
  it('logs out by calling the backend, then returns to the login screen', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue({ id: 's1', name: 'Dr. Amina', email: 'demo@clinic.test', role: 'AGENT', clinicId: 'c1' });
    vi.mocked(authApi.logout).mockResolvedValue(undefined);

    renderShell();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Log out' }));

    expect(authApi.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
  });
});
