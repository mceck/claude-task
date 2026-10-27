import type { Comment, QuestionAnswer, QuestionItem, Survey } from '@claude-task/shared';
import { QUESTION_LIMITS } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MessageCircleQuestion, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiError, errorMessage, post, put } from '../api/client';
import { useMe } from '../api/queries';
import { putTimelineItem } from '../lib/cache';
import { Time } from './common';
import { Markdown } from './Markdown';

const OTHER = '__other__';

const empty = (items: QuestionItem[]): QuestionAnswer[] => items.map(() => ({ selected: [], other: null }));

/** Every item has an option or a non-blank "Other", and a single-choice item has just one. */
function complete(items: QuestionItem[], answers: QuestionAnswer[]): boolean {
  return items.every((item, i) => {
    const a = answers[i]!;
    const count = a.selected.length + (a.other?.trim() ? 1 : 0);
    return count > 0 && (item.multiSelect || count === 1);
  });
}

/** Sends only what the chosen mode means: a cleared "Other" goes as null. */
const clean = (answers: QuestionAnswer[]) => answers.map((a) => ({ selected: a.selected, other: a.other?.trim() ? a.other.trim() : null }));

function useReplace(taskId: string) {
  const qc = useQueryClient();
  return (c: Comment) => putTimelineItem(qc, taskId, { type: 'comment', id: c.id, createdAt: c.createdAt, comment: c });
}

/** One item: its header, question and options; "Other" always comes last. */
function ItemField({
  item,
  index,
  value,
  onChange,
  disabled,
}: {
  item: QuestionItem;
  index: number;
  value: QuestionAnswer;
  onChange: (value: QuestionAnswer) => void;
  disabled: boolean;
}) {
  const id = (suffix: string) => `item-${index}-${suffix}`;
  const otherOn = value.other !== null;
  const option = (label: string, description: string, control: React.ReactNode, key: string) => (
    <label key={key} htmlFor={id(key)} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2', !disabled && 'cursor-pointer hover:bg-muted/40')}>
      <span className="pt-0.5">{control}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 space-y-1">
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
          {item.header}
        </Badge>
        <Markdown source={item.question} />
        {item.multiSelect && <span className="block text-xs text-muted-foreground">Choose one or more</span>}
      </legend>
      {item.multiSelect ? (
        <div className="grid gap-2">
          {item.options.map((o) =>
            option(
              o.label,
              o.description,
              <Checkbox
                id={id(o.label)}
                checked={value.selected.includes(o.label)}
                onCheckedChange={(on) =>
                  onChange({ ...value, selected: on ? [...value.selected, o.label] : value.selected.filter((l) => l !== o.label) })
                }
              />,
              o.label,
            ),
          )}
          {option('Other', 'Your own answer', <Checkbox id={id(OTHER)} checked={otherOn} onCheckedChange={(on) => onChange({ ...value, other: on ? '' : null })} />, OTHER)}
        </div>
      ) : (
        <RadioGroup
          aria-label={item.header}
          value={otherOn ? OTHER : (value.selected[0] ?? '')}
          onValueChange={(v) => onChange(v === OTHER ? { selected: [], other: value.other ?? '' } : { selected: [v], other: null })}
        >
          {item.options.map((o) => option(o.label, o.description, <RadioGroupItem id={id(o.label)} value={o.label} />, o.label))}
          {option('Other', 'Your own answer', <RadioGroupItem id={id(OTHER)} value={OTHER} />, OTHER)}
        </RadioGroup>
      )}
      {otherOn && (
        <Textarea
          aria-label={`Other answer for ${item.header}`}
          value={value.other ?? ''}
          maxLength={QUESTION_LIMITS.other}
          onChange={(e) => onChange({ ...value, other: e.target.value })}
          placeholder="Your answer"
          className="min-h-16"
        />
      )}
    </fieldset>
  );
}

/** What a set of answers says, item by item. */
function AnswerSummary({ items, answers }: { items: QuestionItem[]; answers: QuestionAnswer[] }) {
  return (
    <dl className="space-y-2 text-sm">
      {items.map((item, i) => (
        <div key={i}>
          <dt className="text-xs text-muted-foreground">{item.header}</dt>
          <dd>{[answers[i]?.selected.join(', '), answers[i]?.other && `“${answers[i]!.other}”`].filter(Boolean).join(' · ')}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An Agent's Question: answered once, by whoever answers first. */
export function QuestionCard({ comment }: { comment: Comment }) {
  const question = comment.question!;
  const replace = useReplace(comment.taskId);
  const [answers, setAnswers] = useState(() => empty(question.items));
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      const res = await post<{ question: Comment; answer: Comment }>(`/comments/${comment.id}/answer`, { answers: clean(answers) });
      replace(res.question);
      replace(res.answer);
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 409 ? 'Someone answered first' : 'Couldn’t send the answer', { description: errorMessage(err) });
    } finally {
      setSending(false);
    }
  };

  if (question.state === 'answered') {
    return (
      <section aria-label="Question" className="space-y-3 rounded-lg border bg-background/60 p-3">
        <AnswerSummary items={question.items} answers={question.answer ?? []} />
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-emerald-500" /> Answered by {question.answeredBy?.displayName ?? 'someone'}
          {question.answeredAt && (
            <>
              {' · '}
              <Time iso={question.answeredAt} />
            </>
          )}
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Question" className="space-y-4 rounded-lg border bg-background/60 p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageCircleQuestion className="size-3.5" /> The agent is waiting for an answer. The first answer decides.
      </p>
      {question.items.map((item, i) => (
        <ItemField key={i} item={item} index={i} value={answers[i]!} disabled={sending} onChange={(v) => setAnswers(answers.map((a, j) => (j === i ? v : a)))} />
      ))}
      <div className="flex justify-end">
        <Button size="sm" onClick={send} disabled={sending || !complete(question.items, answers)}>
          <Send /> Send answer
        </Button>
      </div>
    </section>
  );
}

/** Per option, who chose it; then the "Other" answers. */
function SurveyResults({ survey }: { survey: Survey }) {
  return (
    <div className="space-y-3">
      {survey.items.map((item, i) => {
        const others = survey.responses.filter((r) => r.answers[i]?.other);
        return (
          <div key={i} className="space-y-1">
            <p className="text-xs text-muted-foreground">{item.header}</p>
            <ul className="space-y-0.5 text-sm">
              {item.options.map((o) => {
                const names = survey.responses.filter((r) => r.answers[i]?.selected.includes(o.label)).map((r) => r.user.displayName);
                return (
                  <li key={o.label} className="flex gap-2">
                    <span className="w-6 shrink-0 text-right font-medium tabular-nums">{names.length}</span>
                    <span>
                      {o.label}
                      {names.length > 0 && <span className="text-muted-foreground"> · {names.join(', ')}</span>}
                    </span>
                  </li>
                );
              })}
              {others.map((r) => (
                <li key={r.user.id} className="flex gap-2">
                  <span className="w-6 shrink-0" />
                  <span>
                    “{r.answers[i]!.other}” <span className="text-muted-foreground">· {r.user.displayName}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** An Agent's Survey: one changeable answer per User until every Expected Respondent answered or someone sends it. */
export function SurveyCard({ comment }: { comment: Comment }) {
  const survey = comment.survey!;
  const me = useMe();
  const replace = useReplace(comment.taskId);
  const mine = survey.responses.find((r) => r.user.id === me.data?.id);
  const [answers, setAnswers] = useState<QuestionAnswer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = answers ?? mine?.answers ?? empty(survey.items);
  const missing = survey.expectedRespondents.filter((u) => !survey.responses.some((r) => r.user.id === u.id));
  const answered = survey.expectedRespondents.length - missing.length;

  const act = async (fn: () => Promise<{ comment: Comment }>, failure: string) => {
    setBusy(true);
    try {
      replace((await fn()).comment);
      setAnswers(null);
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 409 ? 'This survey is closed' : failure, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(() => put(`/comments/${comment.id}/response`, { answers: clean(shown) }), 'Couldn’t save your answer');
  const close = () => act(() => post(`/comments/${comment.id}/close`), 'Couldn’t send the survey');

  if (survey.state === 'closed') {
    return (
      <section aria-label="Survey" className="space-y-3 rounded-lg border bg-background/60 p-3">
        <SurveyResults survey={survey} />
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-emerald-500" />
          {survey.closedBy ? `Sent early by ${survey.closedBy.displayName}` : 'Everyone expected answered'}
          {survey.closedAt && (
            <>
              {' · '}
              <Time iso={survey.closedAt} />
            </>
          )}
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Survey" className="space-y-4 rounded-lg border bg-background/60 p-3">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="size-3.5" />
        <span>
          {answered}/{survey.expectedRespondents.length} expected answered
        </span>
        {missing.length > 0 && <span>· waiting for {missing.map((u) => u.displayName).join(', ')}</span>}
      </p>
      {survey.items.map((item, i) => (
        <ItemField key={i} item={item} index={i} value={shown[i]!} disabled={busy} onChange={(v) => setAnswers(shown.map((a, j) => (j === i ? v : a)))} />
      ))}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={close} disabled={busy}>
          <Send /> Send now
        </Button>
        <Button size="sm" onClick={save} disabled={busy || !complete(survey.items, shown) || (!answers && !!mine)}>
          {mine ? 'Update answer' : 'Save answer'}
        </Button>
      </div>
      {survey.responses.length > 0 && (
        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Answers so far</p>
          <SurveyResults survey={survey} />
        </div>
      )}
    </section>
  );
}
