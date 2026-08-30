import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as authApi from '../../lib/api/auth';
import * as knowledgeApi from '../../lib/api/knowledge';
import type { KnowledgeDocument, StaffSummary } from '../../lib/api/types';
import { KnowledgePage } from './KnowledgePage';

vi.mock('../../lib/api/auth');
vi.mock('../../lib/api/knowledge');

function currentStaff(role: StaffSummary['role'] = 'ADMIN'): StaffSummary {
  return { id: 'staff-me', name: 'Dr. Amina', email: 'amina@clinic.test', role, clinicId: 'clinic-1' };
}

function knowledgeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'doc-1',
    clinicId: 'clinic-1',
    category: 'FAQ',
    title: 'Do you accept walk-ins?',
    body: 'Yes, walk-ins are welcome during OPD hours.',
    tags: ['walk-in'],
    isActive: true,
    updatedBy: 'staff-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

describe('KnowledgePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Knowledge list renders
  it('renders the knowledge list with category, title, tags, and status', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument()]);

    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByText('Do you accept walk-ins?')).toBeInTheDocument();
    // "FAQ"/"Active" also appear as <select> options in the filter row, so
    // scope these assertions to their table cell rather than the whole page.
    expect(screen.getByRole('cell', { name: 'FAQ' })).toBeInTheDocument();
    expect(screen.getByText('walk-in')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Active' })).toBeInTheDocument();
  });

  // 2. Loading state
  it('shows a loading state before documents arrive', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<KnowledgePage />);

    await screen.findByText('Knowledge base');
    expect(screen.queryByText('Do you accept walk-ins?')).not.toBeInTheDocument();
  });

  // 3. Empty state
  it('shows an empty state when there are no documents', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([]);

    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByText('No knowledge documents yet')).toBeInTheDocument();
  });

  // 4. API error state
  it('surfaces a retryable error state when the list request fails', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockRejectedValue(new Error('Could not load the knowledge base.'));

    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  // 5. Search/filter behavior
  it('filters the list by search text and by category', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([
      knowledgeDocument({ id: 'doc-1', title: 'Do you accept walk-ins?', category: 'FAQ', tags: ['walk-in'] }),
      knowledgeDocument({ id: 'doc-2', title: 'OPD Hours', category: 'HOURS', tags: ['timing'], body: 'Mon-Sat 9am-5pm' }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByText('OPD Hours')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search knowledge documents'), 'walk-in');
    expect(screen.getByText('Do you accept walk-ins?')).toBeInTheDocument();
    expect(screen.queryByText('OPD Hours')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search knowledge documents'));
    await user.selectOptions(screen.getByLabelText('Filter by category'), 'HOURS');
    expect(screen.getByText('OPD Hours')).toBeInTheDocument();
    expect(screen.queryByText('Do you accept walk-ins?')).not.toBeInTheDocument();
  });

  // 6. Create dialog validation
  it('rejects an invalid create form without calling the API', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([]);

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Add document' }));
    await user.click(screen.getByRole('button', { name: 'Create document' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required.');
    expect(knowledgeApi.createKnowledgeDocument).not.toHaveBeenCalled();
  });

  // 7. Successful create, plus 11. no client-supplied clinicId
  it('creates a knowledge document without sending a clinicId', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([]);
    vi.mocked(knowledgeApi.createKnowledgeDocument).mockResolvedValue(
      knowledgeDocument({ id: 'doc-2', title: 'Do you offer parking?', category: 'FAQ', tags: ['parking'] }),
    );

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Add document' }));
    await user.type(screen.getByLabelText('Title'), 'Do you offer parking?');
    await user.type(screen.getByLabelText('Body'), 'Yes, free parking is available on-site.');
    await user.type(screen.getByLabelText('Tags'), 'parking');
    await user.click(screen.getByRole('button', { name: 'Create document' }));

    await waitFor(() =>
      expect(knowledgeApi.createKnowledgeDocument).toHaveBeenCalledWith({
        category: 'FAQ',
        title: 'Do you offer parking?',
        body: 'Yes, free parking is available on-site.',
        tags: ['parking'],
      }),
    );

    const sentPayload = vi.mocked(knowledgeApi.createKnowledgeDocument).mock.calls[0]![0];
    expect(sentPayload).not.toHaveProperty('clinicId');

    expect(await screen.findByText('Do you offer parking? was created.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // 8. Edit/update, plus 12. mutation refreshes the list
  it('edits a knowledge document and refreshes the list', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments)
      .mockResolvedValueOnce([knowledgeDocument()])
      .mockResolvedValueOnce([knowledgeDocument({ title: 'Do you accept walk-ins? (updated)' })]);
    vi.mocked(knowledgeApi.updateKnowledgeDocument).mockResolvedValue(knowledgeDocument({ title: 'Do you accept walk-ins? (updated)' }));

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Edit Do you accept walk-ins?' }));
    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Do you accept walk-ins? (updated)');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(knowledgeApi.updateKnowledgeDocument).toHaveBeenCalledWith('doc-1', {
        category: 'FAQ',
        title: 'Do you accept walk-ins? (updated)',
        body: 'Yes, walk-ins are welcome during OPD hours.',
        tags: ['walk-in'],
      }),
    );

    expect(await screen.findByText('Do you accept walk-ins? (updated) was updated.')).toBeInTheDocument();
    // The list query was invalidated and refetched after the mutation.
    expect(knowledgeApi.listKnowledgeDocuments).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Do you accept walk-ins? (updated)')).toBeInTheDocument();
  });

  // 9. Disable/enable action
  it('disables a document after confirmation', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument()]);
    vi.mocked(knowledgeApi.updateKnowledgeDocumentStatus).mockResolvedValue(knowledgeDocument({ isActive: false }));

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Disable Do you accept walk-ins?' }));
    expect(screen.getByText('Disable "Do you accept walk-ins?"?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(knowledgeApi.updateKnowledgeDocumentStatus).toHaveBeenCalledWith('doc-1', false));
    expect(await screen.findByText('Do you accept walk-ins? was disabled.')).toBeInTheDocument();
  });

  // 9b. Reactivate (enable) action — the exact inverse of disable, no
  // separate creation path, and no confirmation dialog (unlike disable).
  it('enables a previously-disabled document with no confirmation step', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument({ isActive: false })]);
    vi.mocked(knowledgeApi.updateKnowledgeDocumentStatus).mockResolvedValue(knowledgeDocument({ isActive: true }));

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Enable Do you accept walk-ins?' }));

    await waitFor(() => expect(knowledgeApi.updateKnowledgeDocumentStatus).toHaveBeenCalledWith('doc-1', true));
    expect(await screen.findByText('Do you accept walk-ins? was enabled.')).toBeInTheDocument();
  });

  // 10. Mutation error handling (surfaced for good measure alongside item 9)
  it('surfaces a mutation error when disabling fails', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff());
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument()]);
    vi.mocked(knowledgeApi.updateKnowledgeDocumentStatus).mockRejectedValue(new ApiError(404, 'Knowledge document doc-1 was not found for this clinic.'));

    const user = userEvent.setup();
    renderWithProviders(<KnowledgePage />);

    await user.click(await screen.findByRole('button', { name: 'Disable Do you accept walk-ins?' }));
    await user.click(screen.getByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Knowledge document doc-1 was not found for this clinic.');
  });

  // 11. READ_ONLY does not receive mutation controls
  it('hides mutation controls for a READ_ONLY staff member', async () => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff('READ_ONLY'));
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument()]);

    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByText('Do you accept walk-ins?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
  });

  // Client-confirmed production role hardening: knowledge management is
  // ADMIN-only now — MANAGER and AGENT see the same read-only knowledge
  // base READ_ONLY does, never the mutation controls.
  it.each(['MANAGER', 'AGENT'] as const)('hides mutation controls for %s staff — knowledge management is ADMIN-only', async (role) => {
    vi.mocked(authApi.fetchCurrentStaff).mockResolvedValue(currentStaff(role));
    vi.mocked(knowledgeApi.listKnowledgeDocuments).mockResolvedValue([knowledgeDocument()]);

    renderWithProviders(<KnowledgePage />);

    expect(await screen.findByText('Do you accept walk-ins?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
  });
});
