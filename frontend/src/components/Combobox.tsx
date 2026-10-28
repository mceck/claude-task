import { useState } from 'react';
import { ChevronsUpDownIcon } from 'lucide-react';
import { cn } from 'cn';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type ComboboxOption = { value: string; label: string; hint?: string };
export type ComboboxGroup = { label?: string; options: ComboboxOption[] };

/** A picker with a search field inside its popover. Searches the label and the group name. */
export function Combobox({
  value,
  onValueChange,
  groups,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing found.',
  disabled,
  id,
  'aria-label': ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  groups: ComboboxGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = groups.flatMap((g) => g.options).find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          'flex h-9 w-full min-w-0 max-w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          !selected && 'text-muted-foreground',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
        <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {groups.map((g, i) => (
              <CommandGroup key={g.label ?? i} heading={g.label}>
                {g.options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    keywords={[o.label, g.label ?? '']}
                    data-checked={o.value === value}
                    onSelect={() => {
                      onValueChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{o.label}</span>
                    {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
