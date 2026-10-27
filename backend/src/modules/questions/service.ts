// Questions and Surveys an Agent posts, and how Users answer them (docs/specs/conversation.md).
import { QUESTION_LIMITS } from '@claude-task/shared';
import type { Actor, Comment, QuestionAnswer, QuestionItem, QuestionKind } from '@claude-task/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { comments, questions, surveyResponses } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../errors';
import { deliverComment } from '../../sessions/lifecycle';
import { actorResolver } from '../actors';
import { createUserComment, loadComment } from '../comments/service';
import { getTaskRow, loadTask } from '../tasks/service';

type QuestionRow = typeof questions.$inferSelect;

/** Checks what the tool schema can't: unique labels, and no "Other" option (the clients add it). */
export function validateItems(items: QuestionItem[]): void {
  items.forEach((item, i) => {
    const labels = item.options.map((o) => o.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) throw badRequest(`Item ${i + 1} ("${item.header}") has two options with the same label`);
    if (labels.includes('other')) throw badRequest(`Item ${i + 1} ("${item.header}"): leave out "Other", every item offers it already`);
  });
}

/** A Survey's Expected Respondents: the Task's User Assignees right now. */
export async function expectedRespondents(db: Executor, taskId: string): Promise<{ id: string; name: string }[]> {
  const task = await loadTask(db, taskId);
  const resolve = await actorResolver(db, task.assigneeIds.map((id) => ({ type: 'user' as const, id })));
  return task.assigneeIds.map((id) => ({ id, name: resolve({ type: 'user', id }).displayName }));
}

/** The readable body of a Question or Survey, for older clients and for Agents reading the conversation. */
export function questionBody(kind: QuestionKind, items: QuestionItem[], expected: string[] = []): string {
  const blocks = items.map((item) =>
    [
      `**${item.header}**: ${item.question}`,
      ...item.options.map((o) => `- **${o.label}**${o.description ? `: ${o.description}` : ''}`),
      `- **Other**: your own answer${item.multiSelect ? ' _(choose one or more)_' : ''}`,
    ].join('\n'),
  );
  if (kind === 'survey') {
    blocks.push(`_Survey: answer in the app. The results go to the agent once ${expected.join(', ')} answered, or when someone sends it early._`);
  }
  return blocks.join('\n\n');
}

/** Validates one answer per item and returns it trimmed. */
export function validateAnswers(items: QuestionItem[], answers: QuestionAnswer[]): QuestionAnswer[] {
  if (answers.length !== items.length) throw badRequest(`Answer each of the ${items.length} items, in order`);
  return items.map((item, i) => {
    const answer = answers[i]!;
    const other = answer.other?.trim() ? answer.other.trim() : null;
    const selected = [...new Set(answer.selected)];
    for (const label of selected) {
      if (!item.options.some((o) => o.label === label)) throw badRequest(`"${label}" is not an option of "${item.header}"`);
    }
    const choices = selected.length + (other ? 1 : 0);
    if (choices === 0) throw badRequest(`Choose an option for "${item.header}" or write your own answer`);
    if (!item.multiSelect && choices > 1) throw badRequest(`"${item.header}" takes a single answer`);
    if (other && other.length > QUESTION_LIMITS.other) throw badRequest(`"Other" is at most ${QUESTION_LIMITS.other} characters`);
    return { selected, other };
  });
}

function describeAnswer(answer: QuestionAnswer): string {
  return [answer.selected.join(', '), answer.other && `Other: ${JSON.stringify(answer.other)}`].filter(Boolean).join('; ');
}

/** The Question or Survey of a Comment, locked so concurrent answers apply one at a time. */
async function lockQuestion(tx: Executor, commentId: string): Promise<{ row: QuestionRow; comment: typeof comments.$inferSelect }> {
  const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId));
  if (!comment || comment.deletedAt) throw notFound('Question');
  const [row] = await tx.select().from(questions).where(eq(questions.commentId, commentId)).for('update');
  if (!row) throw notFound('Question');
  return { row, comment };
}

/** The first answer closes the Question and reaches the Agent as the answering User's Comment. */
export async function answerQuestion(
  tx: Executor,
  after: AfterCommit,
  commentId: string,
  answers: QuestionAnswer[],
  by: Actor,
): Promise<{ question: Comment; answer: Comment }> {
  const { row, comment } = await lockQuestion(tx, commentId);
  if (row.kind !== 'question') throw badRequest('This is a survey: answer it with PUT /comments/:id/response');
  if (row.state !== 'open') {
    const resolve = await actorResolver(tx, [{ type: 'user', id: row.answeredBy }]);
    throw conflict(`This question was already answered by ${resolve({ type: 'user', id: row.answeredBy }).displayName}`);
  }
  const answer = validateAnswers(row.items, answers);
  const body = [
    `Answer to your question from ${comment.createdAt.toISOString()}:`,
    '',
    ...row.items.flatMap((item, i) => [`**${item.header}**: ${item.question}`, `→ ${describeAnswer(answer[i]!)}`]),
  ].join('\n');
  const task = await getTaskRow(tx, comment.taskId);
  const reply = await createUserComment(tx, after, task, { body, internal: false, attachments: [], answersCommentId: comment.id }, by);
  await tx
    .update(questions)
    .set({ state: 'answered', answer, answeredBy: by.id, answeredAt: new Date(), answerCommentId: reply.id })
    .where(eq(questions.commentId, comment.id));
  after.effect((ctx) => ctx.scheduler.publishComments([comment.id]));
  return { question: await loadComment(tx, comment.id), answer: reply };
}

/** Records or replaces a User's answer; the last Expected Respondent's answer closes the Survey. */
export async function respondToSurvey(tx: Executor, after: AfterCommit, commentId: string, answers: QuestionAnswer[], by: Actor): Promise<Comment> {
  const { row } = await lockQuestion(tx, commentId);
  if (row.kind !== 'survey') throw badRequest('This is a question: answer it with POST /comments/:id/answer');
  if (row.state !== 'open') throw conflict('This survey is closed');
  const valid = validateAnswers(row.items, answers);
  await tx
    .insert(surveyResponses)
    .values({ commentId, userId: by.id!, answers: valid })
    .onConflictDoUpdate({ target: [surveyResponses.commentId, surveyResponses.userId], set: { answers: valid, updatedAt: new Date() } });
  const responded = await tx.select({ userId: surveyResponses.userId }).from(surveyResponses).where(eq(surveyResponses.commentId, commentId));
  if (row.expectedRespondentIds.every((id) => responded.some((r) => r.userId === id))) await closeWithResults(tx, after, row, null);
  after.effect((ctx) => ctx.scheduler.publishComments([commentId]));
  return loadComment(tx, commentId);
}

/** Send now: closes an open Survey, with or without answers. */
export async function closeSurvey(tx: Executor, after: AfterCommit, commentId: string, by: Actor): Promise<Comment> {
  const { row } = await lockQuestion(tx, commentId);
  if (row.kind !== 'survey') throw badRequest('Only a survey can be closed');
  if (row.state !== 'open') throw conflict('This survey is closed');
  await closeWithResults(tx, after, row, by);
  after.effect((ctx) => ctx.scheduler.publishComments([commentId]));
  return loadComment(tx, commentId);
}

/** Closes the Survey and posts the System Comment that carries the results to the Agent. */
async function closeWithResults(tx: Executor, after: AfterCommit, row: QuestionRow, by: Actor | null): Promise<void> {
  const [survey] = await tx.select().from(comments).where(eq(comments.id, row.commentId));
  const responses = await tx
    .select()
    .from(surveyResponses)
    .where(eq(surveyResponses.commentId, row.commentId))
    .orderBy(asc(surveyResponses.createdAt), asc(surveyResponses.userId));
  const resolve = await actorResolver(tx, [...responses.map((r) => r.userId), ...row.expectedRespondentIds].map((id) => ({ type: 'user' as const, id })));
  const name = (id: string) => resolve({ type: 'user', id }).displayName;
  const missing = row.expectedRespondentIds.filter((id) => !responses.some((r) => r.userId === id));

  const lines = [
    `Survey results for your survey from ${survey!.createdAt.toISOString()}.`,
    by ? `${by.displayName} closed it early.` : 'Every expected respondent answered.',
  ];
  row.items.forEach((item, i) => {
    lines.push('', `**${item.header}**: ${item.question}`);
    for (const option of item.options) {
      const chose = responses.filter((r) => r.answers[i]?.selected.includes(option.label)).map((r) => name(r.userId));
      lines.push(`- ${option.label}: ${chose.length}${chose.length ? ` (${chose.join(', ')})` : ''}`);
    }
    for (const r of responses) {
      const other = r.answers[i]?.other;
      if (other) lines.push(`- Other from ${name(r.userId)}: ${JSON.stringify(other)}`);
    }
  });
  lines.push('', `Answers: ${responses.length}${responses.length ? ` (${responses.map((r) => name(r.userId)).join(', ')})` : ''}.`);
  if (missing.length) lines.push(`Expected respondents who did not answer: ${missing.map(name).join(', ')}.`);

  const [result] = await tx
    .insert(comments)
    .values({
      taskId: survey!.taskId,
      kind: 'system',
      authorType: 'system',
      authorId: null,
      body: by ? `${by.displayName} closed the survey early.` : 'Survey closed: every expected respondent answered.',
      noticeMessage: lines.join('\n'),
      createdAt: sql`clock_timestamp()`,
    })
    .returning();
  await tx
    .update(questions)
    .set({ state: 'closed', closedBy: by?.id ?? null, closedAt: new Date(), resultCommentId: result!.id })
    .where(and(eq(questions.commentId, row.commentId)));
  await deliverComment(tx, after, { id: survey!.taskId }, result!);
  after.effect((ctx) => ctx.scheduler.publishComments([result!.id], 'created'));
}
