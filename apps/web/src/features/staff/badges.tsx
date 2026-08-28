import { Badge } from '../../components/ui/Badge';
import { StaffRole, StaffStatus } from '../../lib/api/types';
import { ROLE_LABELS } from '../inbox/permissions';

// Role color isn't semantic (unlike inbox/badges.tsx's channel/mode colors)
// — just enough visual distinction to scan a table quickly. READ_ONLY gets
// the "caution" amber since it's the one restricted role.
const ROLE_BADGE_CLASSES: Record<StaffRole, string> = {
  [StaffRole.ADMIN]: 'bg-accent-soft text-accent',
  [StaffRole.MANAGER]: 'bg-ai-soft text-ai',
  [StaffRole.AGENT]: 'bg-surface-sunken text-ink-muted',
  [StaffRole.READ_ONLY]: 'bg-warning-soft text-warning',
};

export function StaffRoleBadge({ role }: { role: StaffRole }) {
  return <Badge className={ROLE_BADGE_CLASSES[role]}>{ROLE_LABELS[role]}</Badge>;
}

const STATUS_CONFIG: Record<StaffStatus, { label: string; className: string }> = {
  [StaffStatus.ACTIVE]: { label: 'Active', className: 'bg-accent-soft text-accent' },
  [StaffStatus.DISABLED]: { label: 'Disabled', className: 'bg-danger-soft text-danger' },
};

export function StaffStatusBadge({ status }: { status: StaffStatus }) {
  const { label, className } = STATUS_CONFIG[status];
  return <Badge className={className}>{label}</Badge>;
}
