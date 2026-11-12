// Unsent comment drafts by Task, so closing a Task and coming back to it keeps them (until the page reloads).

export interface CommentDraft {
  body: string;
  internal: boolean;
  files: File[];
}

export const commentDrafts = new Map<string, CommentDraft>();

/** Another User may log in next in this browser. */
export function clearCommentDrafts(): void {
  commentDrafts.clear();
  btwReplies.clear();
  for (const listener of listeners) listener();
}

/** The Btw Thread the next Comment of a Task continues ("Replying to btw"), set from a Btw Comment's Reply action. */
export interface BtwReply {
  threadId: string;
  /** The first words of the Btw Comment replied to. */
  preview: string;
}

const btwReplies = new Map<string, BtwReply>();
const listeners = new Set<() => void>();

export const btwReplyStore = {
  get: (taskId: string): BtwReply | undefined => btwReplies.get(taskId),
  set(taskId: string, reply: BtwReply | null): void {
    if (reply) btwReplies.set(taskId, reply);
    else btwReplies.delete(taskId);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export function btwPreview(body: string): string {
  const words = body.trim().split(/\s+/);
  const head = words.slice(0, 8).join(' ');
  return words.length > 8 ? `${head}…` : head;
}
