/**
 * Express application setup — middleware chain, route mounting, error handling.
 */

import express from 'express';
import * as Sentry from '@sentry/node';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from './services/redis-client';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { createQueueDashboard } from './services/bull-board';
import { buildBullBoardCspDirectives } from './services/bull-board-csp';
import authRoutes from './routes/auth';
import { authMiddleware, requireRole } from './middleware/auth';
import jobRoutes from './routes/jobs';
import configRoutes from './routes/config';
import downloadRoutes from './routes/downloads';
import adminRoutes from './routes/admin';
import scrapeRunRoutes from './routes/scrape-runs';
import siteMonitorRoutes from './routes/site-monitor';
import alertRoutes from './routes/alerts';
import { analyticsRouter } from './routes/analytics';
import dataApiRouter from './routes/data-api';
import metricsRouter from './routes/metrics';
import appearanceRouter from './routes/appearance';
import { createLogger } from './utils/logger';
import { errorHandler } from './utils/async-handler';
import { config } from './config';
import { requestIdMiddleware } from './middleware/request-id';
import { httpMetricsMiddleware } from './middleware/http-metrics';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';

/** Create a Redis-backed store for distributed rate limiting. Falls back to MemoryStore. */
function createRedisStore(prefix: string) {
  try {
    const redis = getRedisClient().getQueueConnection();
    return new RedisStore({
      sendCommand: ((...args: string[]) =>
        redis.call(args[0], ...args.slice(1))) as (...args: string[]) => Promise<boolean | number | string | (boolean | number | string)[]>,
      prefix: `rl:${prefix}:`,
    });
  } catch {
    return undefined;
  }
}
import { getHealthMonitor } from './services/health-monitor';
import type { Request, Response, NextFunction } from 'express';
import { cookieOptions } from './routes/session-cookie';
import { ACCESS_TOKEN_TTL_SECONDS } from './services/session-lifetimes';

const logger = createLogger('app');

// --- Swagger/OpenAPI Configuration ---

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Enterprise Web Scraper API',
    version: '1.0.0',
    description:
      'Web scraping service for product variant extraction from ecommerce sites.',
  },
  servers: [{ url: '/api', description: 'API base path' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      AuthRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'admin' },
          password: { type: 'string', example: 'your-password' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
          user: { $ref: '#/components/schemas/UserInfo' },
          expires_at: { type: 'string', format: 'date-time' },
        },
      },
      UserInfo: {
        type: 'object',
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'user'] },
          created_at: { type: 'string', format: 'date-time' },
          last_login: { type: 'string', format: 'date-time', nullable: true },
          enabled: { type: 'boolean' },
        },
      },
      Job: {
        type: 'object',
        properties: {
          job_id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          site: { type: 'string', example: 'example-shop' },
          brand: { type: 'string', example: 'Example Brand' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          completed_at: { type: 'string', format: 'date-time', nullable: true },
          products_discovered: { type: 'integer' },
          products_processed: { type: 'integer' },
          variants_extracted: { type: 'integer' },
          file_path: { type: 'string', nullable: true },
          error_message: { type: 'string', nullable: true },
        },
      },
      CreateJobRequest: {
        type: 'object',
        required: ['site', 'brand'],
        properties: {
          site: { type: 'string', example: 'example-shop' },
          brand: { type: 'string', example: 'Example Brand' },
        },
      },
      SiteConfig: {
        type: 'object',
        properties: {
          site_id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'example-shop' },
          base_url: { type: 'string', example: 'https://shop.example.com' },
          adapter: { type: 'string', example: 'schema-org', description: 'Retailer adapter id (default schema-org).' },
          listing_url_template: { type: 'string', example: 'https://shop.example.com/brand/{brand}?page={page}' },
          product_link_pattern: { type: 'string', example: '/p/[^/?#]+/\\d+' },
          enabled: { type: 'boolean' },
          brand_urls: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Per-brand discovery URLs, keyed by brand name lowercase. Accepted on POST/PUT /config/sites.',
            example: { 'example brand': 'https://shop.example.com/brands/example-brand' },
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      BrandConfig: {
        type: 'object',
        properties: {
          brand_id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Example Brand' },
          filter_criteria: { type: 'object', example: { brand: 'Example Brand' } },
          enabled: { type: 'boolean' },
          allowed_retailers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Retailers (lowercase site names) this brand may run on. Absent/empty = all retailers. Accepted on POST/PUT /config/brands; an out-of-scope (site, brand) on POST /jobs or /jobs/schedules returns 400.',
            example: ['example-shop', 'other-shop'],
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      ProgressInfo: {
        type: 'object',
        properties: {
          job_id: { type: 'string', format: 'uuid' },
          state: {
            type: 'string',
            enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
          },
          products_discovered: { type: 'integer' },
          products_processed: { type: 'integer' },
          variants_extracted: { type: 'integer' },
          current_product_url: { type: 'string', nullable: true },
          estimated_completion: { type: 'string', format: 'date-time', nullable: true },
          error_message: { type: 'string', nullable: true },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error_type: { type: 'string', example: 'validation_error' },
          message: { type: 'string', example: 'Something went wrong' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

const swaggerOptions: swaggerJsdoc.Options = {
  definition: swaggerDefinition,
  apis: ['./src/routes/*.ts', './src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// --- Express App ---

export function createApp(): express.Application {
  const app = express();

  // Number of reverse proxies in front of the API whose X-Forwarded-For is
  // trusted for req.ip (rate-limit keys, audit IPs). TRUST_PROXY, default off:
  // a client that reaches the API directly must not choose its own IP.
  app.set('trust proxy', config.server.trustProxy);

  // --- Global Middleware ---

  // Request ID — must be first so every downstream middleware and route has access
  app.use(requestIdMiddleware());

  // Prometheus per-request metrics. Mounted right after request-id so the
  // timer captures the full handler chain. Sub-millisecond per request.
  app.use(httpMetricsMiddleware);

  // Security headers with strict CSP for all non-Swagger routes
  const isProduction = config.isProduction;
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    strictTransportSecurity: isProduction ? {
      maxAge: 31536000,
      includeSubDomains: true,
    } : false,
    crossOriginOpenerPolicy: true,
  }));

  // CORS — restrict to configured origins (defaults to localhost in dev only).
  // In production, an unset CORS_ORIGINS means an empty allowlist (no external
  // origin is echoed) rather than silently falling back to a localhost origin.
  const corsOriginsEnv = config.server.corsOrigins;
  let allowedOrigins: string[];
  if (corsOriginsEnv) {
    allowedOrigins = corsOriginsEnv.split(',').map(o => o.trim()).filter(o => o.length > 0);
  } else if (isProduction) {
    logger.error('CORS_ORIGINS not set in production — using an empty allowlist (no external origins permitted)', {
      operation: 'configureCors',
    });
    allowedOrigins = [];
  } else {
    allowedOrigins = ['http://localhost:3000'];
  }
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }));

  // Body size limit to prevent DoS via large payloads
  app.use(express.json({ limit: '1mb' }));

  // Parse cookies (needed for refresh token in httpOnly cookie)
  // CSRF note: This API uses JWT Bearer tokens for authentication (not session cookies).
  // The only cookie is the refresh token, which uses sameSite='strict' + httpOnly + secure
  // (see REFRESH_COOKIE_OPTIONS in routes/auth.ts), providing CSRF protection without
  // dedicated CSRF middleware. CORS origin restrictions add a second layer of defense.
  app.use(cookieParser());

  // Response compression
  app.use(compression());

  // Rate limiting — configurable via env vars, defaults safe for production.
  // Uses Redis store for distributed rate limiting across multiple instances.
  // RATE_LIMIT_API_MAX: general API limit (default 500/15min)
  // RATE_LIMIT_AUTH_MAX: auth endpoint limit (default 20/15min)
  // RATE_LIMIT_ADMIN_MAX: admin endpoint limit (default 100/15min)
  const apiRateMax = config.rateLimits.apiMax;
  const authRateMax = config.rateLimits.authMax;
  const adminRateMax = config.rateLimits.adminMax;

  // SSE endpoints are exempted below since they're long-lived connections.
  // Only failed responses (status >= 400) consume budget — same rationale as
  // the auth/refresh/admin limiters: brute-force traffic mostly fails, so
  // counting only failures protects against attackers without capping
  // legitimate users who fire many successful requests (e.g. dashboards
  // mounting many widgets in parallel).
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: apiRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    store: createRedisStore('api'),
    skip: (req) => {
      // Exempt SSE endpoints from rate limiting (long-lived connections)
      // Exempt admin endpoints — they have their own stricter limiter
      // Exempt metrics endpoints — they carry their own per-IP limiter
      // (and would otherwise share the page's general API budget).
      return (
        req.path.includes('/stream') ||
        req.path.startsWith('/api/admin') ||
        req.path.startsWith('/api/metrics')
      );
    },
    message: {
      success: false,
      error_type: 'rate_limit_error',
      message: 'Too many requests, please try again later',
      timestamp: new Date().toISOString(),
    },
  });
  app.use('/api', limiter);

  // Stricter rate limit on auth endpoints. Only failed logins (status >= 400)
  // count toward the budget — a legitimate admin who reauthenticates
  // successfully N times during a debugging session shouldn't get locked out.
  // Brute-force defense still works because every failed attempt is counted.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: authRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    store: createRedisStore('auth'),
    message: {
      success: false,
      error_type: 'rate_limit_error',
      message: 'Too many login attempts, please try again later',
      timestamp: new Date().toISOString(),
    },
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/setup', authLimiter);

  // Rate limit refresh token endpoint — prevent token cycling attacks. Same
  // semantics as the login limiter: only failed refresh attempts count, so
  // an active session refreshing on schedule never trips the limit.
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.rateLimits.refreshMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    store: createRedisStore('refresh'),
    message: {
      success: false,
      error_type: 'rate_limit_error',
      message: 'Too many token refresh attempts, please try again later',
      timestamp: new Date().toISOString(),
    },
  });
  app.use('/api/auth/refresh', refreshLimiter);

  // Stricter rate limit on admin endpoints. Only failed requests count —
  // /admin/analytics fires ~12 admin requests on mount + 3 every 30s polling,
  // and a busy admin can exhaust a 300-request budget legitimately. The
  // limiter still defends against unauthorized hammering because every 401
  // (no token) and 403 (wrong role) is counted.
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: adminRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    store: createRedisStore('admin'),
    message: {
      success: false,
      error_type: 'rate_limit_error',
      message: 'Too many requests to admin endpoints, please try again later',
      timestamp: new Date().toISOString(),
    },
  });
  app.use('/api/admin', adminLimiter);

  // --- Swagger UI (no auth required, development only) ---

  if (!isProduction) {
    // OpenAPI JSON spec — development only
    app.get('/api-docs/openapi.json', (_req, res) => {
      res.json(swaggerSpec);
    });
    // Permissive CSP for Swagger UI — inline scripts/styles required by swagger-ui-express
    const swaggerHelmet = helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
        },
      },
    });
    app.use('/api-docs', swaggerHelmet, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  }

  // --- Bull Board Queue Dashboard (admin-only, all environments) ---

  // Tightened CSP for Bull Board: no 'unsafe-inline' for scripts
  // (the dashboard ships none — only a type="application/json" config blob),
  // and style-src uses SHA-256 hashes of the template's inline styles instead
  // of 'unsafe-inline'. Falls back to 'unsafe-inline' for styles only if the
  // @bull-board/ui template can't be read. See bull-board-csp.ts.
  const bullBoardHelmet = helmet({
    contentSecurityPolicy: {
      directives: buildBullBoardCspDirectives(isProduction),
    },
    strictTransportSecurity: isProduction,
  });

  // Cookie name and configuration for Bull Board auth
  const BULL_BOARD_COOKIE = 'bull_board_token';

  // POST endpoint: bridge sends refresh token → server validates & sets cookie
  // This replaces the insecure pattern of redirecting with ?token= in the URL, which leaks
  // the token into browser history, proxy logs and Referer headers
  app.post('/admin/queues/auth', (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : undefined;
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    try {
      // Validate token using the same JWT secret as authMiddleware
      const decoded = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload & { role?: string };
      if (decoded.role !== 'admin') {
        res.status(401).json({ error: 'Insufficient permissions' });
        return;
      }

      res.cookie(BULL_BOARD_COOKIE, token, cookieOptions('/admin/queues', { maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS }));
      res.status(204).send();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  // Middleware: cookie → Authorization header promotion + bridge page
  app.use('/admin/queues', (req: Request, res: Response, next: NextFunction) => {
    // If no Bearer header but cookie exists, promote cookie to Authorization header
    // so authMiddleware picks it up transparently
    const cookieToken = req.cookies?.[BULL_BOARD_COOKIE];
    if (!req.headers.authorization && cookieToken) {
      req.headers.authorization = `Bearer ${String(cookieToken)}`;
    }
    // If still no auth, serve a bridge page that uses the refresh cookie
    // to obtain an access token, then POSTs it to /admin/queues/auth
    if (!req.headers.authorization) {
      res.send(`<!DOCTYPE html><html><head><title>Queue Dashboard</title>
        <style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
        .card{text-align:center;padding:2rem}.spinner{width:24px;height:24px;border:3px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 1rem}
        @keyframes spin{to{transform:rotate(360deg)}}.error{color:#dc2626;font-size:14px;margin-top:8px;display:none}</style></head>
        <body><div class="card"><div class="spinner" id="spinner"></div><p id="msg">Authenticating...</p><p class="error" id="err"></p></div>
        <script>
          fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
            .then(function(r) {
              if (!r.ok) throw new Error('Refresh failed (' + r.status + ')');
              return r.json();
            })
            .then(function(data) {
              if (!data.token) throw new Error('No token in response');
              return fetch('/admin/queues/auth', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: data.token })
              });
            })
            .then(function(r) {
              if (r.ok) {
                window.location.replace('/admin/queues');
              } else {
                throw new Error('Token validation failed (' + r.status + ')');
              }
            })
            .catch(function(e) {
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('msg').textContent = 'Authentication failed';
              var errEl = document.getElementById('err');
              errEl.style.display = 'block';
              errEl.textContent = e.message + ' — redirecting to login...';
              setTimeout(function() { window.location.replace('/login'); }, 2000);
            });
        </script>
      </body></html>`);
      return;
    }
    next();
  });

  const serverAdapter = createQueueDashboard();
  app.use(
    '/admin/queues',
    bullBoardHelmet,
    authMiddleware,
    requireRole('admin'),
    serverAdapter.getRouter(),
  );

  // --- Health Check ---

  let healthCache: { data: unknown; httpStatus: number; timestamp: number } | null = null;
  const HEALTH_CACHE_TTL = 10_000; // 10 seconds

  app.get('/api/health', async (_req, res) => {
    try {
      if (healthCache && Date.now() - healthCache.timestamp < HEALTH_CACHE_TTL) {
        res.status(healthCache.httpStatus).json(healthCache.data);
        return;
      }

      const monitor = getHealthMonitor();
      const report = await monitor.check();
      const httpStatus = report.status === 'unhealthy' ? 503 : 200;
      healthCache = { data: report, httpStatus, timestamp: Date.now() };
      res.status(httpStatus).json(report);
    } catch (err) {
      logger.error('Health check failed', {
        operation: 'healthEndpoint',
        error: (err as Error).message,
      });
      res.status(503).json({
        status: 'unhealthy',
        uptime: 0,
        checks: {
          postgresql: { ok: false, poolSize: 0, activeConnections: 0 },
          redis: { ok: false, memoryUsageMb: 0, connectedClients: 0 },
          queue: { ok: false, waiting: 0, active: 0, stalled: 0 },
          workers: { ok: false, activeWorkers: 0, expectedWorkers: config.worker.expectedWorkers },
        },
      });
    }
  });

  // --- API Routes ---

  // Public active messages — auth required but not admin-only
  app.get('/api/messages/active', async (req, res) => {
    try {
      const { authMiddleware: authMw } = require('./middleware/auth');
      await new Promise<void>((resolve, reject) => {
        authMw(req, res, (err?: unknown) => err ? reject(err) : resolve());
      });

      const { DatabaseService: DbSvc } = require('./services/database');
      const db = await DbSvc.getInstance();
      const now = Math.floor(Date.now() / 1000);
      const messages = await db.all(
        `SELECT id, title, message, type, created_at FROM global_messages
         WHERE active = 1 AND (expires_at IS NULL OR expires_at > $1)
         ORDER BY created_at DESC`,
        now,
      );
      res.json({ success: true, messages });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      if (status === 401 || status === 403) {
        res.status(status).json({ success: false, error_type: 'authentication_error', message: 'Authentication required', timestamp: new Date().toISOString() });
      } else {
        res.json({ success: true, messages: [] });
      }
    }
  });

  // RUM ingestion — public (no auth) and per-IP rate-limited inside the
  // router itself. Mounted before /api/auth so it's never accidentally
  // shadowed by an auth-required path.
  app.use('/api/metrics', metricsRouter);

  app.use('/api/auth', authRoutes);
  app.use('/api/settings/appearance', appearanceRouter);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/admin', adminRoutes);
  // Download routes are nested under /api/jobs (e.g. /api/jobs/:id/download)
  app.use('/api/jobs', downloadRoutes);
  app.use('/api/scrape-runs', scrapeRunRoutes);
  app.use('/api/site-monitor', siteMonitorRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api', analyticsRouter);
  app.use('/api/data', authMiddleware, dataApiRouter);

  // --- Global Error Handler ---

  // Sentry's error handler must run before our JSON error responder so
  // it captures the exception with full request context. No-op when
  // SENTRY_DSN is unset.
  Sentry.setupExpressErrorHandler(app);

  // Terminal error middleware (utils/async-handler): logs the real error
  // server-side and returns a generic body for 5xx so internal error strings
  // never leak to clients. Registered
  // AFTER all routes so any handler wrapped in `asyncHandler` funnels here.
  app.use(errorHandler);

  return app;
}
