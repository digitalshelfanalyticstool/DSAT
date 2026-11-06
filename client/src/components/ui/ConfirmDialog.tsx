'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

type ConfirmVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'warning';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ConfirmVariant;
  onConfirm: () => void | Promise<void>;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onClose,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  onConfirm,
}) => {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    try {
      setSubmitting(true);
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-ink-muted">{message}</div>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={handleConfirm} disabled={submitting}>
            {submitting ? 'Working...' : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export interface UseConfirmOptions {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ConfirmVariant;
}

export interface UseConfirmReturn {
  confirm: (opts: UseConfirmOptions) => Promise<boolean>;
  ConfirmDialogHost: React.FC;
}

export function useConfirm(): UseConfirmReturn {
  const [opts, setOpts] = useState<UseConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: UseConfirmOptions): Promise<boolean> => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const resolve = useCallback((value: boolean) => {
    setOpen(false);
    const fn = resolverRef.current;
    resolverRef.current = null;
    fn?.(value);
  }, []);

  const ConfirmDialogHost: React.FC = useCallback(() => {
    if (!opts) return null;
    return (
      <ConfirmDialog
        open={open}
        onClose={() => resolve(false)}
        title={opts.title}
        message={opts.message}
        confirmLabel={opts.confirmLabel}
        cancelLabel={opts.cancelLabel}
        confirmVariant={opts.confirmVariant}
        onConfirm={async () => resolve(true)}
      />
    );
  }, [opts, open, resolve]);

  return { confirm, ConfirmDialogHost };
}
