#!/usr/bin/env node
/**
 * README screenshots from a running install loaded with the demo data
 * (`npm run demo -w server`). Writes dashboard, analytics, alerts and
 * wizard-preview PNGs to docs/screenshots/ at 1440×900.
 *
 *   BASE_URL=http://localhost:8080 SHOT_USER=<admin> SHOT_PASS=<password> node scripts/screenshots.mjs
 *
 * The user must be an admin (the wizard is an admin page).
 * Chromium: CHROMIUM_PATH, or Playwright's installed headless shell
 * (`npx playwright-core install chromium-headless-shell`). The wizard preview
 * is stubbed with fictional JSON, so nothing is fetched from a retailer.
 */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const { SHOT_USER, SHOT_PASS, CHROMIUM_PATH } = process.env;
if (!SHOT_USER || !SHOT_PASS) {
  console.error('Set SHOT_USER and SHOT_PASS to an admin account on the demo install.');
  process.exit(1);
}

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');

const PREVIEW = {
  success: true,
  site: { name: 'northwind', display_name: 'Northwind Outfitters', existing: true },
  preview: {
    adapter: 'schema-org',
    suggested_pattern: '^/products/[a-z0-9-]+$',
    link_count: 21,
    links: ['https://northwind.example/products/red-maple-linen-tee'],
    samples: [
      { url: 'https://northwind.example/products/red-maple-linen-tee', rows: ['S', 'M', 'L'].map((size) => (
        { title: 'Red Maple Linen Tee', color: 'Oat', size, selling_price: '35.99', list_price: '48.00', inventory: 'In stock' })) },
      { url: 'https://northwind.example/products/red-maple-wrap-dress', rows: ['S', 'M'].map((size) => (
        { title: 'Red Maple Wrap Dress', color: 'Rust', size, selling_price: '92.00', list_price: '92.00', inventory: 'In stock' })) },
    ],
    fields: { filled: ['title', 'color', 'size', 'selling_price', 'list_price', 'inventory', 'image_url'], empty: ['upc'] },
    problem: null,
    message: null,
  },
};

async function shot(page, name) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800); // let charts finish animating
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`wrote docs/screenshots/${name}.png`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Hide the one-time "Press ⌘K to search" hint.
    await page.addInitScript(() => localStorage.setItem('cmd-k-hint-dismissed', 'true'));

    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel('Username').fill(SHOT_USER);
    await page.getByLabel('Password').fill(SHOT_PASS);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(`${BASE_URL}/`);
    await shot(page, 'dashboard');

    await page.goto(`${BASE_URL}/analytics`);
    await page.getByText(/price trend/i).first().waitFor();
    await shot(page, 'analytics');

    await page.goto(`${BASE_URL}/alerts`);
    await page.getByTestId('alert-row').first().waitFor();
    await shot(page, 'alerts');

    await page.route('**/api/config/sites/preview', (route) => route.fulfill({ json: PREVIEW }));
    await page.goto(`${BASE_URL}/sites/new`);
    await page.getByLabel(/brand page url/i).fill('https://northwind.example/collections/red-maple');
    await page.getByLabel(/brand name/i).fill('Red Maple');
    await page.getByRole('button', { name: /^preview$/i }).click();
    const found = page.getByText(/21 product links/i);
    await found.waitFor();
    await found.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'wizard-preview');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('screenshots failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
