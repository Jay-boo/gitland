/**
 * Lane layout for a commit graph. Commits must be in topological order (children before parents).
 * Each row gets the column of its node plus the line segments to draw inside that row:
 * y = 0 is the top of the row, 0.5 the node, 1 the bottom.
 */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  segments: Segment[];
}

export const PALETTE_SIZE = 10;

export function computeGraph(commits: { sha: string; parents: string[] }[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const laneColors: number[] = [];
  let nextColor = 0;
  let width = 1;
  const rows: GraphRow[] = [];

  const allocate = (except: number): number => {
    let i = lanes.findIndex((l, k) => l === null && k !== except);
    if (i === -1) {
      i = lanes.length;
      lanes.push(null);
    }
    laneColors[i] = nextColor++ % PALETTE_SIZE;
    return i;
  };

  for (const c of commits) {
    const segments: Segment[] = [];
    const before = lanes.slice();
    const beforeColors = laneColors.slice();

    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = allocate(-1);
    }
    const color = laneColors[lane];

    // Lines coming from the row above: either converge into this node or pass through.
    before.forEach((sha, j) => {
      if (sha === null) {
        return;
      }
      if (sha === c.sha) {
        segments.push({ x1: j, y1: 0, x2: lane, y2: 0.5, color: beforeColors[j] });
        lanes[j] = null;
      } else {
        segments.push({ x1: j, y1: 0, x2: j, y2: 1, color: beforeColors[j] });
      }
    });

    const [first, ...others] = c.parents;
    if (first !== undefined) {
      const existing = lanes.indexOf(first);
      if (existing !== -1 && existing !== lane) {
        // Parent is already expected in another lane: join it.
        segments.push({ x1: lane, y1: 0.5, x2: existing, y2: 1, color });
      } else {
        lanes[lane] = first;
        laneColors[lane] = color;
        segments.push({ x1: lane, y1: 0.5, x2: lane, y2: 1, color });
      }
    }
    for (const p of others) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = allocate(lane);
        lanes[k] = p;
      }
      segments.push({ x1: lane, y1: 0.5, x2: k, y2: 1, color: laneColors[k] });
    }

    width = Math.max(width, before.length, lanes.length, lane + 1);
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
    rows.push({ lane, color, segments });
  }
  return { rows, width };
}
