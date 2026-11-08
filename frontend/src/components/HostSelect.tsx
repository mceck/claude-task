import type { Host } from '@claude-task/shared';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const selectableHost = (host: Host) => host.kind !== 'local' || host.error !== 'Local Host disabled (LOCAL_HOST=false)';
export function defaultHostId(hosts: Host[] | undefined): string {
  const choices = hosts?.filter(selectableHost) ?? [];
  return choices.find((host) => host.kind === 'local')?.id ?? (choices.length === 1 ? choices[0]!.id : '');
}
export function HostSelect({
  hosts,
  value,
  onChange,
  disabled,
}: {
  hosts: Host[] | undefined;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label="Host" className="w-full">
        <SelectValue placeholder="Choose a host" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {hosts
            ?.filter((host) => selectableHost(host) || host.id === value)
            .map((host) => (
              <SelectItem key={host.id} value={host.id} disabled={!selectableHost(host)}>
                {host.name}
              </SelectItem>
            ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
