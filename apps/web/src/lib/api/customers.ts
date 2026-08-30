import { apiDownload, apiFetch } from './client';
import type { Customer } from './types';

// Mirrors apps/api/src/customers/customers.controller.ts exactly — the two
// authenticated, clinic-scoped routes this feature adds. No clinicId is
// ever sent; the backend derives it from the session cookie, same
// convention as every other apps/lib/api/*.ts module.
//
//   GET /customers          — view, every role
//   GET /customers/export   — CSV, ADMIN-only (client-confirmed production
//                              role hardening — see CustomersController's
//                              own header comment)

export function listCustomers(): Promise<Customer[]> {
  return apiFetch<Customer[]>('/customers');
}

export function exportCustomersCsv(): Promise<void> {
  return apiDownload('/customers/export', 'customers.csv');
}
