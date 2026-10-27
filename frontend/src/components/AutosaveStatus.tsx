import { Button } from '@/components/ui/button';

export function AutosaveStatus({ status, error, flush, label }: {
  status: 'saved' | 'pending' | 'saving' | 'error';
  error: string;
  flush: () => Promise<void>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <p role="status" aria-label={label} className="text-xs text-muted-foreground">
        {status === 'error' ? `Couldn’t save: ${error}` : status === 'saved' ? 'All changes saved' : 'Saving…'}
      </p>
      {status === 'error' && <Button type="button" variant="outline" size="sm" onClick={() => void flush()}>Retry</Button>}
    </div>
  );
}
