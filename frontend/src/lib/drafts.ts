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
}
