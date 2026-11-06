/**
 * Load Testing Script — Product Scraper
 *
 * Modes:
 *   Burst (default):    100 concurrent logins + 35 concurrent job creations
 *   Sustained:          Continuous mixed load for a configurable duration
 *
 * Usage:
 *   npx tsx server/src/scripts/load-test.ts --base-url http://localhost:3001
 *   npx tsx server/src/scripts/load-test.ts --sustained --duration 600
 *
 * Flags:
 *   --base-url <url>      Server URL (default: http://localhost:3001)
 *   --username <user>     Login username (default: admin)
 *   --password <pass>     Login password (default: admin)
 *   --site <site>         Site for job creation (default: example-shop)
 *   --brand <brand>       Brand for job creation (default: Example Brand)
 *   --token <jwt>         Pre-authenticated JWT token (skips login)
 *   --sustained           Enable sustained load mode
 *   --duration <seconds>  Sustained mode duration (default: 600 = 10 min)
 */

interface LoadTestConfig {
  baseUrl: string;
  username: string;
  password: string;
  token: string;
  loginConcurrency: number;
  jobConcurrency: number;
  site: string;
  brand: string;
  sustained: boolean;
  durationSec: number;
}

interface RequestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  type: 'login' | 'job';
}

interface ScenarioReport {
  scenario: string;
  totalRequests: number;
  successful: number;
  failed: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  requestsPerSecond: number;
  durationMs: number;
  errors: Record<string, number>;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- intrinsic complexity: exhaustive CLI arg parser. The 8 branches are 1:1 with the supported flags; there is no test coverage for this dev-only load-test script, so a "trivial" table-dispatch refactor would land unverified. CLAUDE.md "strongly consider NOSONAR for any refactor candidate without test coverage" applies. NOSONAR(typescript:S3776).
function parseArgs(): LoadTestConfig {
  const args = process.argv.slice(2);
  let baseUrl = 'http://localhost:3001';
  let username = 'admin';
  let password = process.env.LOAD_TEST_PASSWORD || 'admin';
  let token = '';
  let site = 'example-shop';
  let brand = 'Example Brand';
  let sustained = false;
  let durationSec = 600;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-url' && args[i + 1]) baseUrl = args[++i];
    if (args[i] === '--username' && args[i + 1]) username = args[++i];
    if (args[i] === '--password' && args[i + 1]) password = args[++i];
    if (args[i] === '--token' && args[i + 1]) token = args[++i];
    if (args[i] === '--site' && args[i + 1]) site = args[++i];
    if (args[i] === '--brand' && args[i + 1]) brand = args[++i];
    if (args[i] === '--sustained') sustained = true;
    if (args[i] === '--duration' && args[i + 1]) durationSec = Number.parseInt(args[++i], 10);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    username, password, token, site, brand, sustained, durationSec,
    loginConcurrency: 100, jobConcurrency: 35,
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildReport(scenario: string, results: RequestResult[], durationMs: number): ScenarioReport {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successful = results.filter((r) => r.ok).length;
  const errors: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok && r.error) errors[r.error] = (errors[r.error] || 0) + 1;
  }
  return {
    scenario, totalRequests: results.length, successful, failed: results.length - successful,
    minLatencyMs: latencies[0] ?? 0, maxLatencyMs: latencies.at(-1) ?? 0,
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)),
    p50LatencyMs: pct(latencies, 50), p95LatencyMs: pct(latencies, 95), p99LatencyMs: pct(latencies, 99),
    requestsPerSecond: Math.round((results.length / (durationMs / 1000)) * 100) / 100,
    durationMs, errors,
  };
}

function printReport(report: ScenarioReport): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${report.scenario}`);
  console.log('═'.repeat(60));
  console.log(`  Total requests:    ${report.totalRequests}`);
  console.log(`  Successful:        ${report.successful}`);
  console.log(`  Failed:            ${report.failed}`);
  console.log(`  Duration:          ${(report.durationMs / 1000).toFixed(2)}s`);
  console.log(`  Requests/sec:      ${report.requestsPerSecond}`);
  console.log(`  Latency (min):     ${report.minLatencyMs}ms`);
  console.log(`  Latency (avg):     ${report.avgLatencyMs}ms`);
  console.log(`  Latency (p50):     ${report.p50LatencyMs}ms`);
  console.log(`  Latency (p95):     ${report.p95LatencyMs}ms`);
  console.log(`  Latency (p99):     ${report.p99LatencyMs}ms`);
  console.log(`  Latency (max):     ${report.maxLatencyMs}ms`);
  if (Object.keys(report.errors).length > 0) {
    console.log('  Errors:');
    for (const [err, count] of Object.entries(report.errors)) {
      console.log(`    ${err}: ${count}`);
    }
  }
  console.log('═'.repeat(60));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function login(baseUrl: string, username: string, password: string): Promise<RequestResult & { token?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const latencyMs = Math.round(performance.now() - start);
    const body = await res.json() as { token?: string; success?: boolean; message?: string };
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      type: 'login',
      token: body.token,
      error: res.ok ? undefined : (body.message ?? `HTTP ${res.status}`),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), type: 'login', error: message };
  }
}

async function createJob(
  baseUrl: string, token: string, site: string, brand: string,
): Promise<RequestResult & { jobId?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ site, brand }),
    });
    const latencyMs = Math.round(performance.now() - start);
    const body = await res.json() as { job?: { job_id?: string }; message?: string };
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      type: 'job',
      jobId: body.job?.job_id,
      error: res.ok ? undefined : (body.message ?? `HTTP ${res.status}`),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), type: 'job', error: message };
  }
}

async function listJobs(baseUrl: string, token: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const latencyMs = Math.round(performance.now() - start);
    await res.text(); // drain body
    return {
      ok: res.ok, status: res.status, latencyMs, type: 'job',
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), type: 'job', error: message };
  }
}

async function healthCheck(baseUrl: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const latencyMs = Math.round(performance.now() - start);
    await res.text();
    return {
      ok: res.ok, status: res.status, latencyMs, type: 'login',
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), type: 'login', error: message };
  }
}

async function sseConnect(
  baseUrl: string, token: string, jobId: string, timeoutMs: number = 5000,
): Promise<RequestResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - start);
    // Read a small chunk to confirm the connection is live
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read();
      reader.releaseLock();
    }
    clearTimeout(timer);
    return {
      ok: res.ok, status: res.status, latencyMs, type: 'job',
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    // AbortError is expected — we intentionally time out SSE connections
    const isAbort = message.includes('abort');
    return {
      ok: isAbort, status: isAbort ? 200 : 0,
      latencyMs: Math.round(performance.now() - start),
      type: 'job',
      error: isAbort ? undefined : message,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Auth helper — login or use pre-supplied token
// ---------------------------------------------------------------------------

async function authenticate(config: LoadTestConfig): Promise<string> {
  if (config.token) {
    // Verify the token works with a quick API call
    const probe = await listJobs(config.baseUrl, config.token);
    if (probe.ok) {
      console.log('✅ Pre-supplied token is valid\n');
      return config.token;
    }
    console.error(`❌ Supplied --token is invalid or expired (HTTP ${probe.status})`);
    process.exit(1);
  }

  console.log('⏳ Authenticating...');
  const authResult = await login(config.baseUrl, config.username, config.password);
  if (!authResult.ok || !authResult.token) {
    const httpError = `HTTP ${authResult.status}`;
    const rawDetail = authResult.error ?? httpError;
    // Sanitize before logging: server response is technically attacker-influencable
    // via crafted credentials, so strip control characters + cap length to keep
    // CRLF / ANSI escapes out of operator terminals.
    const safeDetail = Array.from(String(rawDetail)).filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('').slice(0, 200);
    console.error(`❌ Login failed: ${safeDetail}`);
    console.error('   Check --username / --password, or pass --token <jwt> directly.');
    process.exit(1);
  }
  console.log(`✅ Authenticated (${authResult.latencyMs}ms)\n`);
  return authResult.token;
}

// ---------------------------------------------------------------------------
// Burst mode — fires all requests at once, measures throughput
// ---------------------------------------------------------------------------

async function runBurst(config: LoadTestConfig): Promise<void> {
  console.log('\n🚀 BURST MODE — Load Test');
  console.log(`   Target: ${config.baseUrl}`);
  console.log(`   Job list concurrency: ${config.loginConcurrency}`);
  console.log(`   Job create concurrency: ${config.jobConcurrency}\n`);

  const token = await authenticate(config);

  // Phase 1: Concurrent job list requests (read-heavy burst)
  console.log(`⏳ Phase 1: ${config.loginConcurrency} concurrent GET /api/jobs...`);
  const listStart = performance.now();
  const listResults = await Promise.allSettled(
    Array.from({ length: config.loginConcurrency }, () =>
      listJobs(config.baseUrl, token),
    ),
  );
  const listDuration = performance.now() - listStart;

  const listOutcomes: RequestResult[] = listResults.map((r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, status: 0, latencyMs: 0, type: 'job' as const, error: r.reason?.message },
  );
  const listReport = buildReport('Burst: Concurrent Job Listings', listOutcomes, listDuration);
  printReport(listReport);

  // Phase 2: Concurrent job creations
  console.log(`\n⏳ Phase 2: ${config.jobConcurrency} concurrent POST /api/jobs...`);
  const jobStart = performance.now();
  const jobResults = await Promise.allSettled(
    Array.from({ length: config.jobConcurrency }, () =>
      createJob(config.baseUrl, token, config.site, config.brand),
    ),
  );
  const jobDuration = performance.now() - jobStart;

  const jobOutcomes: RequestResult[] = jobResults.map((r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, status: 0, latencyMs: 0, type: 'job' as const, error: r.reason?.message },
  );
  const jobReport = buildReport('Burst: Concurrent Job Creations', jobOutcomes, jobDuration);
  printReport(jobReport);

  // Phase 3: Concurrent SSE connections
  const sseCount = 20;
  console.log(`\n⏳ Phase 3: ${sseCount} concurrent SSE connections...`);
  const sseStart = performance.now();
  const sseResults = await Promise.allSettled(
    Array.from({ length: sseCount }, (_, i) =>
      sseConnect(config.baseUrl, token, `load-test-${i}`, 3000),
    ),
  );
  const sseDuration = performance.now() - sseStart;

  const sseOutcomes: RequestResult[] = sseResults.map((r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, status: 0, latencyMs: 0, type: 'job' as const, error: r.reason?.message },
  );
  const sseReport = buildReport('Burst: Concurrent SSE Connections', sseOutcomes, sseDuration);
  printReport(sseReport);

  // Phase 4: Health endpoint under load
  const healthCount = 50;
  console.log(`\n⏳ Phase 4: ${healthCount} concurrent health checks...`);
  const healthStart = performance.now();
  const healthResults = await Promise.allSettled(
    Array.from({ length: healthCount }, () => healthCheck(config.baseUrl)),
  );
  const healthDuration = performance.now() - healthStart;

  const healthOutcomes: RequestResult[] = healthResults.map((r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, status: 0, latencyMs: 0, type: 'login' as const, error: r.reason?.message },
  );
  const healthReport = buildReport('Burst: Concurrent Health Checks', healthOutcomes, healthDuration);
  printReport(healthReport);

  // Summary
  const allReports = [listReport, jobReport, sseReport, healthReport];
  const totalReqs = allReports.reduce((s, r) => s + r.totalRequests, 0);
  const totalFailed = allReports.reduce((s, r) => s + r.failed, 0);
  console.log(`\n📊 BURST SUMMARY: ${totalReqs} total requests, ${totalFailed} failures`);
}

// ---------------------------------------------------------------------------
// Sustained mode — continuous mixed load for a configurable duration
// ---------------------------------------------------------------------------

async function runSustained(config: LoadTestConfig): Promise<void> {
  console.log('\n🔄 SUSTAINED MODE — Load Test');
  console.log(`   Target:   ${config.baseUrl}`);
  console.log(`   Duration: ${config.durationSec}s\n`);

  const token = await authenticate(config);

  const results: RequestResult[] = [];
  const endTime = Date.now() + config.durationSec * 1000;
  let iteration = 0;

  // Mixed workload weights: 40% list jobs, 25% create job, 20% health, 15% SSE
  const actions = [
    { weight: 40, fn: () => listJobs(config.baseUrl, token) },
    { weight: 25, fn: () => createJob(config.baseUrl, token, config.site, config.brand) },
    { weight: 20, fn: () => healthCheck(config.baseUrl) },
    { weight: 15, fn: () => sseConnect(config.baseUrl, token, `sustained-${iteration}`, 2000) },
  ];
  const totalWeight = actions.reduce((s, a) => s + a.weight, 0);

  function pickAction(): () => Promise<RequestResult> {
     
    const roll = Math.random() * totalWeight;
    let cumulative = 0;
    for (const action of actions) {
      cumulative += action.weight;
      if (roll < cumulative) return action.fn;
    }
    return actions[0].fn;
  }

  const startTime = Date.now();
  const concurrency = 10; // 10 in-flight requests at a time

  console.log(`⏳ Running sustained load (${concurrency} concurrent, mixed workload)...`);

  // Progress ticker
  const progressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    process.stdout.write(`\r   ${elapsed}s elapsed | ${results.length} requests | ${ok} ok | ${fail} failed`);
  }, 2000);

  while (Date.now() < endTime) {
    // Fire a batch of concurrent requests
    const batch = Array.from({ length: concurrency }, () => {
      iteration++;
      return pickAction()();
    });
    const settled = await Promise.allSettled(batch);
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ ok: false, status: 0, latencyMs: 0, type: 'job', error: r.reason?.message });
      }
    }
    // Small pause between batches to avoid pure spin
    await sleep(100);
  }

  clearInterval(progressInterval);
  console.log(''); // newline after progress

  const totalDuration = Date.now() - startTime;
  const report = buildReport('Sustained: Mixed Workload', results, totalDuration);
  printReport(report);

  // Breakdown by type
  const loginResults = results.filter((r) => r.type === 'login');
  const jobResults = results.filter((r) => r.type === 'job');
  if (loginResults.length > 0) {
    printReport(buildReport('Sustained: Health Checks', loginResults, totalDuration));
  }
  if (jobResults.length > 0) {
    printReport(buildReport('Sustained: Job Operations', jobResults, totalDuration));
  }

  console.log(`\n📊 SUSTAINED SUMMARY: ${results.length} requests over ${(totalDuration / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Product Scraper — Load Testing Script               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Quick connectivity check
  const probe = await healthCheck(config.baseUrl);
  if (!probe.ok) {
    console.error(`❌ Cannot reach ${config.baseUrl}/api/health (status: ${probe.status})`);
    console.error('   Make sure the server is running before starting the load test.');
    process.exit(1);
  }
  console.log(`✅ Server reachable at ${config.baseUrl} (${probe.latencyMs}ms)`);

  if (config.sustained) {
    await runSustained(config);
  } else {
    await runBurst(config);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
