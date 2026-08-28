import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Textarea';
import { ApiError } from '../../lib/api/client';
import { KnowledgeCategory, type KnowledgeDocument } from '../../lib/api/types';
import { CATEGORY_LABELS } from './badges';
import { useCreateKnowledgeDocument, useUpdateKnowledgeDocument } from './hooks';

// 'create' or an existing document to edit; null means closed. A single
// dialog handles both modes — the fields (category/title/body/tags) are
// identical, only the submitted mutation and dialog copy differ. Active/
// inactive is deliberately NOT a field here — see KnowledgePage.tsx's own
// comment: that state gets its own explicit confirm flow, mirroring
// features/staff's separate disable-with-confirmation pattern, so a routine
// content edit can never silently deactivate a document.
export type KnowledgeDocumentDialogTarget = 'create' | KnowledgeDocument | null;

interface KnowledgeDocumentDialogProps {
  target: KnowledgeDocumentDialogTarget;
  onClose: () => void;
  onSaved: (title: string, mode: 'created' | 'updated') => void;
}

interface FormState {
  category: KnowledgeCategory;
  title: string;
  body: string;
  tagsText: string;
}

const EMPTY_FORM: FormState = { category: KnowledgeCategory.FAQ, title: '', body: '', tagsText: '' };

function formFromDocument(document: KnowledgeDocument): FormState {
  return { category: document.category, title: document.title, body: document.body, tagsText: document.tags.join(', ') };
}

function parseTags(tagsText: string): string[] {
  return [...new Set(tagsText.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

export function KnowledgeDocumentDialog({ target, onClose, onSaved }: KnowledgeDocumentDialogProps) {
  const isEdit = target !== null && target !== 'create';
  const targetKey = target === null ? null : target === 'create' ? 'create' : target.id;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const createDocument = useCreateKnowledgeDocument();
  const updateDocument = useUpdateKnowledgeDocument();

  // Re-initializes the form whenever the dialog opens for a new target
  // (create, or a different document to edit) — this component instance
  // stays mounted across opens (KnowledgePage always renders it), so a
  // plain useState initializer would only ever see the very first target.
  useEffect(() => {
    if (targetKey === null) return;
    setForm(isEdit ? formFromDocument(target as KnowledgeDocument) : EMPTY_FORM);
    setValidationError(null);
    createDocument.reset();
    updateDocument.reset();
    // Only the target identity should re-trigger this reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const title = form.title.trim();
    const body = form.body.trim();

    if (!title) {
      setValidationError('Title is required.');
      return;
    }
    if (!body) {
      setValidationError('Body is required.');
      return;
    }

    const input = { category: form.category, title, body, tags: parseTags(form.tagsText) };

    if (isEdit) {
      updateDocument.mutate(
        { id: (target as KnowledgeDocument).id, input },
        {
          onSuccess: (document) => {
            onSaved(document.title, 'updated');
            onClose();
          },
        },
      );
    } else {
      createDocument.mutate(input, {
        onSuccess: (document) => {
          onSaved(document.title, 'created');
          onClose();
        },
      });
    }
  }

  const mutation = isEdit ? updateDocument : createDocument;
  const errorMessage =
    validationError ?? (mutation.isError ? (mutation.error instanceof ApiError ? mutation.error.message : 'Could not save knowledge document.') : null);

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={isEdit ? 'Edit knowledge document' : 'Add knowledge document'}
      description="Staff-authored content the AI assistant can use to answer patients."
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Category
          <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as KnowledgeCategory })}>
            {Object.values(KnowledgeCategory).map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Title
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Body
          <Textarea rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Tags
          <Input
            value={form.tagsText}
            onChange={(e) => setForm({ ...form, tagsText: e.target.value })}
            placeholder="comma-separated, e.g. walk-in, billing"
          />
        </label>

        {errorMessage && (
          <p role="alert" className="text-[12px] text-danger">
            {errorMessage}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {isEdit ? 'Save changes' : 'Create document'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
