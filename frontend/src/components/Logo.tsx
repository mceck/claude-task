import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 to-violet-600 shadow-md shadow-indigo-500/20',
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="size-4 text-white" fill="currentColor" aria-hidden>
        <rect x="2" y="3" width="3" height="10" rx="1" />
        <rect x="6.5" y="3" width="3" height="6" rx="1" />
        <rect x="11" y="3" width="3" height="8" rx="1" />
      </svg>
    </span>
  );
}
