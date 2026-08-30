import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import * as customersApi from '../../lib/api/customers';
import type { Customer, StaffSummary } from '../../lib/api/types';
import { CustomersPage } from './CustomersPage';

vi.mock('../../lib/api/auth');
vi.mock('../../lib/api/customers');

function currentStaff(role: StaffSummary['role'] = 'ADMIN'): StaffSummary {
  return { id: 'staff-me', name: 'Dr. Amina', email: 'amina@clinic.test', role, clinicId: 'clinic-1' };
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    name: 'Fatima Noor',
    phone: '+15550001111',
    email: 'fatima@example.test',
    channels: ['WHATSAPP'],
    firstInteraction: '2026-01-01T00:00:00.000Z',
    lastInteraction: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('CustomersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- list, available to every role ----------------------------------

  it('renders the customer list', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.listCustomers).mockResolvedValue([customer()]);

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByText('Fatima Noor')).toBeInTheDocument();
    expect(screen.getByText('+15550001111')).toBeInTheDocument();
    expect(screen.getByText('WHATSAPP')).toBeInTheDocument();
  });

  it('shows an empty state when there are no customers', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.listCustomers).mockResolvedValue([]);

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
  });

  it('shows a retryable error state when the list fails to load', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(customersApi.listCustomers).mockRejectedValue(new ApiError(500, 'Could not load customers.'));

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it.each(['MANAGER', 'AGENT', 'READ_ONLY'] as const)('%s staff can view the customer list', async (role) => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff(role));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([customer()]);

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByText('Fatima Noor')).toBeInTheDocument();
  });

  // --- export, ADMIN-only (client-confirmed production role hardening) ---

  it('shows the export action to ADMIN', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('ADMIN'));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([]);

    renderWithProviders(<CustomersPage />);

    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('exports customers and shows a success message', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('ADMIN'));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([]);
    vi.mocked(customersApi.exportCustomersCsv).mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(customersApi.exportCustomersCsv).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Customer export downloaded.')).toBeInTheDocument();
  });

  it('shows an error message when the export fails, without crashing', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('ADMIN'));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([]);
    vi.mocked(customersApi.exportCustomersCsv).mockRejectedValue(new ApiError(500, 'Could not export customers.'));
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not export customers.');
  });

  it('clears a previous error once a retried export succeeds', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('ADMIN'));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([]);
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

  it.each(['MANAGER', 'AGENT', 'READ_ONLY'] as const)('hides the export action from %s staff — export is ADMIN-only', async (role) => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff(role));
    vi.mocked(customersApi.listCustomers).mockResolvedValue([customer()]);

    renderWithProviders(<CustomersPage />);

    await screen.findByText('Fatima Noor');
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    expect(customersApi.exportCustomersCsv).not.toHaveBeenCalled();
  });
});
