import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50/50 to-orange-300/50 dark:from-orange-800/20 dark:to-orange-950/20 shadow-md shadow-indigo-500/20',
        className,
      )}
    >
      <img src="/app-icon.png" alt="Claude Task" className="size-6" />
    </span>
  );
}
