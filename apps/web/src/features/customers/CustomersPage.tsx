import { useState } from 'react';
import { Download, Users } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { ApiError } from '../../lib/api/client';
import { formatRelativeTime } from '../../lib/utils';
import { useAuth } from '../auth/useAuth';
import { isAdmin } from '../inbox/permissions';
import { useCustomers, useExportCustomersCsv } from './hooks';

// The customer/contact screen consuming apps/api/src/customers/* — a list
// (GET /customers, every role can view) plus a bulk CSV export
// (GET /customers/export). Client-confirmed production role hardening:
// export is ADMIN-only — isAdmin() gates the button as a UI convenience
// only, CustomersController's own assertIsAdmin remains the actual
// authorization boundary. MANAGER, AGENT, and READ_ONLY all see the same
// read-only list, matching the same "view but never export" shape
// Staff/Knowledge already use for their own mutation controls.
export function CustomersPage() {
  const { staff: currentStaff } = useAuth();
  const { data: customers, isLoading, isError, error, refetch } = useCustomers();
  const exportCsv = useExportCustomersCsv();
  const [banner, setBanner] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!currentStaff) return null; // RequireAuth guarantees this never renders unauthenticated

  const canExport = isAdmin(currentStaff.role);

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
          <p className="text-[13px] text-ink-muted">
            {isLoading ? 'Loading customers…' : `${customers?.length ?? 0} customer${customers?.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {canExport && (
          <Button variant="primary" onClick={handleExport} loading={exportCsv.isPending}>
            <Download className="size-4" aria-hidden="true" />
            Export CSV
          </Button>
        )}
      </div>

      {banner && <p role="status" className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{banner}</p>}
      {errorMessage && (
        <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState message={error instanceof Error ? error.message : 'Could not load customers.'} onRetry={() => refetch()} />
      ) : !customers || customers.length === 0 ? (
        <EmptyState icon={<Users className="size-10" />} title="No customers yet" description="Customers this clinic has messaged will show up here." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-surface-sunken text-[12px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Phone
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Channels
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Last interaction
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface">
              {customers.map((customer, i) => (
                // No stable id is exposed in this DTO (deliberately — see
                // CustomerExportRow's own comment); name+lastInteraction is
                // as close to a natural key as this data has, with the
                // array index only as a final tie-breaker for duplicates.
                <tr key={`${customer.name}-${customer.lastInteraction}-${i}`}>
                  <td className="px-4 py-2.5 font-medium text-ink">{customer.name}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{customer.phone ?? '—'}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{customer.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{customer.channels.join(', ')}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatRelativeTime(customer.lastInteraction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
