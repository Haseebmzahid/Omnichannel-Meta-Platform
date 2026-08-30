import { useState } from 'react';
import { Download, Users } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ApiError } from '../../lib/api/client';
import { useAuth } from '../auth/useAuth';
import { useExportCustomersCsv } from './hooks';

// The smallest appropriate entry point for the customer/contact export
// (consuming apps/api/src/customers/*): no list/table here — the backend
// exposes only the export endpoint, not a general customer-listing API, so
// this page's one job is the export action itself, mirroring
// StaffPage/KnowledgePage's layout conventions without inventing UI for
// data the backend doesn't serve. Visible to every authenticated role,
// including READ_ONLY — exporting is a read, not a mutation, the same rule
// CustomersController's own assertCanMutate-free route already applies; see
// that file's header comment. There is nothing here for canMutate() to gate.
export function CustomersPage() {
  const { staff: currentStaff } = useAuth();
  const exportCsv = useExportCustomersCsv();
  const [banner, setBanner] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!currentStaff) return null; // RequireAuth guarantees this never renders unauthenticated

  function handleExport() {
    setBanner(null);
    setErrorMessage(null);
    exportCsv.mutate(undefined, {
      onSuccess: () => setBanner('Customer export downloaded.'),
      onError: (err) => setErrorMessage(err instanceof ApiError ? err.message : 'Could not export customers.'),
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Customers</h1>
          <p className="text-[13px] text-ink-muted">Export the customers this clinic has messaged, as a CSV file.</p>
        </div>
        <Button variant="primary" onClick={handleExport} loading={exportCsv.isPending}>
          <Download className="size-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {banner && (
        <p role="status" className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">
          {banner}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {errorMessage}
        </p>
      )}

      <div className="flex-1 rounded-lg border border-border">
        <EmptyState
          icon={<Users className="size-10" />}
          title="Export your customer list"
          description="Includes each customer's name, phone, email, channels, and first/last interaction dates."
        />
      </div>
    </div>
  );
}
