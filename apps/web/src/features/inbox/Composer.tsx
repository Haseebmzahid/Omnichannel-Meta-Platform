import { type KeyboardEvent, useState } from 'react';
import { AlertCircle, SendHorizontal } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Textarea';

const MAX_REPLY_LENGTH = 4096;

interface ComposerProps {
  disabled?: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  isSending: boolean;
  sendError?: string | null;
}

export function Composer({ disabled, disabledReason, onSend, isSending, sendError }: ComposerProps) {
  const [text, setText] = useState('');

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setText('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline — standard messaging-app
    // convention (WhatsApp Web, Slack, etc.), what staff will expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  if (disabled) {
    return (
      <div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-4 py-3 text-[13px] text-ink-muted">
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        {disabledReason ?? 'You cannot reply to this conversation.'}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-surface p-3">
      {sendError && (
        <p role="alert" className="mb-2 rounded-md bg-danger-soft px-3 py-1.5 text-[12.5px] text-danger">
          {sendError}
        </p>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_REPLY_LENGTH))}
          onKeyDown={handleKeyDown}
          placeholder="Write a reply… (Enter to send, Shift+Enter for a new line)"
          aria-label="Reply message"
          rows={1}
          className="max-h-40 min-h-[38px] field-sizing-content"
          disabled={isSending}
        />
        <Button
          variant="primary"
          size="md"
          onClick={handleSend}
          disabled={!text.trim() || isSending}
          loading={isSending}
          aria-label="Send message"
        >
          <SendHorizontal className="size-4" aria-hidden="true" />
          Send
        </Button>
      </div>
      <div className="mt-1 flex justify-end text-[11px] text-ink-faint">
        {text.length > 0 && `${text.length}/${MAX_REPLY_LENGTH}`}
      </div>
    </div>
  );
}
