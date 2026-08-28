import { Bot, Camera, Pause, Phone, ShieldAlert, UserCheck } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { ChannelKey, ConversationMode, ConversationStatus } from '../../lib/api/types';

// Channel identity is carried by color + label together (see Badge), never
// an exact reproduction of either platform's logo mark — deliberately
// generic icons (Phone/Camera), brand-adjacent color only.
const CHANNEL_CONFIG: Record<ChannelKey, { label: string; icon: typeof Phone; className: string }> = {
  [ChannelKey.WHATSAPP]: { label: 'WhatsApp', icon: Phone, className: 'bg-whatsapp-soft text-whatsapp' },
  [ChannelKey.INSTAGRAM]: { label: 'Instagram', icon: Camera, className: 'bg-instagram-soft text-instagram' },
  [ChannelKey.MESSENGER]: { label: 'Messenger', icon: Phone, className: 'bg-accent-soft text-accent' },
};

export function ChannelBadge({ channel }: { channel: ChannelKey }) {
  const { label, icon: Icon, className } = CHANNEL_CONFIG[channel];
  return (
    <Badge className={className} icon={<Icon className="size-3" aria-hidden="true" />}>
      {label}
    </Badge>
  );
}

const MODE_CONFIG: Record<ConversationMode, { label: string; icon: typeof Bot; className: string }> = {
  [ConversationMode.AI]: { label: 'AI', icon: Bot, className: 'bg-ai-soft text-ai' },
  [ConversationMode.PENDING]: { label: 'Awaiting staff', icon: ShieldAlert, className: 'bg-warning-soft text-warning' },
  [ConversationMode.HUMAN]: { label: 'Staff', icon: UserCheck, className: 'bg-human-soft text-human' },
  [ConversationMode.PAUSED]: { label: 'Paused', icon: Pause, className: 'bg-surface-sunken text-ink-muted' },
  [ConversationMode.SUSPENDED]: { label: 'Suspended', icon: ShieldAlert, className: 'bg-danger-soft text-danger' },
};

export function ModeBadge({ mode }: { mode: ConversationMode }) {
  const { label, icon: Icon, className } = MODE_CONFIG[mode];
  return (
    <Badge className={className} icon={<Icon className="size-3" aria-hidden="true" />}>
      {label}
    </Badge>
  );
}

const STATUS_CONFIG: Record<ConversationStatus, { label: string; className: string }> = {
  [ConversationStatus.OPEN]: { label: 'Open', className: 'bg-accent-soft text-accent' },
  [ConversationStatus.SNOOZED]: { label: 'Snoozed', className: 'bg-warning-soft text-warning' },
  [ConversationStatus.RESOLVED]: { label: 'Resolved', className: 'bg-surface-sunken text-ink-muted' },
  [ConversationStatus.ARCHIVED]: { label: 'Archived', className: 'bg-surface-sunken text-ink-faint' },
};

export function StatusBadge({ status }: { status: ConversationStatus }) {
  const { label, className } = STATUS_CONFIG[status];
  return <Badge className={className}>{label}</Badge>;
}

export const STATUS_LABELS: Record<ConversationStatus, string> = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([key, value]) => [key, value.label]),
) as Record<ConversationStatus, string>;
