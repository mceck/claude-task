import type { Skill } from '@claude-task/shared';
import { Check, ChevronDown, ExternalLink, FolderGit2, Minus, Search, Sparkles, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '../api/client';
import { useSkills } from '../api/queries';

/** Native checkboxes retain keyboard support and expose partial selection to assistive technology. */
function SelectionCheckbox({ checked, onChange, label }: {
  checked: boolean | 'mixed';
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <span className="relative mt-0.5 inline-flex size-4 shrink-0">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked === true}
        ref={(input) => { if (input) input.indeterminate = checked === 'mixed'; }}
        onChange={(event) => onChange(event.target.checked)}
        className="peer size-4 cursor-pointer appearance-none rounded-[5px] border border-input bg-background transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      {checked !== false && (
        checked === 'mixed'
          ? <Minus aria-hidden="true" className="pointer-events-none absolute inset-0 size-4 p-0.5 text-primary-foreground" strokeWidth={3} />
          : <Check aria-hidden="true" className="pointer-events-none absolute inset-0 size-4 p-0.5 text-primary-foreground" strokeWidth={3} />
      )}
    </span>
  );
}

function selectionState(selected: number, total: number): boolean | 'mixed' {
  return selected === 0 ? false : selected === total ? true : 'mixed';
}

export function AgentSkillSelector({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const query = useSkills();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const updateSearch = (value: string) => {
    setSearch(value);
    setCollapsed(new Set());
  };
  const headingId = useId();
  const skills = query.data ?? [];
  const selected = new Set(selectedIds);
  const selectedCount = skills.filter((skill) => selected.has(skill.id)).length;
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) {
    const group = groups.get(skill.source) ?? [];
    group.push(skill);
    groups.set(skill.source, group);
  }
  const term = search.trim().toLowerCase();
  const visibleGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, items]) => ({
      source,
      items,
      visible: items
        .filter((skill) => `${skill.name} ${skill.description} ${source}`.toLowerCase().includes(term))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.visible.length > 0);
  const toggleSkills = (items: Skill[], checked: boolean) => {
    const next = new Set(selectedIds);
    for (const item of items) {
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    onChange([...next]);
  };

  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-2xl border bg-background/40 shadow-sm">
      <div className="space-y-4 bg-gradient-to-br from-primary/8 via-primary/3 to-transparent p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
              <Sparkles aria-hidden="true" className="size-5" />
            </div>
            <div>
              <h2 id={headingId} className="text-sm font-semibold">Skills</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Choose what this agent can do, one skill or a whole source at a time.</p>
            </div>
          </div>
          <span role="status" className="rounded-full border border-primary/15 bg-primary/10 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-primary">
            {selectedCount} selected
          </span>
        </div>
        {skills.length > 0 && (
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search skills"
              placeholder="Search skills or sources…"
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
              className="h-10 bg-background/80 pr-10 pl-9 dark:bg-background/50"
            />
            {search && (
              <Button type="button" variant="ghost" size="icon" aria-label="Clear skill search" onClick={() => updateSearch('')} className="absolute top-1/2 right-1 size-8 -translate-y-1/2">
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      {query.isPending ? (
        <div role="status" aria-label="Loading skills" className="space-y-3 border-t p-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : query.error ? (
        <p role="alert" className="border-t p-4 text-sm text-destructive">{errorMessage(query.error)}</p>
      ) : skills.length === 0 ? (
        <div className="space-y-1 border-t px-5 py-8 text-center">
          <p className="text-sm font-medium">Build this agent’s toolkit</p>
          <p className="text-xs text-muted-foreground">Import skills from a source to start assigning them here.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-y bg-muted/25 px-4 py-3 sm:px-5">
            <label className="flex cursor-pointer items-start gap-2.5 text-xs font-medium">
              <SelectionCheckbox label="Select all skills" checked={selectionState(selectedCount, skills.length)} onChange={(checked) => toggleSkills(skills, checked)} />
              <span className="pt-0.5">Select all <span className="ml-1 font-normal text-muted-foreground">across all sources</span></span>
            </label>
            <span className="text-xs text-muted-foreground">{skills.length} skills · {groups.size} {groups.size === 1 ? 'source' : 'sources'}</span>
          </div>
          <div className="max-h-[28rem] space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
            {visibleGroups.length === 0 ? (
              <div className="space-y-1 py-8 text-center">
                <Search aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground/60" />
                <p className="text-sm font-medium">No matching skills</p>
                <p className="text-xs text-muted-foreground">Try another name, description or source.</p>
                <Button type="button" variant="link" size="sm" onClick={() => updateSearch('')}>Clear search</Button>
              </div>
            ) : visibleGroups.map(({ source, items, visible }) => {
              const count = items.filter((skill) => selected.has(skill.id)).length;
              const expanded = !collapsed.has(source);
              return (
                <SkillSourceGroup
                  key={source}
                  source={source}
                  items={items}
                  visible={visible}
                  selected={selected}
                  count={count}
                  expanded={expanded}
                  onSelect={(checked) => toggleSkills(items, checked)}
                  onToggle={() => setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(source)) next.delete(source);
                    else next.add(source);
                    return next;
                  })}
                  onSelectSkill={(skill, checked) => toggleSkills([skill], checked)}
                />
              );
            })}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 px-4 py-3 text-xs text-muted-foreground sm:px-5">
        <span>Skills are applied when you save the agent.</span>
        <Link to="/admin/extensions" className="inline-flex items-center gap-1.5 font-medium text-primary transition-colors hover:text-primary/80">
          Manage skills <ExternalLink aria-hidden="true" className="size-3" />
        </Link>
      </div>
    </section>
  );
}

function SkillSourceGroup({ source, items, visible, selected, count, expanded, onSelect, onToggle, onSelectSkill }: {
  source: string;
  items: Skill[];
  visible: Skill[];
  selected: Set<string>;
  count: number;
  expanded: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: () => void;
  onSelectSkill: (skill: Skill, checked: boolean) => void;
}) {
  const contentId = useId();
  return (
    <div role="group" aria-label={`Skills from ${source}`} className={`overflow-hidden rounded-xl border transition-colors ${count > 0 ? 'border-primary/25' : 'border-border'}`}>
      <div className={`flex items-center gap-3 px-3 py-3 transition-colors ${count > 0 ? 'bg-primary/5' : 'bg-muted/30'}`}>
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          <SelectionCheckbox label={`Select all skills from ${source}`} checked={selectionState(count, items.length)} onChange={onSelect} />
          <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-primary/80" />
          <span className="min-w-0 break-all font-mono text-xs font-medium leading-relaxed">{source}</span>
        </label>
        <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium tabular-nums ${count > 0 ? 'bg-primary/10 text-primary' : 'bg-background/80 text-muted-foreground'}`} aria-label={`${count} of ${items.length} selected`}>
          {count} / {items.length}
        </span>
        <Button type="button" variant="ghost" size="icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${source}`} aria-expanded={expanded} aria-controls={contentId} onClick={onToggle} className="size-7 shrink-0 text-muted-foreground">
          <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? '' : '-rotate-90'}`} />
        </Button>
      </div>
      <div id={contentId} hidden={!expanded}>
        <div className="grid gap-1.5 border-t bg-card/60 p-2 sm:grid-cols-2">
          {visible.map((skill) => (
            <label key={skill.id} className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${selected.has(skill.id) ? 'border-primary/20 bg-primary/6 hover:bg-primary/10' : 'border-transparent hover:border-border hover:bg-muted/50'}`}>
              <SelectionCheckbox label={skill.name} checked={selected.has(skill.id)} onChange={(checked) => onSelectSkill(skill, checked)} />
              <span className="min-w-0 space-y-1">
                <span className={`block break-all text-xs font-medium ${selected.has(skill.id) ? 'text-primary' : ''}`}><span className="mr-0.5 text-muted-foreground/60">/</span>{skill.name}</span>
                {skill.description && <span title={skill.description} className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
