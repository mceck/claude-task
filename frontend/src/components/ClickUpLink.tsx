import { CLICKUP_SOURCE_TYPES } from '@claude-task/shared';
import type { ClickUpLinkBody, ClickUpOption, ClickUpSourceType } from '@claude-task/shared';
import { useQuery } from '@tanstack/react-query';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage, get } from '../api/client';

export type ClickUpDraft = { credentialId: string; teamId: string; spaceId: string; sourceType: ClickUpSourceType; sourceId: string; query: string };
export const EMPTY_CLICKUP: ClickUpDraft = { credentialId: '', teamId: '', spaceId: '', sourceType: 'list', sourceId: '', query: '' };

const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';

export function useClickUpCredentials() {
  return useQuery({
    queryKey: ['clickup', 'credentials'],
    queryFn: () => get<{ credentials: { id: string; name: string; last4: string }[] }>('/clickup/credentials').then((r) => r.credentials),
  });
}

function useOptions(path: string, params: Record<string, string>, enabled: boolean) {
  const search = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['clickup', path, search],
    queryFn: () => get<{ options: ClickUpOption[] }>(`/clickup/${path}?${search}`).then((r) => r.options),
    enabled,
  });
}

/** The body the API wants, or null while the choice is incomplete. */
export function clickUpBody(d: ClickUpDraft): ClickUpLinkBody | null {
  if (!d.credentialId || !d.teamId || !d.sourceId) return null;
  return { credentialId: d.credentialId, teamId: d.teamId, sourceType: d.sourceType, sourceId: d.sourceId, query: d.query.trim() };
}

/** Token, workspace, List or View, and the filter query of a ClickUp link. */
export function ClickUpLinkFields({ value, onChange, disabled }: { value: ClickUpDraft; onChange: (v: ClickUpDraft) => void; disabled?: boolean }) {
  const credentials = useClickUpCredentials();
  const ready = !!value.credentialId;
  const teams = useOptions('teams', { credentialId: value.credentialId }, ready);
  const spaces = useOptions('spaces', { credentialId: value.credentialId, teamId: value.teamId }, ready && !!value.teamId);
  const lists = useOptions('lists', { credentialId: value.credentialId, spaceId: value.spaceId }, ready && value.sourceType === 'list' && !!value.spaceId);
  const views = useOptions('views', { credentialId: value.credentialId, teamId: value.teamId }, ready && value.sourceType === 'view' && !!value.teamId);
  const set = (patch: Partial<ClickUpDraft>) => onChange({ ...value, ...patch });
  const picker = (label: string, current: string, options: ClickUpOption[] | undefined, onPick: (id: string) => void, loading?: boolean) => (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <select aria-label={label} className={selectClass} disabled={disabled || loading} value={current} onChange={(e) => onPick(e.target.value)}>
        <option value="">{loading ? 'Loading…' : `Choose ${label.toLowerCase()}`}</option>
        {options?.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </Field>
  );
  const error = [teams, spaces, lists, views].find((q) => q.error)?.error;
  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel>ClickUp token</FieldLabel>
        <select
          aria-label="ClickUp token"
          className={selectClass}
          disabled={disabled}
          value={value.credentialId}
          onChange={(e) => onChange({ ...EMPTY_CLICKUP, credentialId: e.target.value })}
        >
          <option value="">Choose a token</option>
          {credentials.data?.map((c) => (
            <option key={c.id} value={c.id}>{c.name} · …{c.last4}</option>
          ))}
        </select>
      </Field>
      {ready && picker('Workspace', value.teamId, teams.data, (teamId) => set({ teamId, spaceId: '', sourceId: '' }), teams.isPending)}
      {ready && value.teamId && (
        <Field>
          <FieldLabel>Source</FieldLabel>
          <select
            aria-label="Source type"
            className={selectClass}
            disabled={disabled}
            value={value.sourceType}
            onChange={(e) => set({ sourceType: e.target.value as ClickUpSourceType, sourceId: '' })}
          >
            {CLICKUP_SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>{t === 'list' ? 'A List' : 'A View'}</option>
            ))}
          </select>
        </Field>
      )}
      {ready && value.teamId && value.sourceType === 'list' && picker('Space', value.spaceId, spaces.data, (spaceId) => set({ spaceId, sourceId: '' }), spaces.isPending)}
      {ready && value.sourceType === 'list' && value.spaceId && picker('List', value.sourceId, lists.data, (sourceId) => set({ sourceId }), lists.isPending)}
      {ready && value.sourceType === 'view' && value.teamId && picker('View', value.sourceId, views.data, (sourceId) => set({ sourceId }), views.isPending)}
      {value.sourceType === 'list' && (
        <Field>
          <FieldLabel htmlFor="clickup-query">Filters</FieldLabel>
          <Input
            id="clickup-query"
            placeholder="assignees[]=123&tags[]=backend&include_closed=true"
            value={value.query}
            maxLength={2000}
            disabled={disabled}
            onChange={(e) => set({ query: e.target.value })}
          />
          <FieldDescription>
            ClickUp filters as a query string: statuses, assignees, tags, dates, include_closed, subtasks, custom_fields, order_by, reverse. ClickUp’s defaults apply otherwise.
          </FieldDescription>
        </Field>
      )}
      {value.sourceType === 'view' && <p className="text-xs text-muted-foreground">A View brings its own filters.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p>}
    </div>
  );
}
