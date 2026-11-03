import type { SessionSkill } from '@claude-task/shared';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { errorMessage, get } from '../api/client';
import { Loading } from './common';

/** The Skills dialog of a Task: every Skill of its Session and who activated it (docs/specs/agents.md). */
export function TaskSkillsDialog({ taskId, open, onOpenChange }: { taskId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [skills, setSkills] = useState<SessionSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read on every open: Skills are activated during Jobs and Turns.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSkills(null);
    setError(null);
    get<{ skills: SessionSkill[] }>(`/tasks/${taskId}/skills`)
      .then(({ skills }) => !cancelled && setSkills(skills))
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  const used = skills?.filter((skill) => skill.usedBy.length > 0).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>Every skill available in this session. A filled dot marks the ones that were used.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <Loading className="p-6" />
        ) : error ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">{error}</p>
        ) : !skills || skills.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">No skills are available in this session.</p>
        ) : (
          <>
            <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
              {skills.map((skill) => (
                <SkillCard key={skill.name} skill={skill} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {used} of {skills.length} used
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SkillCard({ skill }: { skill: SessionSkill }) {
  const used = skill.usedBy.length > 0;
  const who =
    skill.usedBy.length === 2
      ? 'Used by you and the agent'
      : skill.usedBy[0] === 'agent'
        ? 'Used by the agent'
        : skill.usedBy[0] === 'user'
          ? 'Used by you'
          : 'Not used yet';
  return (
    <div title={who} className={cn('rounded-md border p-2.5', used && 'border-primary/40 bg-primary/5')}>
      <div className="flex items-center gap-2">
        <span aria-label={who} className={cn('size-2.5 shrink-0 rounded-full', used ? 'bg-primary' : 'border border-muted-foreground/60')} />
        <span className="truncate text-sm font-medium">{skill.name}</span>
      </div>
      {skill.description && <p className="mt-1 line-clamp-2 pl-[1.125rem] text-xs leading-snug text-muted-foreground">{skill.description}</p>}
    </div>
  );
}
