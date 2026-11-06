import { Badge } from '@/components/ui/Badge';

type Variant = 'default' | 'success' | 'warning' | 'error' | 'info';

const JOB_STATUS_VARIANT: Record<string, Variant> = {
  queued: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

/** A job's status as an upper-case badge, coloured by status. */
export function JobStatusBadge({ status }: Readonly<{ status: string | null | undefined }>) {
  return (
    <Badge variant={(status && JOB_STATUS_VARIANT[status]) || 'default'}>
      {(status || 'unknown').toUpperCase()}
    </Badge>
  );
}
