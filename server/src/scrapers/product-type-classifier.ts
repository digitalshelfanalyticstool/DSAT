/**
 * Product type classifier — derives a product type from the scraped title.
 *
 * Zero-import leaf module (chokepoint-validator pattern, same as
 * image-url-canonicalizer): safe to import from persistence, scripts, and
 * routes without re-closing the database.ts import cycle.
 *
 * Rules are ORDER-SENSITIVE: the first matching pattern wins. Category
 * patterns were validated against live prod titles, e.g.
 * retailer swim bottoms are titled "…Hipster Bottoms" without the word
 * "swim", some brands' home goods appear at only one retailer, and
 * "Shooties" is a real shoe type.
 */

export type ProductType =
  | 'Swim'
  | 'Shoes'
  | 'Bags'
  | 'Accessories'
  | 'Home'
  | 'Fragrance'
  | 'Dress'
  | 'Jumpsuit/Romper'
  | 'Sweater'
  | 'Jacket/Coat'
  | 'Pants'
  | 'Skirt'
  | 'Shorts'
  | 'Top'
  | 'Other';

// First match wins. Non-apparel categories are checked before apparel so
// e.g. "One Piece Swimsuit" never falls through to Dress via some other
// keyword.
const TYPE_RULES: ReadonlyArray<readonly [ProductType, RegExp]> = [
  // "Bottoms" (standalone) is how retailers title swim bottoms; apparel
  // bottoms are always "Pants"/"Shorts"/"Skirt".
  ['Swim', /swim|bikini|bandeau|one.?piece|rash\s?guard|\bbottoms\b/i],
  // Shoes and Top are split across two rows each to stay under Sonar's
  // regex-complexity cap; duplicate types are fine — first match wins.
  ['Shoes', /\bshoes?\b|sandal|\bpumps?\b|sneaker|loafer|\bboots?\b|\bheels?\b/i],
  ['Shoes', /\bflats\b|\bmules?\b|\bslides?\b|shootie|espadrille|\bwedges?\b/i],
  ['Bags', /handbag|\btotes?\b|crossbody|satchel|wallet|clutch|backpack/i],
  ['Accessories', /earring|necklace|bracelet|scar(f|ves)|\bbelts?\b|\bhats?\b|sunglass|jewelry|\brings?\b/i],
  ['Home', /duvet|comforter|\bshams?\b|pillow|towel|sheet set|blanket|\bthrows?\b/i],
  ['Fragrance', /parfum|toilette|cologne|fragrance|body (mist|spray)/i],
  ['Dress', /gown|dress(?!ing)|\bshift\b/i],
  ['Jumpsuit/Romper', /jumpsuit|romper/i],
  ['Sweater', /sweater|cardigan|pullover|turtleneck|hoodie/i],
  ['Jacket/Coat', /jacket|blazer|\bcoats?\b|\bvests?\b/i],
  // Before Pants: "Denim Shorts" is Shorts, not Pants. Plural-only so
  // "Short Sleeve Blouse" does NOT classify as Shorts.
  ['Shorts', /\bshorts\b/i],
  ['Pants', /\bpants?\b|trouser|legging|\bjeans?\b|denim/i],
  ['Skirt', /skirt|skort/i],
  ['Top', /blouse|\btops?\b|\btees?\b|t-shirt|shirt|\bcamis?\b/i],
  ['Top', /\btanks?\b|bodysuit|\bshell\b|tunic|henley|\bpolos?\b/i],
];

/** Classify a product title into a ProductType. Never throws; unknown → 'Other'. */
export function classifyProductType(title: string | null | undefined): ProductType {
  if (!title) return 'Other';
  for (const [type, pattern] of TYPE_RULES) {
    if (pattern.test(title)) return type;
  }
  return 'Other';
}
