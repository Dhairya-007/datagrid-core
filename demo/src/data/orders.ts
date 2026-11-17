/**
 * The dataset the demo runs on: plausible sales orders, generated.
 *
 * It is generated rather than shipped as JSON so the row count is a slider
 * rather than a download, and generated from a seeded PRNG so every visitor
 * sees the same numbers and a screenshot stays true.
 */

export interface Order {
  id: number;
  ref: string;
  customer: string;
  region: string;
  country: string;
  channel: string;
  rep: string;
  category: string;
  product: string;
  units: number;
  unitPrice: number;
  revenue: number;
  margin: number;
  status: string;
  priority: string;
  placed: Date;
  ships: Date | null;
}

/** mulberry32: small, fast, and identical in every browser. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['EMEA', ['United Kingdom', 'Germany', 'France', 'Spain', 'Netherlands', 'Sweden', 'Poland', 'UAE']],
  ['AMER', ['United States', 'Canada', 'Mexico']],
  ['APAC', ['India', 'Japan', 'Singapore', 'Australia', 'South Korea', 'Indonesia']],
  ['LATAM', ['Brazil', 'Argentina', 'Chile', 'Colombia']],
];

const CHANNELS = ['Direct', 'Partner', 'Online', 'Retail', 'Reseller'] as const;

const CATALOGUE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Compute', ['Rackmount R2', 'Rackmount R4', 'Edge Node 110', 'Blade C8']],
  ['Storage', ['Array S40', 'Array S80', 'Cold Vault 200', 'NVMe Shelf 12']],
  ['Networking', ['Switch 48T', 'Switch 24P', 'Router XR', 'Optic 400G']],
  ['Software', ['Fleet Console', 'Observability Pack', 'Policy Engine', 'Backup Suite']],
  ['Support', ['Gold 24x7', 'Silver 8x5', 'Onsite Spares', 'Migration Days']],
];

const STATUSES = ['Paid', 'Invoiced', 'Pending', 'Overdue', 'Refunded', 'Draft'] as const;
const STATUS_WEIGHTS = [0.34, 0.2, 0.18, 0.12, 0.06, 0.1];
const PRIORITIES = ['Critical', 'High', 'Normal', 'Low'] as const;

const FIRST = [
  'Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Radia', 'Barbara', 'Donald', 'Margaret', 'Dennis',
  'Shafi', 'Vint', 'Anita', 'Edsger', 'Frances', 'Ken', 'Leslie', 'Sophie', 'Mateo', 'Yuki',
  'Priya', 'Omar', 'Ingrid', 'Hugo', 'Lena', 'Diego', 'Noor', 'Kwame', 'Elif', 'Tomas',
];
const LAST = [
  'Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Perlman', 'Liskov', 'Knuth', 'Hamilton',
  'Ritchie', 'Goldwasser', 'Cerf', 'Borg', 'Dijkstra', 'Allen', 'Thompson', 'Lamport', 'Okonjo',
  'Nakamura', 'Fernandes', 'Haraldsson', 'Mbeki', 'Costa', 'Varga', 'Reyes', 'Osei', 'Yilmaz',
];

const COMPANY_HEAD = [
  'Northwind', 'Helios', 'Basalt', 'Cobalt', 'Meridian', 'Ironwood', 'Lumen', 'Vantage', 'Quarry',
  'Alloy', 'Harbour', 'Sable', 'Kestrel', 'Orchard', 'Tessellate', 'Granite', 'Palomar', 'Vireo',
];
const COMPANY_TAIL = ['Logistics', 'Dynamics', 'Systems', 'Analytics', 'Foundry', 'Labs', 'Group', 'Partners', 'Works'];

function pick<V>(rng: () => number, list: readonly V[]): V {
  return list[Math.floor(rng() * list.length)] as V;
}

function weighted(rng: () => number, list: readonly string[], weights: readonly number[]): string {
  let roll = rng();
  for (let i = 0; i < list.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return list[i] as string;
  }
  return list[list.length - 1] as string;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** A deterministic set of `count` orders. */
export function makeOrders(count: number, seed = 20261117): Order[] {
  const rng = seeded(seed);
  const reps = Array.from(
    { length: 24 },
    () => `${pick(rng, FIRST)} ${pick(rng, LAST)}`,
  );
  const customers = Array.from(
    { length: 180 },
    () => `${pick(rng, COMPANY_HEAD)} ${pick(rng, COMPANY_TAIL)}`,
  );

  const orders: Order[] = new Array(count);
  const end = Date.UTC(2026, 10, 1);
  const span = 1000 * 60 * 60 * 24 * 540;

  for (let i = 0; i < count; i++) {
    const [region, countries] = pick(rng, MARKETS);
    const [category, products] = pick(rng, CATALOGUE);
    const status = weighted(rng, STATUSES, STATUS_WEIGHTS);

    // Software and support sell in small quantities at high prices; hardware
    // the other way round, so the money columns have a shape worth sorting.
    const hardware = category === 'Compute' || category === 'Storage' || category === 'Networking';
    const units = hardware ? 1 + Math.floor(rng() ** 2 * 120) : 1 + Math.floor(rng() ** 3 * 18);
    const unitPrice = round(hardware ? 420 + rng() ** 2 * 9400 : 1800 + rng() ** 1.5 * 24000, 2);
    const placed = new Date(end - Math.floor(rng() * span));
    const shipped = status !== 'Draft' && rng() > 0.08;

    orders[i] = {
      id: i + 1,
      ref: `ORD-${String(104_000 + i * 7).padStart(6, '0')}`,
      customer: pick(rng, customers),
      region,
      country: pick(rng, countries),
      channel: pick(rng, CHANNELS),
      rep: pick(rng, reps),
      category,
      product: pick(rng, products),
      units,
      unitPrice,
      revenue: round(units * unitPrice, 2),
      margin: round(category === 'Software' ? 0.42 + rng() * 0.46 : 0.04 + rng() * 0.44, 4),
      status,
      priority: weighted(rng, PRIORITIES, [0.08, 0.22, 0.52, 0.18]),
      placed,
      ships: shipped
        ? new Date(placed.getTime() + Math.floor(1 + rng() * 26) * 86_400_000)
        : null,
    };
  }
  return orders;
}

/** The fields the demo's filter popovers offer a value list for. */
export const CATEGORICAL_FIELDS = new Set([
  'region',
  'country',
  'channel',
  'category',
  'product',
  'status',
  'priority',
  'rep',
]);
