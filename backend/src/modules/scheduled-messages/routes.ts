import { answerLimitResumeBody, createScheduledMessageBody, setTaskAutoResumeBody, updateScheduledMessageBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { parse } from '../../errors';
import { idOrKey } from '../../ids';
import { receiveMultipart } from '../comments/routes';
import type { NewAttachment } from '../comments/service';
import { loadComment } from '../comments/service';
import { emitTasksChanged, getTaskRow } from '../tasks/service';
import { tasks } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { answerLimitResume, cancelMessage, createMessage, listMessages, sendMessageNow, updateMessage } from './service';

const taskParams = z.object({ taskId: idOrKey });
const params = z.object({ id: z.uuid() });

export function scheduledMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/tasks/:taskId/scheduled-messages', async (request) => {
    const { taskId } = parse(taskParams, request.params);
    const task = await getTaskRow(ctx.db, taskId);
    return { messages: await listMessages(ctx.db, task.id) };
  });

  app.post('/tasks/:taskId/scheduled-messages', async (request, reply) => {
    const { taskId } = parse(taskParams, request.params);
    const author = userActor(currentUser(request));
    const task = await getTaskRow(ctx.db, taskId);
    const { fields, files } = request.isMultipart() ? await receiveMultipart(ctx, request) : { fields: request.body, files: [] as NewAttachment[] };
    try {
      const body = parse(createScheduledMessageBody, fields);
      const message = await transact(ctx, (tx, after) => createMessage(tx, after, task.id, { ...body, attachments: files }, author));
      return reply.status(201).send({ message });
    } catch (err) {
      await Promise.all(files.map((f) => ctx.blobs.delete(f.blobId)));
      throw err;
    }
  });

  app.patch('/scheduled-messages/:id', async (request) => {
    const { id } = parse(params, request.params);
    const patch = parse(updateScheduledMessageBody, request.body);
    return { message: await transact(ctx, (tx, after) => updateMessage(tx, after, id, patch)) };
  });

  app.delete('/scheduled-messages/:id', async (request) => {
    const { id } = parse(params, request.params);
    const by = userActor(currentUser(request));
    return { message: await transact(ctx, (tx, after) => cancelMessage(tx, after, id, `Cancelled by ${by.displayName}`)) };
  });

  app.post('/scheduled-messages/:id/send', async (request) => {
    const { id } = parse(params, request.params);
    return { message: await transact(ctx, (tx, after) => sendMessageNow(tx, after, id)) };
  });

  /** Answers the offer to resume after a usage limit; the first answer decides. */
  app.post('/comments/:id/limit-resume', async (request) => {
    const { id } = parse(params, request.params);
    const { schedule } = parse(answerLimitResumeBody, request.body);
    const by = userActor(currentUser(request));
    return { comment: await transact(ctx, async (tx, after) => (await answerLimitResume(tx, after, id, schedule, by), loadComment(tx, id))) };
  });

  /** The Task's own automatic resume switch; it is no Revision of the Task. */
  app.put('/tasks/:taskId/auto-resume', async (request) => {
    const { taskId } = parse(taskParams, request.params);
    const { enabled } = parse(setTaskAutoResumeBody, request.body);
    const task = await getTaskRow(ctx.db, taskId);
    return {
      task: await transact(ctx, async (tx, after) => {
        await tx.update(tasks).set({ autoResume: enabled }).where(eq(tasks.id, task.id));
        const [changed] = await emitTasksChanged(tx, after, [task.id], 'task.updated');
        return changed!;
      }),
    };
  });
}
