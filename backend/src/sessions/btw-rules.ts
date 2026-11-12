import type { SessionRow } from './view';

/**
 * Why a Btw cannot be asked now, or null when it can (docs/specs/conversation.md#btw). The Session
 * needs a conversation to fork: started, open and with an Agent. A reply needs a thread that
 * forked from the Session's current conversation and has a conversation of its own.
 */
export function btwBlocker(input: {
  session: Pick<SessionRow, 'started' | 'state' | 'claudeSessionId' | 'id'>;
  hasAgent: boolean;
  working: boolean;
  reply: { originSessionId: string; forkSessionId: string | null } | null;
}): string | null {
  const { session } = input;
  if (session.state === 'closed') return 'The task is closed: reopen it to ask a btw';
  if (!input.hasAgent || session.state === 'paused') return 'No agent is assigned to this task';
  if (!session.started || session.state === 'pending') return "The agent hasn't started on this task yet, so there is nothing to ask about";
  if (input.working) return 'Another btw of this task is still being answered';
  if (input.reply) {
    if (input.reply.originSessionId !== (session.claudeSessionId ?? session.id)) {
      return 'This btw belongs to a conversation that was cleared: start a new /btw';
    }
    if (!input.reply.forkSessionId) return 'This btw has no conversation to continue: start a new /btw';
  }
  return null;
}
