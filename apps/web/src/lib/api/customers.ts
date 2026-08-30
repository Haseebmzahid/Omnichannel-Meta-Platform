import { apiDownload } from './client';

// Mirrors apps/api/src/customers/customers.controller.ts exactly — the one
// authenticated, clinic-scoped route this feature adds. No clinicId is
// ever sent; the backend derives it from the session cookie, same
// convention as every other apps/lib/api/*.ts module.
//
//   GET /customers/export

export function exportCustomersCsv(): Promise<void> {
  return apiDownload('/customers/export', 'customers.csv');
}
