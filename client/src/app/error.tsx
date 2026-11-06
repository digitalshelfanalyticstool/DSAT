'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

type ErrorPageProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('App error boundary caught:', error);
  }, [error]);

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-12 bg-surface-secondary">
      <div className="w-full max-w-md">
        <Card className="text-center">
          <h1 className="font-display text-2xl font-semibold text-ink mb-2">
            Something went wrong
          </h1>
          <p className="text-sm text-ink-muted mb-6">
            Sorry, an unexpected error occurred. You can try again or head back to the dashboard.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="primary" onClick={() => reset()}>
              Retry
            </Button>
            <Link href="/">
              <Button variant="outline">Back to dashboard</Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
