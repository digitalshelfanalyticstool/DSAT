/**
 * Excel Generator — creates Excel workbooks from product variant data using ExcelJS.
 *
 * Generates one row per product (retailer + style + color) with the standard
 * 15-column schema; size-level variants are collapsed into comma-separated
 * Size/UPC lists by collapseVariants().
 * Files are saved to storage/excel/{year}/{month}/{day}/ with a descriptive filename.
 */

import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import type { ProductVariant } from '../scrapers/site-adapter';
import { getSites } from './config-manager';

const logger = createLogger('excel-generator');

/**
 * The required columns in order.
 *
 * `style_id` (the retailer's product id) is labeled "Mktg ID", the name the
 * cross-reference column carries in retailer reports.
 */
const COLUMNS: { header: string; key: keyof ProductVariant; width: number }[] = [
  { header: 'Retailer', key: 'retailer', width: 15 },
  { header: 'Mktg ID', key: 'style_id', width: 15 },
  { header: 'UPC', key: 'upc', width: 40 },
  { header: 'Type', key: 'product_type', width: 14 },
  { header: 'Title', key: 'title', width: 40 },
  { header: 'Color', key: 'color', width: 15 },
  { header: 'Size', key: 'size', width: 24 },
  { header: 'Description', key: 'description', width: 50 },
  { header: 'List_Price', key: 'list_price', width: 12 },
  { header: 'Selling_Price', key: 'selling_price', width: 14 },
  { header: 'URL', key: 'url', width: 60 },
  { header: 'Source', key: 'source', width: 15 },
  { header: 'Inventory', key: 'inventory', width: 12 },
];

/**
 * Builds the date-based output directory path and filename.
 *
 * Pattern: storage/excel/{year}/{month}/{day}/{jobId}_{site}_{brand}_{timestamp}.xlsx
 */
export function buildOutputPath(
  baseDir: string,
  jobId: string,
  site: string,
  brand: string,
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timestamp = [
    year, month, day,
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  const safeSite = site.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const safeBrand = brand.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${jobId}_${safeSite}_${safeBrand}_${timestamp}.xlsx`;

  return path.join(baseDir, year, month, day, filename);
}

/**
 * Collapses size-level variant rows into one Excel row per product
 * (retailer + style + color). The database keeps the size-level rows;
 * this is an export-time presentation change only.
 *
 * - `size` and `upc` become comma-separated lists, index-aligned so the
 *   Nth UPC belongs to the Nth size (a missing UPC keeps its empty slot
 *   to preserve alignment)
 * - `inventory` sums numeric values (stock quantities); when no value
 *   is numeric it keeps the first non-empty status ('In Stock' etc.)
 * - every other field takes the first row's value
 * - duplicate sizes within a group are dropped (first occurrence wins)
 */
export function collapseVariants(variants: ProductVariant[]): ProductVariant[] {
  const groups = new Map<string, ProductVariant[]>();
  for (const v of variants) {
    // style_id can be empty for some sources; fall back to title so
    // unrelated products never collapse together
    const key = `${v.retailer}|${v.style_id || v.title}|${v.color}`;
    const group = groups.get(key);
    if (group) {
      group.push(v);
    } else {
      groups.set(key, [v]);
    }
  }

  const collapsed: ProductVariant[] = [];
  for (const group of groups.values()) {
    const seenSizes = new Set<string>();
    const rows = group.filter((r) => {
      if (seenSizes.has(r.size)) return false;
      seenSizes.add(r.size);
      return true;
    });

    let numericTotal = 0;
    let hasNumeric = false;
    for (const r of rows) {
      const n = Number(r.inventory);
      if (r.inventory !== '' && Number.isFinite(n)) {
        numericTotal += n;
        hasNumeric = true;
      }
    }
    const inventory = hasNumeric
      ? String(numericTotal)
      : (rows.find((r) => r.inventory !== '')?.inventory ?? '');

    collapsed.push({
      ...rows[0],
      size: rows.map((r) => r.size).filter((s) => s !== '').join(', '),
      upc: rows.map((r) => r.upc).join(', '),
      inventory,
    });
  }
  return collapsed;
}

/** The site's configured display name for the sheet tab, else its name capitalised. */
async function formatSiteDisplay(site: string): Promise<string> {
  const configured = (await getSites()).find((s) => s.name.toLowerCase() === site.toLowerCase())?.display_name;
  return configured || site.charAt(0).toUpperCase() + site.slice(1);
}

/**
 * Generates an Excel file from an array of ProductVariant records.
 *
 * @param variants - The variant rows to write
 * @param outputPath - Full file path for the output .xlsx
 * @param site - Site name for the sheet tab (e.g. "shop-a")
 * @param brand - Brand name for the sheet tab (e.g. "Example Brand")
 * @returns The absolute file path of the created Excel file
 * @throws Error if the file cannot be written
 */
export async function generateExcel(
  variants: ProductVariant[],
  outputPath: string,
  site?: string,
  brand?: string,
): Promise<string> {
  // Validate output path stays within storage directory before any filesystem operations
  const resolvedOutput = path.resolve(outputPath);
  const resolvedBase = path.resolve(config.scraping.storageDir);
  if (!resolvedOutput.startsWith(resolvedBase + path.sep) && resolvedOutput !== resolvedBase) {
    throw new Error(`Output path escapes storage directory: ${resolvedOutput}`);
  }

  logger.info('Generating Excel file', {
    operation: 'generateExcel',
    variantCount: variants.length,
    outputPath: resolvedOutput,
  });

  // Ensure the output directory exists
  const dir = path.dirname(resolvedOutput);
  await fs.mkdir(dir, { recursive: true });

  // Streaming workbook writer: writes rows incrementally to avoid pinning
  // tens of MB in memory for large (30k+) variant runs. `useStyles: true` is
  // required for the bold header row; `useSharedStrings: true` produces smaller
  // files at a small CPU cost.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: resolvedOutput,
    useStyles: true,
    useSharedStrings: true,
  });

  // Build dynamic sheet tab name: "Shop A - Example Brand_20260225181300"
  let sheetName = 'Product Variants';
  if (site && brand) {
    const now = new Date();
    const ts = [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    // Excel sheet names max 31 chars and can't contain certain characters
    const rawName = `${await formatSiteDisplay(site)} - ${brand}_${ts}`;
    sheetName = rawName.substring(0, 31);
  }
  const sheet = workbook.addWorksheet(sheetName);

  // Set up columns (the header row is materialized as row 1 when columns are assigned)
  sheet.columns = COLUMNS.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width,
  }));

  // Style the header row, then commit it so the buffer can flush.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  // Safety: ensure all values are primitives — never write raw objects to cells.
  // Hoisted out of the row loop to avoid reallocating the closure per row.
  const safeStr = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let str: string;
    if (typeof v === 'object') {
      if (Array.isArray(v)) {
        str = v.map(item => (item === null || item === undefined) ? '' : String(item)).join(', ');
      } else {
        const obj = v as Record<string, unknown>;
        str = String(obj.name || obj.value || obj.displayName || '');
      }
    } else {
      str = String(v);
    }
    // Prevent Excel formula injection: prefix formula characters with single quote
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return str;
  };

  // Collapse size-level rows to one row per product before writing.
  const collapsedVariants = collapseVariants(variants);

  // Add and commit one row per collapsed product — streaming mode flushes to disk as we go.
  for (const variant of collapsedVariants) {
    const row = sheet.addRow({
      retailer: safeStr(variant.retailer),
      style_id: safeStr(variant.style_id),
      upc: safeStr(variant.upc),
      product_type: safeStr(variant.product_type),
      title: safeStr(variant.title),
      color: safeStr(variant.color),
      size: safeStr(variant.size),
      description: safeStr(variant.description),
      list_price: safeStr(variant.list_price),
      selling_price: safeStr(variant.selling_price),
      url: safeStr(variant.url),
      source: safeStr(variant.source),
      inventory: safeStr(variant.inventory),
    });
    row.commit();
  }

  // Finalize the sheet, then the workbook (writes XLSX archive footer).
  sheet.commit();
  await workbook.commit();

  const absolutePath = path.resolve(outputPath);
  logger.info('Excel file created', {
    operation: 'generateExcel',
    outputPath: absolutePath,
    rowCount: collapsedVariants.length,
    variantCount: variants.length,
  });

  return absolutePath;
}
