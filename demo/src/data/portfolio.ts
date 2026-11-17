/**
 * The tree tab's dataset: a flat list with a parent reference.
 *
 * The engine takes either shape — a nested model through `childrenOf`, or a
 * flat one through `parentOf` — and a flat list is the interesting one, because
 * every node is a row the pipeline can sort, search and filter before the tree
 * is rebuilt around whatever survived.
 */

export interface Initiative {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'Division' | 'Programme' | 'Project' | 'Workstream';
  owner: string;
  stage: string;
  team: number;
  budget: number;
  spend: number;
  health: string;
}

const DIVISIONS = ['Platform', 'Data', 'Commerce', 'Devices'];

const PROGRAMMES: Record<string, string[]> = {
  Platform: ['Runtime', 'Identity', 'Edge delivery'],
  Data: ['Warehouse', 'Streaming', 'Governance'],
  Commerce: ['Checkout', 'Pricing', 'Fulfilment'],
  Devices: ['Firmware', 'Diagnostics'],
};

const PROJECT_WORDS = [
  'Migration', 'Rewrite', 'Rollout', 'Hardening', 'Consolidation', 'Observability',
  'Automation', 'Compliance', 'Latency', 'Self-service', 'Partner API', 'Archive',
];

const WORKSTREAMS = ['Discovery', 'Build', 'Integration', 'Rollout', 'Enablement', 'Cutover'];

const OWNERS = [
  'A. Lovelace', 'G. Hopper', 'K. Johnson', 'R. Perlman', 'B. Liskov', 'S. Goldwasser',
  'V. Cerf', 'A. Borg', 'F. Allen', 'L. Lamport', 'P. Varma', 'O. Osei',
];

const STAGES = ['Planning', 'In flight', 'Review', 'Landed', 'Paused'];
const HEALTH = ['On track', 'At risk', 'Off track', 'Complete'];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The whole portfolio, flat, in the order a tree would like to find it. */
export function makePortfolio(seed = 7): Initiative[] {
  const rng = seeded(seed);
  const rows: Initiative[] = [];

  const pick = <V,>(list: readonly V[]): V => list[Math.floor(rng() * list.length)] as V;
  const money = (low: number, high: number) =>
    Math.round((low + rng() * (high - low)) / 1000) * 1000;

  for (const division of DIVISIONS) {
    const divisionId = division.toLowerCase().replace(/\s+/g, '-');
    rows.push({
      id: divisionId,
      parentId: null,
      name: division,
      kind: 'Division',
      owner: pick(OWNERS),
      stage: 'In flight',
      team: 0,
      budget: 0,
      spend: 0,
      health: 'On track',
    });

    for (const programme of PROGRAMMES[division] ?? []) {
      const programmeId = `${divisionId}/${programme.toLowerCase().replace(/\s+/g, '-')}`;
      rows.push({
        id: programmeId,
        parentId: divisionId,
        name: programme,
        kind: 'Programme',
        owner: pick(OWNERS),
        stage: pick(STAGES),
        team: 0,
        budget: 0,
        spend: 0,
        health: pick(HEALTH),
      });

      const projects = 2 + Math.floor(rng() * 3);
      for (let p = 0; p < projects; p++) {
        const title = `${pick(PROJECT_WORDS)} ${['I', 'II', 'III'][Math.floor(rng() * 3)] ?? 'I'}`;
        const projectId = `${programmeId}/p${p}`;
        rows.push({
          id: projectId,
          parentId: programmeId,
          name: title,
          kind: 'Project',
          owner: pick(OWNERS),
          stage: pick(STAGES),
          team: 0,
          budget: 0,
          spend: 0,
          health: pick(HEALTH),
        });

        const streams = 2 + Math.floor(rng() * 3);
        for (let w = 0; w < streams; w++) {
          const budget = money(80_000, 1_400_000);
          rows.push({
            id: `${projectId}/w${w}`,
            parentId: projectId,
            name: pick(WORKSTREAMS),
            kind: 'Workstream',
            owner: pick(OWNERS),
            stage: pick(STAGES),
            team: 2 + Math.floor(rng() * 14),
            budget,
            spend: Math.round(budget * (0.35 + rng() * 0.95)),
            health: pick(HEALTH),
          });
        }
      }
    }
  }

  // Roll the leaf numbers up, so a parent row reads as the sum of its branch
  // the way a reader of a tree grid expects.
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.kind !== 'Workstream') continue;
    let parent = row.parentId ? byId.get(row.parentId) : undefined;
    while (parent) {
      parent.team += row.team;
      parent.budget += row.budget;
      parent.spend += row.spend;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
  }
  return rows;
}
