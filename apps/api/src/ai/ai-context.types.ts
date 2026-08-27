import type { AIMessageRole } from './ai-provider.interface';
import type { ToolDispatchResult } from './tool.types';

// Task 4C-5, Part 6 — the normalized AI request/context contract.
//
// This is the *shape* of what the orchestrator needs, not a working
// context-loading pipeline: docs/architecture/04-ai-orchestration.md §1
// says the orchestrator receives "the normalized message, conversation
// history, patient context, clinic context, and a CapabilityDescriptor"
// and "no channel identifier" — `channel` is carried here anyway because
// something upstream of the orchestrator (a future channel-adapter/
// ingestion task) has to know it to construct this context in the first
// place; the orchestrator itself must never branch on it. Actually
// assembling this object from the database (loading history, patient
// record, clinic facts) is explicitly deferred — "do not implement the
// full context-loading repository yet."

export interface AIContextMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIContext {
  clinicId: string;
  conversationId: string;
  /** Unset until identity resolution has linked this conversation to a Patient (see ADR-004). */
  patientId?: string;
  /** Recent turns, oldest first — how many is a future context-assembly concern, not fixed here. */
  recentMessages: AIContextMessage[];
  channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
  /** Conversation.mode (see docs/architecture/03-conversation-and-inbox.md §5) — who currently owns responding. */
  mode: 'AI' | 'PENDING' | 'HUMAN' | 'PAUSED' | 'SUSPENDED';
}

export interface AIRequest {
  context: AIContext;
  /** The newest inbound message this turn is responding to. */
  message: string;
}

export interface AIToolInvocationRecord {
  name: string;
  result: ToolDispatchResult;
}

export interface AIResponse {
  text: string;
  toolCalls: AIToolInvocationRecord[];
}
