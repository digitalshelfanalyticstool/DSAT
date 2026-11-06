'use client';

import { useEffect } from 'react';
import { reportWebVitals } from '@/lib/web-vitals';

/**
 * Mount once at the root of the app to subscribe to Core Web Vitals
 * and forward samples to the server. Renders nothing.
 *
 * The empty-deps `useEffect` ensures we only register listeners a single
 * time per page lifecycle. The web-vitals library itself handles the
 * "fire on visibility change / pagehide" semantics — we don't need to.
 */
export default function WebVitalsReporter(): null {
  useEffect(() => {
    reportWebVitals();
  }, []);
  return null;
}
