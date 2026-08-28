import { MessageSquareText } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAuth } from '../auth/useAuth';
import { ConversationList } from './ConversationList';
import { ConversationView } from './ConversationView';

export function InboxPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const { staff } = useAuth();

  if (!staff) return null; // RequireAuth guarantees this never renders unauthenticated

  return (
    // The list column stays readable but never eats the whole viewport at
    // narrower desktop widths — minmax() keeps it between 240px and 320px
    // (Tailwind's existing arbitrary-value support, no new dependency) while
    // the conversation panel (1fr, already min-w-0 below) takes the rest.
    <div className="grid h-full grid-cols-[minmax(240px,320px)_1fr]">
      <ConversationList activeConversationId={conversationId} onSelect={(id) => navigate(`/inbox/${id}`)} />

      <div className="min-w-0 bg-bg">
        {conversationId ? (
          <ConversationView conversationId={conversationId} currentStaffId={staff.id} currentStaffRole={staff.role} />
        ) : (
          <EmptyState
            icon={<MessageSquareText className="size-10" />}
            title="Select a conversation"
            description="Choose a conversation from the list to view its messages."
          />
        )}
      </div>
    </div>
  );
}
