import type { Priority, User } from '@claude-task/shared';
import { CircleAlert, Loader2, Minus, SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUsers } from '../api/queries';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

const AVATAR_HUES = [12, 40, 145, 190, 230, 280, 320];

/** Initials on a color derived from the person, stable across sessions. */
export function UserAvatar({
  user,
  name,
  size = 'sm',
  className,
}: {
  user?: Pick<User, 'id' | 'displayName'> & Partial<Pick<User, 'avatarImageUrl'>>;
  name?: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const users = useUsers();
  const imageUrl = user?.avatarImageUrl === undefined
    ? users.data?.find((u) => u.id === user?.id)?.avatarImageUrl
    : user.avatarImageUrl;
  const label = user?.displayName ?? name ?? '?';
  const seed = [...(user?.id ?? label)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue = AVATAR_HUES[seed % AVATAR_HUES.length]!;
  return (
    <Avatar
      title={label}
      className={cn(
        'ring-2 ring-background',
        size === 'xs' ? 'size-5' : size === 'sm' ? 'size-6' : 'size-8',
        className,
      )}
    >
      {imageUrl ? <AvatarImage src={imageUrl} alt="" className="object-cover" /> : null}
      <AvatarFallback
        className={cn('font-semibold text-white', size === 'md' ? 'text-xs' : 'text-[10px]')}
        style={{ background: `linear-gradient(135deg, oklch(0.62 0.15 ${hue}), oklch(0.5 0.16 ${hue + 25}))` }}
      >
        {initials(label)}
      </AvatarFallback>
    </Avatar>
  );
}

export const PRIORITY_STYLE: Record<Priority, { label: string; icon: LucideIcon; className: string }> = {
  urgent: { label: 'Urgent', icon: CircleAlert, className: 'text-red-500' },
  high: { label: 'High', icon: SignalHigh, className: 'text-orange-400' },
  normal: { label: 'Normal', icon: SignalMedium, className: 'text-sky-400' },
  low: { label: 'Low', icon: SignalLow, className: 'text-muted-foreground' },
  none: { label: 'No priority', icon: Minus, className: 'text-muted-foreground/60' },
};

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const p = PRIORITY_STYLE[priority];
  const Icon = p.icon;
  return <Icon aria-label={`Priority: ${p.label}`} className={cn('size-3.5 shrink-0', p.className, className)} />;
}

export function TagChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium text-foreground/80">
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

export function StatusDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full ring-2', className)}
      style={{ backgroundColor: color, ['--tw-ring-color' as string]: `${color}33` }}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Loading({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center p-10 text-muted-foreground', className)}>
      <Loader2 className="size-5 animate-spin" aria-label="Loading" />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function timeAgo(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

export function Time({ iso, className }: { iso: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} className={className}>
          {timeAgo(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{new Date(iso).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}

// Confirmation dialogs

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) ...` */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => {});
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOptions(o);
      }),
    [],
  );
  const close = (ok: boolean) => {
    resolver.current(ok);
    setOptions(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!options} onOpenChange={(open) => !open && close(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={options?.destructive ? 'destructive' : 'default'} onClick={() => close(true)}>
              {options?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
