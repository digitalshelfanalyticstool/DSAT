// PM2 Ecosystem Configuration for Product Scraper
// Defines 1 API server + 2 worker processes (fork mode), totaling 50 concurrent jobs
// Worker processes in this profile: 2 workers at concurrency 25 each (25+25 = 50)
// Optimized for an 8GB VM deployment profile; other environments may use different worker counts

module.exports = {
  apps: [
    // API Server — handles HTTP requests, SSE streaming, BullMQ producer
    {
      name: 'scraper-api',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: 'api',
        DATABASE_POOL_SIZE: '15',
      },
      max_memory_restart: '512M',
      kill_timeout: 30000,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 5000,
    },

    // Worker process 1 (this profile): concurrency 25
    {
      name: 'scraper-worker-1',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: 'worker',
        WORKER_CONCURRENCY: '25',
        DATABASE_POOL_SIZE: '20',
        // Skip Bright Data Scraping Browser when last discovery is younger than
        // 20 hours. Default in code is 6h; bumping to 20h saves 2 Scraping Browser
        // sessions per brand per 24h cycle (the most expensive Bright Data calls).
        // Safe for daily scrape cadence — refresh still happens once per cycle.
        // Drop to 6 if you ever need to scrape the same brand more than once a day.
        DISCOVERY_CACHE_TTL_HOURS: '20',
        // Cap excel-jobs queue concurrency to 1 per process (2 total across the
        // 2-worker profile) so concurrent Excel generations are serialised —
        // flattens the disk-write burst observed in Netdata (149 MiB/s peak).
        EXCEL_WORKER_CONCURRENCY: '1',
        // Cap persist-jobs queue concurrency to 1 per process (2 total) so
        // concurrent INSERT batches are serialised — flattens the second disk
        // burst contributor (Phase 4.5 DB persist) that runs immediately
        // before Excel generation in the scrape pipeline.
        PERSIST_WORKER_CONCURRENCY: '1',
        // ── Per-site rate-limit ceiling ──
        // Each site is capped at 25 concurrent scraping sessions (15 by default
        // in rate-limiter.ts): 50% of the 50-slot worker capacity. Override one
        // site with RATE_LIMIT_<SITE>_MAX_CONCURRENT.
        RATE_LIMIT_MAX_CONCURRENT: '25',
      },
      max_memory_restart: '1024M',
      // Aligned with config.worker.shutdownTimeoutMs (65 min default) so PM2
      // doesn't SIGKILL a worker mid-job. Worst case a deploy waits up to 65 min
      // for an in-flight scrape to finish; common case is seconds (idle worker
      // exits immediately on SIGTERM). The previous value of 60000 (60s) caused
      // BullMQ-stalled retries and lost progress every restart with active jobs.
      kill_timeout: 3900000,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 5000,
    },

    // Worker process 2 (this profile): concurrency 25
    {
      name: 'scraper-worker-2',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: 'worker',
        WORKER_CONCURRENCY: '25',
        DATABASE_POOL_SIZE: '20',
        // Skip Bright Data Scraping Browser when last discovery is younger than
        // 20 hours. Default in code is 6h; bumping to 20h saves 2 Scraping Browser
        // sessions per brand per 24h cycle (the most expensive Bright Data calls).
        // Safe for daily scrape cadence — refresh still happens once per cycle.
        // Drop to 6 if you ever need to scrape the same brand more than once a day.
        DISCOVERY_CACHE_TTL_HOURS: '20',
        // Cap excel-jobs queue concurrency to 1 per process (2 total across the
        // 2-worker profile) so concurrent Excel generations are serialised —
        // flattens the disk-write burst observed in Netdata (149 MiB/s peak).
        EXCEL_WORKER_CONCURRENCY: '1',
        // Cap persist-jobs queue concurrency to 1 per process (2 total) so
        // concurrent INSERT batches are serialised — flattens the second disk
        // burst contributor (Phase 4.5 DB persist) that runs immediately
        // before Excel generation in the scrape pipeline.
        PERSIST_WORKER_CONCURRENCY: '1',
        // ── Per-site rate-limit ceiling ──
        // Each site is capped at 25 concurrent scraping sessions (15 by default
        // in rate-limiter.ts): 50% of the 50-slot worker capacity. Override one
        // site with RATE_LIMIT_<SITE>_MAX_CONCURRENT.
        RATE_LIMIT_MAX_CONCURRENT: '25',
      },
      max_memory_restart: '1024M',
      // Aligned with config.worker.shutdownTimeoutMs (65 min default) so PM2
      // doesn't SIGKILL a worker mid-job. Worst case a deploy waits up to 65 min
      // for an in-flight scrape to finish; common case is seconds (idle worker
      // exits immediately on SIGTERM). The previous value of 60000 (60s) caused
      // BullMQ-stalled retries and lost progress every restart with active jobs.
      kill_timeout: 3900000,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 5000,
    },
  ],
};
