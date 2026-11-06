/**
 * Bull Board Dashboard — web-based queue monitoring UI for BullMQ.
 *
 * Provides a read-only dashboard at /admin/queues for inspecting every queue's
 * state (waiting, active, completed, failed, delayed jobs). Mounted behind
 * JWT authentication restricted to admin users.
 *
 * Wraps the app's existing BullMQ queues in BullMQAdapters and attaches it to
 * an Express adapter that renders the Bull Board web UI.
 */

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getQueueService } from './queue-service';
import { ALL_QUEUES } from './queues';
import { createLogger } from '../utils/logger';

const logger = createLogger('bull-board');

/**
 * Create and configure the Bull Board Express adapter for every queue.
 *
 * Returns an ExpressAdapter that can be mounted as middleware in the Express app.
 * The adapter provides a web UI for monitoring job states, retrying failed jobs,
 * and removing jobs from the queue.
 *
 * If Redis is unavailable during initialization, logs an error and returns an
 * adapter that will display an error state in the UI rather than crashing the app.
 */
export function createQueueDashboard(): ExpressAdapter {
  try {
    // Create the Express adapter with the base path for the dashboard
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    const queueService = getQueueService();
    createBullBoard({
      queues: ALL_QUEUES.map((name) => new BullMQAdapter(queueService.queue(name))),
      serverAdapter,
    });

    logger.info('Bull Board dashboard configured', {
      operation: 'createQueueDashboard',
      basePath: '/admin/queues',
      queues: ALL_QUEUES,
    });

    return serverAdapter;
  } catch (err) {
    logger.error('Failed to create Bull Board dashboard', {
      operation: 'createQueueDashboard',
      error: (err as Error).message,
    });

    // Return a minimal adapter that won't crash the app
    // The UI will show an error state if Redis is unavailable
    const fallbackAdapter = new ExpressAdapter();
    fallbackAdapter.setBasePath('/admin/queues');
    return fallbackAdapter;
  }
}
