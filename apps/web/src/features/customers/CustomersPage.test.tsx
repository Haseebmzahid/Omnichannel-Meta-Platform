import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import * as customersApi from '../../lib/api/customers';
import type { StaffSummary } from '../../lib/api/types';
import { CustomersPage } from './CustomersPage';

vi.mock('../../lib/api/auth');
vi.mock('../../lib/api/customers');

function currentStaff(role: StaffSummary['role'] = 'ADMIN'): StaffSummary {
  return { id: 'staff-me', name: 'Dr. Amina', email: 'amina@clinic.test', role, clinicId: 'clinic-1' };
}

describe('CustomersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the export action', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('exports customers and shows a success message', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.exportCustomersCsv).mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(customersApi.exportCustomersCsv).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Customer export downloaded.')).toBeInTheDocument();
  });

  it('shows an error message when the export fails, without crashing', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.exportCustomersCsv).mockRejectedValue(new ApiError(500, 'Could not export customers.'));
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not export customers.');
  });

  it('clears a previous error once a retried export succeeds', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.exportCustomersCsv).mockRejectedValueOnce(new ApiError(500, 'Could not export customers.')).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    await user.click(exportButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not export customers.');

    await user.click(exportButton);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText('Customer export downloaded.')).toBeInTheDocument();
  });

  it('is available to a READ_ONLY staff member — exporting is a read, not a mutation', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('READ_ONLY'));

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });
});
