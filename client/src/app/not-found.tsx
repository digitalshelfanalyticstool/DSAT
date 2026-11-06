import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export default function NotFound() {
  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-12 bg-surface-secondary">
      <div className="w-full max-w-md">
        <Card className="text-center">
          <h1 className="font-display text-2xl font-semibold text-ink mb-2">
            Page not found
          </h1>
          <p className="text-sm text-ink-muted mb-6">
            We couldn&apos;t find the page you&apos;re looking for. It may have been moved or no longer exists.
          </p>
          <div className="flex items-center justify-center">
            <Link href="/">
              <Button variant="primary">Back to dashboard</Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
