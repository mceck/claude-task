import { SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage({ what = 'Page' }: { what?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <SearchX className="size-10 text-muted-foreground" />
      <p className="text-lg font-medium">{what} not found</p>
      <Button asChild variant="outline">
        <Link to="/">Back to projects</Link>
      </Button>
    </div>
  );
}
