/**
 * Fictional demo catalog: three retailers on `.example` hosts, three brands,
 * each brand's styles carried at every retailer, and six weeks of daily
 * snapshots. Pure and deterministic for a seed; `demo.ts` writes it to the
 * database. Names, prices and images are invented; images are the local
 * placeholders in `client/public/demo/`.
 */

export const DEMO_SITES = [
  { name: 'northwind', display_name: 'Northwind Outfitters', base_url: 'https://northwind.example' },
  { name: 'harborline', display_name: 'Harborline', base_url: 'https://harborline.example' },
  { name: 'juniperrow', display_name: 'Juniper Row', base_url: 'https://juniperrow.example' },
] as const;

export const DEMO_BRANDS = ['Red Maple', 'Slate & Sun', 'Field Day'] as const;

export const DEMO_RULE_PREFIX = 'Demo: ';

export const DEMO_IMAGE_COUNT = 6;

const SIZES = ['S', 'M', 'L'];

/** Per brand: [title, color, list price at the first retailer]. Red Maple starts at $44+ so only a markdown crosses its $40 rule. */
const STYLES: Record<(typeof DEMO_BRANDS)[number], [string, string, number][]> = {
  'Red Maple': [
    ['Linen Tee', 'Oat', 48], ['Wide-Leg Trouser', 'Black', 88], ['Cable Knit Sweater', 'Cream', 98], ['Wrap Dress', 'Rust', 92],
    ['Rib Tank', 'White', 44], ['Chore Coat', 'Olive', 128], ['Poplin Shirt', 'Sky', 68],
  ],
  'Slate & Sun': [
    ['Denim Jacket', 'Indigo', 110], ['Pleated Skirt', 'Navy', 72], ['Slip Dress', 'Sage', 84], ['Oxford Shirt', 'Blue', 64],
    ['Crewneck Sweater', 'Heather Grey', 78], ['Trench Coat', 'Khaki', 168], ['Midi Skirt', 'Black', 66],
  ],
  'Field Day': [
    ['Hooded Sweatshirt', 'Forest', 58], ['Cargo Pant', 'Stone', 62], ['Utility Shorts', 'Sand', 42], ['Knit Polo', 'Cobalt', 46],
    ['Puffer Vest', 'Black', 96], ['Linen Shorts', 'Natural', 38], ['Henley', 'Charcoal', 34],
  ],
};

export interface DemoProduct {
  retailer: string;
  brand: string;
  style_id: string;
  title: string;
  url: string;
}

export interface DemoSnapshot {
  style_id: string;
  sku: string;
  color: string;
  size: string;
  list_price: number;
  selling_price: number;
  /** Units on hand as text, like scraped inventory; '0' is out of stock. */
  inventory: string;
  /** '' for the product with a missing image. */
  image_url: string;
}

export interface DemoRun {
  site: string;
  brand: string;
  /** 41 is the first day, 0 is today. */
  daysAgo: number;
  snapshots: DemoSnapshot[];
}

/** mulberry32: small, fast, deterministic. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s: string) => s.toLowerCase().replaceAll('&', 'and').replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/(^-)|(-$)/g, '');
const cents = (n: number) => Math.round(n * 100) / 100;

/** Scripted events, so every demo shows each kind of change (day = index from the first day). */
const EVENTS = {
  /** Red Maple Linen Tee at Northwind: $48 → $36 twelve days ago (crosses the $40 rule). */
  redMapleMarkdown: { site: 'northwind', brand: 'Red Maple', style: 0, day: 29, factor: 0.75 },
  /** Slate & Sun Pleated Skirt at Harborline sells out a week ago and stays out. */
  sellOut: { site: 'harborline', brand: 'Slate & Sun', style: 1, from: 35 },
  /** Field Day Cargo Pant at Juniper Row is out for a week, then restocked. */
  restock: { site: 'juniperrow', brand: 'Field Day', style: 1, from: 20, to: 27 },
  /** Field Day Puffer Vest at Harborline has no image. */
  noImage: { site: 'harborline', brand: 'Field Day', style: 4 },
};

const is = (e: { site: string; brand: string; style: number }, site: string, brand: string, style: number) =>
  e.site === site && e.brand === brand && e.style === style;

export function generateDemoData(seed = 1, days = 42): { products: DemoProduct[]; runs: DemoRun[] } {
  const rand = random(seed);
  const products: DemoProduct[] = [];
  const runs: DemoRun[] = Array.from({ length: days }, (_, day) => day).flatMap((day) =>
    DEMO_SITES.flatMap((site) => DEMO_BRANDS.map((brand) => ({ site: site.name, brand, daysAgo: days - 1 - day, snapshots: [] as DemoSnapshot[] }))),
  );
  const runFor = (day: number, site: string, brand: string) =>
    runs.find((r) => r.daysAgo === days - 1 - day && r.site === site && r.brand === brand)!;

  DEMO_SITES.forEach((site, siteIndex) => {
    DEMO_BRANDS.forEach((brand, brandIndex) => {
      STYLES[brand].forEach(([title, color, basePrice], style) => {
        const styleId = `${brand.slice(0, 2).toUpperCase()}${brandIndex}${String(style + 1).padStart(3, '0')}`;
        products.push({ retailer: site.name, brand, style_id: styleId, title, url: `${site.base_url}/products/${slug(`${brand} ${title}`)}` });

        // Retailers price the same style a little differently; never below a Red Maple $44 floor.
        const listPrice = Math.max(basePrice + siteIndex * 2 - (siteIndex === 2 ? 4 : 0), brand === 'Red Maple' ? 44 : 0);
        const image = is(EVENTS.noImage, site.name, brand, style) ? '' : `/demo/${((brandIndex * 7 + style) % DEMO_IMAGE_COUNT) + 1}.svg`;

        // One random markdown for about a third of the rest, at a random day, 15–40% off.
        let markdownDay = -1;
        let factor = 1;
        if (is(EVENTS.redMapleMarkdown, site.name, brand, style)) {
          markdownDay = EVENTS.redMapleMarkdown.day;
          factor = EVENTS.redMapleMarkdown.factor;
        } else if (brand !== 'Red Maple' && rand() < 0.35) {
          markdownDay = 5 + Math.floor(rand() * (days - 6));
          factor = 0.6 + rand() * 0.25;
        }

        const stock = SIZES.map(() => 4 + Math.floor(rand() * 30));
        for (let day = 0; day < days; day++) {
          const soldOut = (is(EVENTS.sellOut, site.name, brand, style) && day >= EVENTS.sellOut.from)
            || (is(EVENTS.restock, site.name, brand, style) && day >= EVENTS.restock.from && day <= EVENTS.restock.to);
          const price = markdownDay >= 0 && day >= markdownDay ? cents(Math.floor(listPrice * factor) - 0.01) : listPrice;
          SIZES.forEach((size, i) => {
            // Stock drifts down and is topped up when low, but stays in stock unless an event says otherwise.
            stock[i] = stock[i] <= 2 ? 12 + Math.floor(rand() * 20) : stock[i] - Math.floor(rand() * 3);
            runFor(day, site.name, brand).snapshots.push({
              style_id: styleId,
              sku: `${styleId}-${size}`,
              color,
              size,
              list_price: listPrice,
              selling_price: price,
              inventory: soldOut ? '0' : String(Math.max(stock[i], 1)),
              image_url: image,
            });
          });
        }
      });
    });
  });

  return { products, runs };
}
