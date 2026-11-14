// The Blackmagic Videohub Ethernet protocol (TCP port 9990), as far as this module needs it.
//
// Both sides send blocks: a header line ending in ':', lines of data, then a blank line. On connect
// the router dumps its whole state (the prelude) and ends with END PRELUDE. Every block a client
// sends is answered with ACK or NAK; accepted changes are then broadcast to every client as an
// ordinary block, which is how this module learns about them, from itself or anyone else.

export const DEFAULT_PORT = 9990;

export type Lock = 'U' | 'L' | 'O'; // unlocked, locked by another client, owned (locked by us)

export interface Block {
  header: string;
  lines: string[];
}

/** What the router has told us. Rebuilt from the router on every connect, never saved. */
export interface RouterState {
  protocol: string | null;
  present: 'true' | 'false' | 'needs_update' | null;
  model: string | null;
  name: string | null;
  uniqueId: string | null;
  inputs: number;
  outputs: number;
  inputLabels: string[];
  outputLabels: string[];
  /** routes[output] = input, or -1 while unknown. */
  routes: number[];
  locks: Lock[];
  takeMode: boolean | null;
}

export function emptyRouter(): RouterState {
  return {
    protocol: null,
    present: null,
    model: null,
    name: null,
    uniqueId: null,
    inputs: 0,
    outputs: 0,
    inputLabels: [],
    outputLabels: [],
    routes: [],
    locks: [],
    takeMode: null
  };
}

/** Splits a TCP stream into blocks. Feed it chunks; it returns the complete blocks so far. */
export class BlockReader {
  private buf = '';
  private lines: string[] = [];

  push(chunk: string): Block[] {
    this.buf += chunk;
    const out: Block[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line === '') {
        if (this.lines.length) out.push({ header: this.lines[0]!, lines: this.lines.slice(1) });
        this.lines = [];
      } else {
        this.lines.push(line);
      }
    }
    if (this.buf.length > 64 * 1024) throw new Error('line too long');
    return out;
  }
}

export function formatBlock(header: string, lines: string[] = []): string {
  return [header, ...lines, '', ''].join('\n');
}

/** "12 Camera 1" -> [12, "Camera 1"]; null if the line does not start with an index. */
function indexed(line: string): [number, string] | null {
  const m = /^(\d+) ?(.*)$/.exec(line);
  return m ? [Number(m[1]), m[2]!] : null;
}

function fieldMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) map.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
  }
  return map;
}

function resize<T>(list: T[], n: number, fill: (i: number) => T): T[] {
  const out = list.slice(0, n);
  for (let i = out.length; i < n; i++) out.push(fill(i));
  return out;
}

/** Applies one block from the router. Returns true if it changed anything we show. */
export function applyBlock(s: RouterState, b: Block): boolean {
  switch (b.header) {
    case 'PROTOCOL PREAMBLE:': {
      s.protocol = fieldMap(b.lines).get('Version') ?? s.protocol;
      return true;
    }
    case 'VIDEOHUB DEVICE:': {
      const f = fieldMap(b.lines);
      const present = f.get('Device present');
      if (present === 'true' || present === 'false' || present === 'needs_update') s.present = present;
      s.model = f.get('Model name') ?? s.model;
      s.name = f.get('Friendly name') ?? s.name;
      s.uniqueId = f.get('Unique ID') ?? s.uniqueId;
      const inputs = Number(f.get('Video inputs') ?? s.inputs);
      const outputs = Number(f.get('Video outputs') ?? s.outputs);
      s.inputs = Number.isInteger(inputs) && inputs >= 0 && inputs <= 1024 ? inputs : s.inputs;
      s.outputs = Number.isInteger(outputs) && outputs >= 0 && outputs <= 1024 ? outputs : s.outputs;
      s.inputLabels = resize(s.inputLabels, s.inputs, (i) => `Input ${i + 1}`);
      s.outputLabels = resize(s.outputLabels, s.outputs, (i) => `Output ${i + 1}`);
      s.routes = resize(s.routes, s.outputs, () => -1);
      s.locks = resize<Lock>(s.locks, s.outputs, () => 'U');
      return true;
    }
    case 'INPUT LABELS:':
    case 'OUTPUT LABELS:': {
      const list = b.header === 'INPUT LABELS:' ? s.inputLabels : s.outputLabels;
      let changed = false;
      for (const l of b.lines) {
        const p = indexed(l);
        if (p && p[0] < list.length && list[p[0]] !== p[1]) {
          list[p[0]] = p[1];
          changed = true;
        }
      }
      return changed;
    }
    case 'VIDEO OUTPUT ROUTING:': {
      let changed = false;
      for (const l of b.lines) {
        const p = indexed(l);
        const input = p ? Number(p[1]) : NaN;
        if (p && p[0] < s.routes.length && Number.isInteger(input) && input >= 0 && s.routes[p[0]] !== input) {
          s.routes[p[0]] = input;
          changed = true;
        }
      }
      return changed;
    }
    case 'VIDEO OUTPUT LOCKS:': {
      let changed = false;
      for (const l of b.lines) {
        const p = indexed(l);
        const lock = p?.[1];
        if (p && p[0] < s.locks.length && (lock === 'U' || lock === 'L' || lock === 'O') && s.locks[p[0]] !== lock) {
          s.locks[p[0]] = lock;
          changed = true;
        }
      }
      return changed;
    }
    case 'CONFIGURATION:': {
      const take = fieldMap(b.lines).get('Take Mode');
      if (take === undefined) return false;
      s.takeMode = take === 'true';
      return true;
    }
    default:
      return false; // monitoring outputs, serial ports, hardware status: not shown yet
  }
}

/** Labels go over the wire one per line, so they cannot hold line breaks. */
export function cleanLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
}
