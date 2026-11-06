import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  getSites,
  addSite,
  updateSite,
  getBrands,
  addBrand,
  updateBrand,
} from '../services/config-manager';
import type { SiteConfig, BrandConfig, AdapterField } from '../services/config-manager';
import { adapterIds, getAdapter, DEFAULT_ADAPTER_ID } from '../adapters';
import { authMiddleware, requireRole, type AuthenticatedRequest } from '../middleware/auth';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import rateLimit from 'express-rate-limit';
import { previewSite } from '../services/site-preview';
import { fetchViaUnlocker } from '../scrapers/page-fetcher';
import { FetchError } from '../scrapers/fetch-failure';
import { deriveDisplayName, deriveSiteName } from '../services/site-onboarding';
import { createJob } from '../services/job-lifecycle';
import { httpError } from '../utils/async-handler';

const logger = createLogger('config-routes');
const router = Router();

// --- Validation Schemas ---

// `name`/`base_url` are required-and-truthy in the handler; the extra
// base_url URL-shape check stays in the handler. Body stays passthrough.
const createSiteSchema = z
  .object({
    name: z.string().min(1),
    base_url: z.string().min(1),
    brand_urls: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const createSiteSchemas = { body: createSiteSchema };

const createBrandSchema = z
  .object({
    name: z.string().min(1),
    filter_criteria: z.record(z.string(), z.unknown()),
    allowed_retailers: z.array(z.string()).optional(),
  })
  .passthrough();
const createBrandSchemas = { body: createBrandSchema };

// Updates: every field optional, same types as create. Adapter fields and
// brand_urls/allowed_retailers contents are still checked in the handler.
const updateSiteSchemas = {
  body: z
    .object({
      name: z.string().min(1).optional(),
      base_url: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      brand_urls: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
};
const updateBrandSchemas = {
  body: z
    .object({
      name: z.string().min(1).optional(),
      filter_criteria: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      allowed_retailers: z.array(z.string()).optional(),
    })
    .passthrough(),
};

// --- Field validators (shared by create + update routes) ---

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate + normalize a brand_urls map: keys lowercased/trimmed, values must be http(s) URLs. */
function normalizeBrandUrls(input: unknown): { value: Record<string, string> } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'brand_urls must be a JSON object' };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string' || !isHttpUrl(v)) {
      return { error: `brand_urls["${k}"] must be a valid http(s) URL` };
    }
    out[k.toLowerCase().trim()] = v.trim();
  }
  return { value: out };
}

/**
 * Validate the adapter fields present in a site body. Returns only the fields
 * given; an empty string clears the optional ones.
 */
function normalizeAdapterFields(body: Record<string, unknown>): { value: Partial<Pick<SiteConfig, AdapterField>> } | { error: string } {
  const out: Partial<Pick<SiteConfig, AdapterField>> = {};
  if (body.adapter !== undefined) {
    if (typeof body.adapter !== 'string' || !adapterIds().includes(body.adapter)) {
      return { error: `adapter must be one of: ${adapterIds().join(', ')}` };
    }
    out.adapter = body.adapter;
  }
  if (body.listing_url_template !== undefined) {
    const t = String(body.listing_url_template).trim();
    if (t && !isHttpUrl(t.replaceAll('{brand}', 'b').replaceAll('{page}', '1'))) {
      return { error: 'listing_url_template must be a valid http(s) URL' };
    }
    out.listing_url_template = t;
  }
  if (body.product_link_pattern !== undefined) {
    const p = String(body.product_link_pattern).trim();
    try {
      new RegExp(p);
    } catch {
      return { error: 'product_link_pattern must be a valid regular expression' };
    }
    out.product_link_pattern = p;
  }
  return { value: out };
}

/** Validate + normalize allowed_retailers: each entry must be an existing site name (lowercased). */
async function normalizeAllowedRetailers(input: unknown): Promise<{ value: string[] } | { error: string }> {
  if (!Array.isArray(input)) {
    return { error: 'allowed_retailers must be a JSON array' };
  }
  const known = new Set((await getSites()).map((s) => s.name.toLowerCase()));
  const out: string[] = [];
  for (const r of input) {
    const name = String(r).toLowerCase().trim();
    if (!known.has(name)) return { error: `Unknown retailer "${String(r)}" in allowed_retailers` };
    out.push(name);
  }
  return { value: out };
}

// All config routes require authentication
router.use(authMiddleware);

// ─── Read-only routes (accessible to all authenticated users) ──────────────────

/**
 * @swagger
 * /api/config/adapters:
 *   get:
 *     summary: List the registered retailer adapter ids
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Adapter ids a site's `adapter` field may take, the default, and which need a product link pattern
 */
router.get('/adapters', (_req, res) => {
  res.json({
    success: true,
    adapters: adapterIds(),
    // A site with no `adapter` field uses this one.
    default_adapter: DEFAULT_ADAPTER_ID,
    // The wizard and Config page shows the link-pattern field only for these.
    needs_link_pattern: adapterIds().filter((id) => getAdapter(id).needsLinkPattern),
  });
});

/**
 * @swagger
 * /api/config/sites:
 *   get:
 *     summary: List all site configurations
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of site configurations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 sites:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SiteConfig'
 */
router.get('/sites', asyncHandler(async (_req, res) => {
  const sites = await getSites();
  res.json({ success: true, sites });
}, { operation: 'getSites' }));

// ─── Brand Routes ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/config/brands:
 *   get:
 *     summary: List all brand configurations
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of brand configurations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 brands:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BrandConfig'
 */
router.get('/brands', asyncHandler(async (_req, res) => {
  const brands = await getBrands();
  res.json({ success: true, brands });
}, { operation: 'getBrands' }));

// ─── Admin-only routes (write operations) ────────────────────────
// All routes below require admin role
router.use(requireRole('admin'));

// ─── Add a retailer wizard ───────────────────────────────────────

/** An absolute http(s) URL — the only kind the scraping provider should be pointed at. */
const pageUrl = z.string().url().refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), 'URL must be http or https');

const previewSchemas = {
  body: z.object({
    url: pageUrl,
    brand: z.string().trim().min(1),
    adapter: z.string().refine((id) => adapterIds().includes(id), 'Unknown adapter').optional(),
    product_link_pattern: z.string().min(1).optional(),
  }),
};

// Each preview spends up to five provider requests, so it gets its own budget.
const previewLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorResponse('Too many previews, please wait a minute', 'rate_limit_error'),
});

/** A page through the active scraping provider; throws the provider's error. */
async function fetchThroughProvider(url: string, opts?: { render?: boolean }): Promise<string> {
  const result = await fetchViaUnlocker(url, undefined, undefined, opts?.render ?? false);
  if (!result.success) throw new FetchError(result.error ?? 'fetch failed', result.failure);
  return result.content;
}

router.post('/sites/preview', previewLimiter, validate(previewSchemas), asyncHandler(async (req: ValidatedRequest<typeof previewSchemas>, res) => {
  const preview = await previewSite(req.body, fetchThroughProvider);
  const sites = await getSites();
  const { origin } = new URL(req.body.url);
  const existing = sites.find((s) => URL.canParse(s.base_url) && new URL(s.base_url).origin === origin);
  // What step 3 will save: the existing site for this origin, or a new one.
  const site = existing
    ? { name: existing.name, display_name: existing.display_name ?? existing.name, existing: true }
    : { name: deriveSiteName(req.body.url, sites.map((s) => s.name)), display_name: deriveDisplayName(req.body.url), existing: false };
  res.json({ success: true, preview, site });
}, { operation: 'previewSite' }));

const onboardSchemas = {
  body: z.object({
    url: pageUrl,
    brand: z.string().trim().min(1),
    adapter: z.string().refine((id) => adapterIds().includes(id), 'Unknown adapter'),
    product_link_pattern: z.string().min(1).optional(),
    name: z.string().trim().regex(/^[a-z0-9]+$/, 'Site name: lowercase letters and digits only').optional(),
    display_name: z.string().trim().min(1).optional(),
  }),
};

/**
 * Finish the wizard: save (or reuse) the site with this brand's URL, make sure
 * the brand exists and may run there, and start the first job.
 */
router.post('/sites/onboard', validate(onboardSchemas), asyncHandler(async (req: ValidatedRequest<typeof onboardSchemas, AuthenticatedRequest>, res) => {
  const { url, brand, adapter, product_link_pattern, name, display_name } = req.body;
  const { origin } = new URL(url);
  const brandKey = brand.toLowerCase();

  const sites = await getSites();
  const existing = sites.find((s) => URL.canParse(s.base_url) && new URL(s.base_url).origin === origin);
  let site: SiteConfig;
  if (existing) {
    site = await updateSite(existing.site_id, {
      ...(!existing.enabled && { enabled: true }),
      brand_urls: { ...existing.brand_urls, [brandKey]: url },
    });
  } else {
    site = await addSite({
      name: name ?? deriveSiteName(url, sites.map((s) => s.name)),
      display_name: display_name ?? deriveDisplayName(url),
      base_url: origin,
      adapter,
      ...(product_link_pattern && { product_link_pattern }),
      brand_urls: { [brandKey]: url },
    });
  }
  const siteName = site.name ?? existing!.name;

  const brands = await getBrands();
  const known = brands.find((b) => b.name.toLowerCase() === brandKey);
  let brandConfig: BrandConfig;
  if (!known) {
    brandConfig = await addBrand({ name: brand, filter_criteria: { brand } });
  } else {
    const restricted = known.allowed_retailers?.length && !known.allowed_retailers.includes(siteName.toLowerCase());
    const updates = {
      ...(!known.enabled && { enabled: true }),
      ...(restricted && { allowed_retailers: [...known.allowed_retailers!, siteName.toLowerCase()] }),
    };
    brandConfig = Object.keys(updates).length > 0 ? await updateBrand(known.brand_id, updates) : known;
  }

  const job = await createJob({ site: siteName, brand: brandConfig.name, userId: String(req.user!.id) })
    .catch((err: unknown) => { throw httpError(err, 400); });

  logger.info('Retailer onboarded', { operation: 'onboardSite', site: siteName, brand: brandConfig.name, jobId: job.job_id, reused: Boolean(existing) });
  res.status(201).json({ success: true, site, brand: brandConfig, job_id: job.job_id, reused_site: Boolean(existing) });
}, { operation: 'onboardSite' }));

// ─── Site Write Routes ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/config/sites:
 *   post:
 *     summary: Add a new site configuration
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, base_url]
 *             properties:
 *               name:
 *                 type: string
 *                 example: example-shop
 *               base_url:
 *                 type: string
 *                 example: https://shop.example.com
 *               adapter:
 *                 type: string
 *                 example: schema-org
 *               listing_url_template:
 *                 type: string
 *                 example: https://shop.example.com/brand/{brand}?page={page}
 *               product_link_pattern:
 *                 type: string
 *                 example: /p/[^/?#]+/\d+
 *     responses:
 *       201:
 *         description: Site created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 site:
 *                   $ref: '#/components/schemas/SiteConfig'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate site name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/sites', validate(createSiteSchemas), asyncHandler(async (req: ValidatedRequest<typeof createSiteSchemas>, res) => {
  const { name, base_url, brand_urls } = req.body;

  // Validate base_url is a valid HTTP(S) URL to prevent SSRF
  if (!isHttpUrl(base_url)) {
    res.status(400).json(errorResponse('base_url must be a valid http(s) URL', 'validation_error'));
    return;
  }

  let normalizedBrandUrls: Record<string, string> | undefined;
  if (brand_urls !== undefined) {
    const result = normalizeBrandUrls(brand_urls);
    if ('error' in result) {
      res.status(400).json(errorResponse(result.error, 'validation_error'));
      return;
    }
    normalizedBrandUrls = result.value;
  }

  const adapterFields = normalizeAdapterFields(req.body);
  if ('error' in adapterFields) {
    res.status(400).json(errorResponse(adapterFields.error, 'validation_error'));
    return;
  }

  const site = await addSite({
    name, base_url,
    ...(normalizedBrandUrls && { brand_urls: normalizedBrandUrls }),
    ...adapterFields.value,
  });
  logger.info('Site created via API', { operation: 'createSite', siteId: site.site_id });
  res.status(201).json({ success: true, site });
}, { operation: 'createSite' }));

/**
 * @swagger
 * /api/config/sites/{id}:
 *   put:
 *     summary: Update an existing site configuration
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Site ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               base_url:
 *                 type: string
 *               adapter:
 *                 type: string
 *               listing_url_template:
 *                 type: string
 *               product_link_pattern:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Site updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 site:
 *                   $ref: '#/components/schemas/SiteConfig'
 *       404:
 *         description: Site not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate site name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/sites/:id', validate(updateSiteSchemas), asyncHandler(async (req: ValidatedRequest<typeof updateSiteSchemas, Request<{ id: string }>>, res) => {
  const { name, base_url, enabled, brand_urls } = req.body;
  const adapterFields = normalizeAdapterFields(req.body);
  if ('error' in adapterFields) {
    res.status(400).json(errorResponse(adapterFields.error, 'validation_error'));
    return;
  }
  const updates: Partial<Pick<SiteConfig, 'name' | 'base_url' | 'enabled' | 'brand_urls' | AdapterField>> = { ...adapterFields.value };
  if (name !== undefined) updates.name = name;
  if (base_url !== undefined) updates.base_url = base_url;
  if (enabled !== undefined) updates.enabled = enabled;
  if (brand_urls !== undefined) {
    const result = normalizeBrandUrls(brand_urls);
    if ('error' in result) {
      res.status(400).json(errorResponse(result.error, 'validation_error'));
      return;
    }
    updates.brand_urls = result.value;
  }

  const site = await updateSite(req.params.id, updates);
  logger.info('Site updated via API', { operation: 'updateSite', siteId: req.params.id });
  res.json({ success: true, site });
}, { operation: 'updateSite' }));

// ─── Brand Write Routes ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/config/brands:
 *   post:
 *     summary: Add a new brand configuration
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, filter_criteria]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Example Brand
 *               filter_criteria:
 *                 type: object
 *                 example: { "brand": "Example Brand" }
 *     responses:
 *       201:
 *         description: Brand created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 brand:
 *                   $ref: '#/components/schemas/BrandConfig'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate brand name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/brands', validate(createBrandSchemas), asyncHandler(async (req: ValidatedRequest<typeof createBrandSchemas>, res) => {
  const { name, filter_criteria, allowed_retailers } = req.body;

  let normalizedAllowed: string[] | undefined;
  if (allowed_retailers !== undefined) {
    const result = await normalizeAllowedRetailers(allowed_retailers);
    if ('error' in result) {
      res.status(400).json(errorResponse(result.error, 'validation_error'));
      return;
    }
    normalizedAllowed = result.value;
  }

  const brand = await addBrand({
    name, filter_criteria,
    ...(normalizedAllowed && { allowed_retailers: normalizedAllowed }),
  });
  logger.info('Brand created via API', { operation: 'createBrand', brandId: brand.brand_id });
  res.status(201).json({ success: true, brand });
}, { operation: 'createBrand' }));

/**
 * @swagger
 * /api/config/brands/{id}:
 *   put:
 *     summary: Update an existing brand configuration
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brand ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               filter_criteria:
 *                 type: object
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Brand updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 brand:
 *                   $ref: '#/components/schemas/BrandConfig'
 *       404:
 *         description: Brand not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate brand name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/brands/:id', validate(updateBrandSchemas), asyncHandler(async (req: ValidatedRequest<typeof updateBrandSchemas, Request<{ id: string }>>, res) => {
  const { name, filter_criteria, enabled, allowed_retailers } = req.body;
  const updates: Partial<Pick<BrandConfig, 'name' | 'filter_criteria' | 'enabled' | 'allowed_retailers'>> = {};
  if (name !== undefined) updates.name = name;
  if (filter_criteria !== undefined) updates.filter_criteria = filter_criteria;
  if (enabled !== undefined) updates.enabled = enabled;
  if (allowed_retailers !== undefined) {
    const result = await normalizeAllowedRetailers(allowed_retailers);
    if ('error' in result) {
      res.status(400).json(errorResponse(result.error, 'validation_error'));
      return;
    }
    updates.allowed_retailers = result.value;
  }

  const brand = await updateBrand(req.params.id, updates);
  logger.info('Brand updated via API', { operation: 'updateBrand', brandId: req.params.id });
  res.json({ success: true, brand });
}, { operation: 'updateBrand' }));

export default router;
