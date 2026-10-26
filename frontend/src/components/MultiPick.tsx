import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface PickOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

/** A searchable multi-select in a popover. */
export function MultiPick({
  label,
  options,
  selected,
  onChange,
  trigger,
  highlight = true,
  icon,
  onCreate,
  createNoun = 'option',
}: {
  label: string;
  options: PickOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Replaces the default button. */
  trigger?: ReactNode;
  /** Tint the button while something is selected (for filters). */
  highlight?: boolean;
  icon?: ReactNode;
  /** When set, a search that matches no option offers to create it. */
  onCreate?: (name: string) => Promise<void> | void;
  createNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const typed = search.trim();
  const canCreate = !!onCreate && typed.length > 0 && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const create = async () => {
    if (!onCreate || creating) return;
    setCreating(true);
    try {
      await onCreate(typed);
      setSearch('');
    } finally {
      setCreating(false);
    }
  };
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  const active = highlight && selected.length > 0;
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), !o && setSearch(''))}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            variant="outline"
            size="sm"
            className={cn('border-dashed', active && 'border-solid border-primary/50 bg-primary/10 text-primary hover:bg-primary/15 dark:bg-primary/10')}
          >
            {icon}
            {label}
            {selected.length > 0 && (
              <span className="rounded bg-primary/20 px-1 font-mono text-[10px] text-primary">{selected.length}</span>
            )}
            <ChevronDown className="opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={`${onCreate ? 'Search or create' : 'Search'} ${label.toLowerCase()}…`} value={search} onValueChange={setSearch} />
          <CommandList aria-label={label}>
            <CommandEmpty>{canCreate ? null : 'Nothing found.'}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const isSelected = selected.includes(o.value);
                return (
                  <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => toggle(o.value)} data-checked={isSelected}>
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {canCreate && (
              <CommandGroup>
                <CommandItem value={`create ${typed}`} forceMount disabled={creating} onSelect={() => void create()}>
                  <Plus />
                  <span className="truncate">Create {createNoun} “{typed}”</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
          {selected.length > 0 && (
            <div className="border-t p-1">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange([])}>
                Clear
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
