import { ChevronDown } from 'lucide-react';
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
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  const active = highlight && selected.length > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList aria-label={label}>
            <CommandEmpty>Nothing found.</CommandEmpty>
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
