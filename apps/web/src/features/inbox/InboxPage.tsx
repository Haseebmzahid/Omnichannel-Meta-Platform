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
    <div className="grid h-full grid-cols-[320px_1fr]">
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
