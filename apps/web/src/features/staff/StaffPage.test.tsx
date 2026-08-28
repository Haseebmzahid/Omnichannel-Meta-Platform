import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import * as staffApi from '../../lib/api/staff';
import type { Staff, StaffSummary } from '../../lib/api/types';
import { StaffPage } from './StaffPage';

vi.mock('../../lib/api/auth');
vi.mock('../../lib/api/staff');

function currentStaff(role: StaffSummary['role'] = 'ADMIN'): StaffSummary {
  return { id: 'staff-me', name: 'Dr. Amina', email: 'amina@clinic.test', role, clinicId: 'clinic-1' };
}

function staffMember(overrides: Partial<Staff> = {}): Staff {
  return {
    id: 'staff-1',
    name: 'Bilal Tariq',
    email: 'bilal@clinic.test',
    role: 'AGENT',
    status: 'ACTIVE',
    clinicId: 'clinic-1',
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('StaffPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Staff list renders
  it('renders the staff list with name, email, role, and status', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([staffMember()]);

    renderWithProviders(<StaffPage />);

    expect(await screen.findByText('Bilal Tariq')).toBeInTheDocument();
    expect(screen.getByText('bilal@clinic.test')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1 staff member')).toBeInTheDocument();
  });

  // 2. Loading state
  it('shows a loading state before staff arrive', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<StaffPage />);

    expect(await screen.findByText('Loading staff…')).toBeInTheDocument();
    expect(screen.queryByText('Bilal Tariq')).not.toBeInTheDocument();
  });

  // 3. Empty state
  it('shows an empty state when there is no staff', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([]);

    renderWithProviders(<StaffPage />);

    expect(await screen.findByText('No staff members yet')).toBeInTheDocument();
  });

  // 4. Staff creation, plus 10. clinicId is never sent by the frontend
  it('creates a staff member without sending a clinicId', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([]);
    vi.mocked(staffApi.createStaff).mockResolvedValue(
      staffMember({ id: 'staff-2', name: 'Nadia Khan', email: 'nadia@clinic.test', role: 'MANAGER' }),
    );

    const user = userEvent.setup();
    renderWithProviders(<StaffPage />);

    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    await user.type(screen.getByLabelText('Name'), 'Nadia Khan');
    await user.type(screen.getByLabelText('Email'), 'nadia@clinic.test');
    await user.type(screen.getByLabelText('Initial password'), 'supersecret1');
    await user.selectOptions(screen.getByLabelText('Role'), 'MANAGER');
    await user.click(screen.getByRole('button', { name: 'Create staff member' }));

    await waitFor(() =>
      expect(staffApi.createStaff).toHaveBeenCalledWith({
        name: 'Nadia Khan',
        email: 'nadia@clinic.test',
        password: 'supersecret1',
        role: 'MANAGER',
      }),
    );

    const sentPayload = vi.mocked(staffApi.createStaff).mock.calls[0]![0];
    expect(sentPayload).not.toHaveProperty('clinicId');

    expect(await screen.findByText('Nadia Khan was created.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // 5. Invalid create form
  it('rejects an invalid create form without calling the API', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([]);

    const user = userEvent.setup();
    renderWithProviders(<StaffPage />);

    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    await user.click(screen.getByRole('button', { name: 'Create staff member' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required.');
    expect(staffApi.createStaff).not.toHaveBeenCalled();
  });

  // 6. Disable action
  it('disables a staff member after confirmation', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([staffMember()]);
    vi.mocked(staffApi.updateStaffStatus).mockResolvedValue(staffMember({ status: 'DISABLED' }));

    const user = userEvent.setup();
    renderWithProviders(<StaffPage />);

    await user.click(await screen.findByRole('button', { name: 'Disable Bilal Tariq' }));
    expect(screen.getByText('Disable Bilal Tariq?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(staffApi.updateStaffStatus).toHaveBeenCalledWith('staff-1', 'DISABLED'));
    expect(await screen.findByText('Bilal Tariq was disabled.')).toBeInTheDocument();
  });

  // 7. Reset-password action
  it("resets a staff member's password", async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([staffMember()]);
    vi.mocked(staffApi.updateStaffPassword).mockResolvedValue(staffMember());

    const user = userEvent.setup();
    renderWithProviders(<StaffPage />);

    await user.click(await screen.findByRole('button', { name: 'Reset password for Bilal Tariq' }));
    await user.type(screen.getByLabelText('New password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => expect(staffApi.updateStaffPassword).toHaveBeenCalledWith('staff-1', 'newpassword1'));
    expect(await screen.findByText('Password reset for Bilal Tariq.')).toBeInTheDocument();
  });

  // 8. Mutation error handling
  it('surfaces a mutation error when creating a staff member fails', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(staffApi.listStaff).mockResolvedValue([]);
    vi.mocked(staffApi.createStaff).mockRejectedValue(new ApiError(409, 'A staff member with this email already exists for this clinic.'));

    const user = userEvent.setup();
    renderWithProviders(<StaffPage />);

    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    await user.type(screen.getByLabelText('Name'), 'Nadia Khan');
    await user.type(screen.getByLabelText('Email'), 'nadia@clinic.test');
    await user.type(screen.getByLabelText('Initial password'), 'supersecret1');
    await user.click(screen.getByRole('button', { name: 'Create staff member' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A staff member with this email already exists for this clinic.');
  });

  // 9. READ_ONLY does not receive mutation controls
  it('hides mutation controls for a READ_ONLY staff member', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('READ_ONLY'));
    vi.mocked(staffApi.listStaff).mockResolvedValue([staffMember()]);

    renderWithProviders(<StaffPage />);

    expect(await screen.findByText('Bilal Tariq')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset password/ })).not.toBeInTheDocument();
  });
});
