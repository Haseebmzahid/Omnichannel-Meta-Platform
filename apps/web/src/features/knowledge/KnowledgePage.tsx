import { useMemo, useState } from 'react';
import { BookOpen, Pencil, Plus, ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Skeleton } from '../../components/ui/Skeleton';
import { ApiError } from '../../lib/api/client';
import { KnowledgeCategory, type KnowledgeDocument } from '../../lib/api/types';
import { formatRelativeTime } from '../../lib/utils';
import { useAuth } from '../auth/useAuth';
import { isAdmin } from '../inbox/permissions';
import { CATEGORY_LABELS, CategoryBadge, KnowledgeStatusBadge } from './badges';
import { useKnowledgeDocuments, useUpdateKnowledgeDocumentStatus } from './hooks';
import { KnowledgeDocumentDialog, type KnowledgeDocumentDialogTarget } from './KnowledgeDocumentDialog';

type StatusFilter = '' | 'ACTIVE' | 'INACTIVE';

// The real knowledge-base management screen consuming apps/api/src/knowledge/*
// (Task 7-7), replacing the Task 7-5 placeholder. Structure mirrors
// features/staff/StaffPage.tsx: isAdmin() gates every mutation control as
// a UI convenience only — KnowledgeController's own assertCanManageKnowledge
// (client-confirmed production role hardening: ADMIN-only) remains the
// actual authorization boundary. MANAGER and AGENT see the same read-only
// knowledge base READ_ONLY does. Search/category/status
// filtering is client-side over the already-fetched list — GET /knowledge
// takes no query params (a per-clinic knowledge base is realistically tens
// of documents, the same "no pagination" reasoning as StaffService).
export function KnowledgePage() {
  const { staff: currentStaff } = useAuth();
  const { data: documents, isLoading, isError, error, refetch } = useKnowledgeDocuments();
  const updateStatus = useUpdateKnowledgeDocumentStatus();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<KnowledgeCategory | ''>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');

  const [dialogTarget, setDialogTarget] = useState<KnowledgeDocumentDialogTarget>(null);
  const [disableTarget, setDisableTarget] = useState<KnowledgeDocument | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const filteredDocuments = useMemo(() => {
    if (!documents) return [];
    const query = search.trim().toLowerCase();
    return documents.filter((doc) => {
      if (categoryFilter && doc.category !== categoryFilter) return false;
      if (statusFilter === 'ACTIVE' && !doc.isActive) return false;
      if (statusFilter === 'INACTIVE' && doc.isActive) return false;
      if (!query) return true;
      const haystack = `${doc.title} ${doc.body} ${doc.tags.join(' ')}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [documents, search, categoryFilter, statusFilter]);

  if (!currentStaff) return null; // RequireAuth guarantees this never renders unauthenticated

  const canManage = isAdmin(currentStaff.role);
  const hasActiveFilter = Boolean(search || categoryFilter || statusFilter);

  function handleEnable(document: KnowledgeDocument) {
    setStatusError(null);
    updateStatus.mutate(
      { id: document.id, isActive: true },
      {
        onSuccess: () => setBanner(`${document.title} was enabled.`),
        onError: (err) => setStatusError(err instanceof ApiError ? err.message : 'Could not update status.'),
      },
    );
  }

  function confirmDisable() {
    if (!disableTarget) return;
    const document = disableTarget;
    setStatusError(null);
    updateStatus.mutate(
      { id: document.id, isActive: false },
      {
        onSuccess: () => {
          setBanner(`${document.title} was disabled.`);
          setDisableTarget(null);
        },
        onError: (err) => {
          setStatusError(err instanceof ApiError ? err.message : 'Could not update status.');
          setDisableTarget(null);
        },
      },
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Knowledge base</h1>
          <p className="text-[13px] text-ink-muted">Content your AI assistant uses to answer patients.</p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setDialogTarget('create')}>
            <Plus className="size-4" aria-hidden="true" />
            Add document
          </Button>
        )}
      </div>

      {banner && <p className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{banner}</p>}
      {statusError && (
        <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {statusError}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Input
          type="search"
          placeholder="Search by title, body, or tag"
          aria-label="Search knowledge documents"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select aria-label="Filter by category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as KnowledgeCategory | '')}>
          <option value="">All categories</option>
          {Object.values(KnowledgeCategory).map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </Select>
      </div>

      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState message={error instanceof Error ? error.message : 'Could not load the knowledge base.'} onRetry={() => refetch()} />
      ) : !documents || documents.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-10" />}
          title="No knowledge documents yet"
          description="Documents you add here become searchable content your AI assistant can use to answer patients."
        />
      ) : filteredDocuments.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-10" />}
          title={hasActiveFilter ? 'No matching documents' : 'No knowledge documents yet'}
          description={hasActiveFilter ? 'Try a different search or clear your filters.' : 'Documents you add here will show up here.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-surface-sunken text-[12px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Category
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Title
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Tags
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Updated
                </th>
                {canManage && (
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface">
              {filteredDocuments.map((document) => (
                <tr key={document.id} className={!document.isActive ? 'opacity-60' : undefined}>
                  <td className="px-4 py-2.5">
                    <CategoryBadge category={document.category} />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-ink">{document.title}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{document.tags.length > 0 ? document.tags.join(', ') : '—'}</td>
                  <td className="px-4 py-2.5">
                    <KnowledgeStatusBadge isActive={document.isActive} />
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatRelativeTime(document.updatedAt)}</td>
                  {canManage && (
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setDialogTarget(document)} aria-label={`Edit ${document.title}`}>
                          <Pencil className="size-3.5" aria-hidden="true" />
                          Edit
                        </Button>
                        {document.isActive ? (
                          <Button variant="ghost" size="sm" onClick={() => setDisableTarget(document)} aria-label={`Disable ${document.title}`}>
                            <ShieldOff className="size-3.5" aria-hidden="true" />
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEnable(document)}
                            loading={updateStatus.isPending}
                            aria-label={`Enable ${document.title}`}
                          >
                            <ShieldCheck className="size-3.5" aria-hidden="true" />
                            Enable
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <KnowledgeDocumentDialog
          target={dialogTarget}
          onClose={() => setDialogTarget(null)}
          onSaved={(title, mode) => setBanner(mode === 'created' ? `${title} was created.` : `${title} was updated.`)}
        />
      )}

      {canManage && (
        <Dialog
          open={disableTarget !== null}
          onClose={() => setDisableTarget(null)}
          title={disableTarget ? `Disable "${disableTarget.title}"?` : 'Disable knowledge document?'}
          description="The AI assistant will stop using it to answer patients."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDisableTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDisable} loading={updateStatus.isPending}>
              Disable
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
