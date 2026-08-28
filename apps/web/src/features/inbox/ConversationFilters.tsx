import { Search, X } from 'lucide-react';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { ChannelKey, ConversationMode, ConversationStatus } from '../../lib/api/types';
import { STATUS_LABELS } from './badges';

export interface InboxFilters {
  search: string;
  channel: ChannelKey | '';
  status: ConversationStatus | '';
  mode: ConversationMode | '';
}

interface ConversationFiltersProps {
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
}

const MODE_LABELS: Record<ConversationMode, string> = {
  [ConversationMode.AI]: 'AI',
  [ConversationMode.PENDING]: 'Awaiting staff',
  [ConversationMode.HUMAN]: 'Staff',
  [ConversationMode.PAUSED]: 'Paused',
  [ConversationMode.SUSPENDED]: 'Suspended',
};

export function ConversationFilters({ filters, onChange }: ConversationFiltersProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-border p-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <Input
          type="search"
          placeholder="Search by contact or patient name"
          aria-label="Search by contact or patient name"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          className="pl-8"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, search: '' })}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          aria-label="Filter by channel"
          value={filters.channel}
          onChange={(e) => onChange({ ...filters, channel: e.target.value as InboxFilters['channel'] })}
        >
          <option value="">All channels</option>
          {Object.values(ChannelKey).map((channel) => (
            <option key={channel} value={channel}>
              {channel === ChannelKey.WHATSAPP ? 'WhatsApp' : channel === ChannelKey.INSTAGRAM ? 'Instagram' : 'Messenger'}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value as InboxFilters['status'] })}
        >
          <option value="">All statuses</option>
          {Object.values(ConversationStatus).map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>

        <Select aria-label="Filter by mode" value={filters.mode} onChange={(e) => onChange({ ...filters, mode: e.target.value as InboxFilters['mode'] })}>
          <option value="">AI &amp; staff</option>
          {Object.values(ConversationMode).map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
