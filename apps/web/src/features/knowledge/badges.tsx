import { Badge } from '../../components/ui/Badge';
import { KnowledgeCategory } from '../../lib/api/types';

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  [KnowledgeCategory.CLINIC_INFO]: 'Clinic info',
  [KnowledgeCategory.DOCTOR]: 'Doctor',
  [KnowledgeCategory.SERVICE]: 'Service',
  [KnowledgeCategory.FEE]: 'Fee',
  [KnowledgeCategory.HOURS]: 'Hours',
  [KnowledgeCategory.LOCATION]: 'Location',
  [KnowledgeCategory.POLICY]: 'Policy',
  [KnowledgeCategory.FAQ]: 'FAQ',
};

// A single neutral style — 8 categories is too many to color-code
// meaningfully (unlike inbox/badges.tsx's 3-5 channel/mode values), so the
// label alone carries the identity here.
export function CategoryBadge({ category }: { category: KnowledgeCategory }) {
  return <Badge className="bg-surface-sunken text-ink-muted">{CATEGORY_LABELS[category]}</Badge>;
}

// Reuses the same active/disabled color convention as
// features/staff/badges.tsx's StaffStatusBadge — no new status model.
export function KnowledgeStatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? <Badge className="bg-accent-soft text-accent">Active</Badge> : <Badge className="bg-danger-soft text-danger">Inactive</Badge>;
}
