/**
 * Clean diff of two Jupyter notebooks for the hover previews: only the cells' source is compared,
 * not their outputs, execution counts or metadata. Hunks are headed with the cell they are in.
 */

/** The cells of a .ipynb as text: a `# %% [code]` / `# %% [markdown]` line, then the source. */
export function notebookLines(json: string): string[] {
  if (!json.trim()) {
    return [];
  }
  let nb: { cells?: { cell_type?: string; source?: string | string[] }[] };
  try {
    nb = JSON.parse(json);
  } catch {
    return json.split('\n');
  }
  const lines: string[] = [];
  for (const cell of nb.cells ?? []) {
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
    lines.push(`# %% [${cell.cell_type ?? 'code'}]`, ...source.replace(/\n$/, '').split('\n'));
  }
  return lines;
}

const CELL = /^# %% \[/;

/** Unified-diff style lines (`@@ cell N @@`, ` `, `+`, `-`) between two notebooks' cell lines. */
export function notebookDiff(before: string[], after: string[], context = 2): string[] {
  const ops = diffLines(before, after);
  // Cell number of each op in the new notebook (a removed cell counts as the one before it).
  const cellOf: number[] = [];
  let cell = 0;
  for (const op of ops) {
    if (CELL.test(op.text) && op.kind !== '-') {
      cell++;
    }
    cellOf.push(cell);
  }
  const keep = ops.map(() => false);
  ops.forEach((op, i) => {
    if (op.kind !== ' ') {
      // Context stays inside the cell of the change.
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
        if (cellOf[j] === cellOf[i] || ops[j].kind !== ' ') {
          keep[j] = true;
        }
      }
    }
  });
  const out: string[] = [];
  let lastCell = -1;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      lastCell = -1;
      return;
    }
    if (cellOf[i] !== lastCell && !(CELL.test(op.text) && op.kind === ' ')) {
      out.push(`@@ cell ${Math.max(1, cellOf[i])} @@`);
      lastCell = cellOf[i];
    }
    if (CELL.test(op.text)) {
      // A whole cell added or removed: its marker says so; unchanged markers are left out.
      if (op.kind !== ' ') {
        out.push(`${op.kind}${op.text}`);
      }
      return;
    }
    out.push(`${op.kind}${op.text}`);
  });
  return out;
}

/** Line diff (LCS on what remains after the common start and end). */
export function diffLines(a: string[], b: string[]): { kind: ' ' | '+' | '-'; text: string }[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ kind: ' ' as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: ' ' as const, text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const middle: { kind: ' ' | '+' | '-'; text: string }[] = [];
  if (x.length * y.length > 4_000_000) {
    // Too big to align line by line: all removed, then all added.
    middle.push(...x.map((text) => ({ kind: '-' as const, text })), ...y.map((text) => ({ kind: '+' as const, text })));
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ kind: ' ', text: x[i++] });
        j++;
      } else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        middle.push({ kind: '-', text: x[i++] });
      } else {
        middle.push({ kind: '+', text: y[j++] });
      }
    }
  }
  return [...head, ...middle, ...tail];
}
