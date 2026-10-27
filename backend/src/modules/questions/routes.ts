import { answerQuestionBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { parse } from '../../errors';
import { answerQuestion, closeSurvey, respondToSurvey } from './service';

const params = z.object({ id: z.uuid() });

export function questionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/comments/:id/answer', async (request, reply) => {
    const { id } = parse(params, request.params);
    const { answers } = parse(answerQuestionBody, request.body);
    const by = userActor(currentUser(request));
    const result = await transact(ctx, (tx, after) => answerQuestion(tx, after, id, answers, by));
    return reply.status(201).send(result);
  });

  app.put('/comments/:id/response', async (request) => {
    const { id } = parse(params, request.params);
    const { answers } = parse(answerQuestionBody, request.body);
    const by = userActor(currentUser(request));
    return { comment: await transact(ctx, (tx, after) => respondToSurvey(tx, after, id, answers, by)) };
  });

  app.post('/comments/:id/close', async (request) => {
    const { id } = parse(params, request.params);
    const by = userActor(currentUser(request));
    return { comment: await transact(ctx, (tx, after) => closeSurvey(tx, after, id, by)) };
  });
}
