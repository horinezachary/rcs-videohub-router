// Videohub Router: route sources to destinations on a Blackmagic Videohub over its Ethernet protocol.
//
// The router is the source of truth. Routes, labels and locks are read from it on every connect and
// kept only in memory; state holds the module's own things (selected destination, salvos), and
// config holds the router's address. Starting, restoring and reconnecting only listen. A route,
// salvo or label change goes out only when someone presses a key or taps the screen.
//
// Stream Deck:
//   keys 1-10   sources (with more than 10 inputs: 1-9, and key 10 pages through them)
//   key 11      previous destination      key 12  selected destination      key 13  next destination
//   key 14      salvo 1 (hold)            key 15  salvo 2 (hold), or TAKE in take mode

import { randomUUID } from 'node:crypto';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { VideohubClient } from './client.js';
import { DEFAULT_PORT, emptyRouter, type RouterState } from './protocol.js';

export interface Salvo {
  id: string;
  name: string;
  /** [output, input] pairs, recalled together in one block. */
  routes: [number, number][];
}

export interface State {
  selDest: number;
  srcPage: number;
  salvos: Salvo[];
}

export interface Config {
  address: string;
  port: number;
  /** Pick a source, then press TAKE, instead of routing on the first press. */
  takeMode: boolean;
}

type C = Ctx<State, Config>;
export type View = 'routes' | 'salvos' | 'labels' | 'setup';

export const KEY = { PAGE: 9, PREV: 10, DEST: 11, NEXT: 12, SALVO1: 13, SALVO2: 14 } as const;
export const MAX_SALVOS = 32;
const HOLD_MS = 700;

// Key colours: the system theme's, since keys have no CSS.
const ACCENT = '#F5A524';
const ON_ACCENT = '#16181C';
const ARMED = '#5C4310';
const SELECTED = '#3A2E14';
const DANGER = '#3A1E1C';

/** Everything that is not saved: the connection and what the panel is looking at. */
interface Runtime {
  client: VideohubClient | null;
  armed: number | null;
  view: View;
  ctx: C;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function validAddress(a: unknown): a is string {
  return typeof a === 'string' && (a === '' || ADDRESS_RE.test(a));
}

function cfg(ctx: C): Config {
  const c = ctx.config ?? ({} as Config);
  return { address: c.address ?? '', port: c.port ?? DEFAULT_PORT, takeMode: c.takeMode ?? false };
}

function router(): RouterState {
  return rt?.client?.router ?? emptyRouter();
}

function ready(): boolean {
  return !!rt?.client?.ready;
}

function short(s: string | undefined, n: number): string {
  const chars = [...(s ?? '')];
  return chars.length > n ? chars.slice(0, n).join('') : chars.join('');
}

function srcPaging(inputs: number): { perPage: number; pages: number } {
  const perPage = inputs > 10 ? 9 : 10;
  return { perPage, pages: Math.max(1, Math.ceil(inputs / perPage)) };
}

// ---- connection --------------------------------------------------------------------------------

/** (Re)connects to the configured router. Only listens: the router sends its state by itself. */
function connect(ctx: C, force = false): void {
  if (!rt) return;
  const { address, port } = cfg(ctx);
  const old = rt.client;
  if (old && !force && old.host === address && old.port === port) return;
  old?.removeAllListeners();
  old?.stop();
  rt.client = null;
  rt.armed = null;
  if (!address) {
    void ctx.status('disconnected', 'Set the router address in Setup');
    void draw(ctx);
    return;
  }
  const client = new VideohubClient(address, { port });
  rt.client = client;
  client.on('status', (connection, text) => {
    if (rt?.client !== client) return;
    void ctx.status(connection, text);
    void draw(ctx);
  });
  client.on('change', (r) => {
    if (rt?.client !== client) return;
    void clampSelection(ctx, r).then(() => draw(ctx));
  });
  client.start();
}

/** A different router may have fewer ports than the saved selection. */
async function clampSelection(ctx: C, r: RouterState): Promise<void> {
  const { selDest, srcPage } = ctx.state.value;
  const pages = srcPaging(r.inputs).pages;
  if ((r.outputs && selDest >= r.outputs) || srcPage >= pages) {
    await ctx.state.patch({ selDest: r.outputs && selDest >= r.outputs ? 0 : selDest, srcPage: srcPage >= pages ? 0 : srcPage });
  }
}

// ---- drawing -----------------------------------------------------------------------------------

export function snapshot(ctx: C) {
  const r = router();
  return {
    type: 'snapshot',
    connection: rt?.client?.connection ?? 'disconnected',
    statusText: rt?.client?.statusText ?? (cfg(ctx).address ? '' : 'Set the router address in Setup'),
    ready: ready(),
    router: {
      model: r.model,
      name: r.name,
      protocol: r.protocol,
      present: r.present,
      inputs: r.inputs,
      outputs: r.outputs,
      inputLabels: r.inputLabels,
      outputLabels: r.outputLabels,
      routes: r.routes,
      locks: r.locks
    },
    config: cfg(ctx),
    selDest: ctx.state.value.selDest,
    srcPage: ctx.state.value.srcPage,
    armed: rt?.armed ?? null,
    salvos: ctx.state.value.salvos,
    view: rt?.view ?? 'routes'
  };
}

function keyFaces(ctx: C): KeySetParams[] {
  const r = router();
  const { selDest, srcPage, salvos } = ctx.state.value;
  const { takeMode } = cfg(ctx);
  const armed = rt?.armed ?? null;
  const faces: KeySetParams[] = [];
  const live = ready() && r.outputs > 0;
  const { perPage, pages } = srcPaging(r.inputs);

  for (let k = 0; k < 10; k++) {
    const input = srcPage * perPage + k;
    if (live && k === KEY.PAGE && pages > 1) {
      faces.push({ index: k, label: 'MORE ▶', sublabel: `page ${srcPage + 1}/${pages}` });
    } else if (live && k < perPage && input < r.inputs) {
      const on = r.routes[selDest] === input;
      const isArmed = armed === input;
      faces.push({
        index: k,
        label: short(r.inputLabels[input], 10),
        sublabel: isArmed ? 'ARMED' : `IN ${input + 1}`,
        ...(on ? { background: ACCENT, color: ON_ACCENT } : isArmed ? { background: ARMED } : {})
      });
    } else {
      faces.push({ index: k });
    }
  }

  if (live) {
    const locked = r.locks[selDest] === 'L';
    const from = r.routes[selDest] ?? -1;
    faces.push({ index: KEY.PREV, label: '◀ DEST' });
    faces.push({
      index: KEY.DEST,
      label: short(r.outputLabels[selDest], 10),
      sublabel: locked ? 'LOCKED' : short('← ' + (from >= 0 ? r.inputLabels[from] : '?'), 12),
      background: locked ? DANGER : SELECTED
    });
    faces.push({ index: KEY.NEXT, label: 'DEST ▶' });
  } else {
    faces.push({ index: KEY.PREV }, { index: KEY.DEST, label: 'OFFLINE', sublabel: short(cfg(ctx).address || 'no address', 12), background: DANGER }, { index: KEY.NEXT });
  }

  const salvoFace = (index: number, s: Salvo | undefined): KeySetParams =>
    s && live ? { index, label: short(s.name, 10), sublabel: 'salvo · hold' } : { index };
  faces.push(salvoFace(KEY.SALVO1, salvos[0]));
  if (takeMode) {
    faces.push(
      live && armed !== null
        ? { index: KEY.SALVO2, label: 'TAKE', sublabel: short(r.inputLabels[armed], 12), background: ACCENT, color: ON_ACCENT }
        : { index: KEY.SALVO2, label: 'TAKE', sublabel: 'pick source' }
    );
  } else {
    faces.push(salvoFace(KEY.SALVO2, salvos[1]));
  }
  return faces;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  if (!clientId) await ctx.keys.setMany(keyFaces(ctx));
  await ctx.ui.send(snapshot(ctx), clientId);
}

// ---- operator actions: the only things that send commands -----------------------------------------

async function route(ctx: C, output: number, input: number): Promise<void> {
  const r = router();
  if (!ready()) return ctx.notify('Not connected to the Videohub', 'warning');
  if (r.locks[output] === 'L') return ctx.notify(`${r.outputLabels[output]} is locked by another client`, 'warning');
  try {
    await rt!.client!.route([[output, input]]);
    await ctx.log('info', `Routed ${r.inputLabels[input]} (${input + 1}) to ${r.outputLabels[output]} (${output + 1})`);
  } catch (e) {
    await ctx.notify(`Route not made: ${(e as Error).message}`, 'error');
  }
}

/** A source press: routes at once, or arms it for TAKE in take mode. */
async function pickSource(ctx: C, input: number): Promise<void> {
  if (!rt || !ready() || input < 0 || input >= router().inputs) return;
  if (cfg(ctx).takeMode) {
    rt.armed = rt.armed === input ? null : input;
    return draw(ctx);
  }
  await route(ctx, ctx.state.value.selDest, input);
}

async function take(ctx: C): Promise<void> {
  if (!rt || rt.armed === null) return;
  const input = rt.armed;
  rt.armed = null;
  await route(ctx, ctx.state.value.selDest, input);
  await draw(ctx);
}

async function recallSalvo(ctx: C, id: string): Promise<void> {
  const salvo = ctx.state.value.salvos.find((s) => s.id === id);
  if (!salvo) return;
  if (!ready()) return ctx.notify('Not connected to the Videohub', 'warning');
  const r = router();
  const fits = salvo.routes.filter(([o, i]) => o < r.outputs && i < r.inputs);
  const locked = fits.filter(([o]) => r.locks[o] === 'L');
  const pairs = fits.filter(([o]) => r.locks[o] !== 'L');
  const skipped = salvo.routes.length - pairs.length;
  if (!pairs.length) return ctx.notify(`Salvo "${salvo.name}" has nothing to route on this router`, 'warning');
  try {
    await rt!.client!.route(pairs);
    await ctx.log('info', `Recalled salvo "${salvo.name}" (${pairs.length} routes)`);
    if (skipped) {
      const why = locked.length ? `${locked.length} locked` : `${skipped} not on this router`;
      await ctx.notify(`Salvo "${salvo.name}": ${pairs.length} routed, ${skipped} skipped (${why})`, 'warning');
    } else {
      await ctx.notify(`Salvo "${salvo.name}" recalled`);
    }
  } catch (e) {
    await ctx.notify(`Salvo not recalled: ${(e as Error).message}`, 'error');
  }
}

// ---- the module's own data -------------------------------------------------------------------------

function salvoName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 32) : '';
  return s || fallback;
}

/** Captures the router's current routes as a salvo: a preset the operator asked for, not a save of device state. */
async function storeSalvo(ctx: C, name: unknown, outputs: unknown): Promise<void> {
  if (!ready()) return ctx.notify('Connect to the Videohub to store its routes', 'warning');
  const salvos = ctx.state.value.salvos;
  if (salvos.length >= MAX_SALVOS) return ctx.notify(`At most ${MAX_SALVOS} salvos`, 'warning');
  const r = router();
  const pick = Array.isArray(outputs) ? outputs.filter((o) => Number.isInteger(o) && o >= 0 && o < r.outputs) : r.routes.map((_, o) => o);
  const routes = [...new Set(pick as number[])].sort((a, b) => a - b).filter((o) => r.routes[o]! >= 0).map((o) => [o, r.routes[o]!] as [number, number]);
  if (!routes.length) return ctx.notify('Pick at least one destination', 'warning');
  let n = salvos.length + 1;
  while (salvos.some((s) => s.name === `Salvo ${n}`)) n++;
  const salvo: Salvo = { id: randomUUID().slice(0, 8), name: salvoName(name, `Salvo ${n}`), routes };
  await ctx.state.patch({ salvos: [...salvos, salvo] });
  await ctx.notify(`Stored "${salvo.name}" (${routes.length} routes)`);
  await draw(ctx);
}

async function editSalvos(ctx: C, fn: (list: Salvo[]) => Salvo[]): Promise<void> {
  await ctx.state.patch({ salvos: fn(ctx.state.value.salvos.map((s) => ({ ...s }))) });
  await draw(ctx);
}

async function selectDest(ctx: C, output: number): Promise<void> {
  const n = router().outputs;
  if (!rt || !Number.isInteger(output) || n === 0) return;
  rt.armed = null;
  await ctx.state.patch({ selDest: ((output % n) + n) % n });
  await draw(ctx);
}

async function setConfig(ctx: C, changes: Partial<Config>): Promise<void> {
  const next = { ...cfg(ctx) };
  if (changes.address !== undefined) {
    const a = String(changes.address).trim();
    if (!validAddress(a)) {
      await ctx.notify('That is not an IP address or host name', 'warning');
      return draw(ctx);
    }
    next.address = a;
  }
  if (changes.port !== undefined) {
    const p = Number(changes.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      await ctx.notify('Port must be 1 to 65535', 'warning');
      return draw(ctx);
    }
    next.port = p;
  }
  if (changes.takeMode !== undefined) next.takeMode = !!changes.takeMode;
  await ctx.setConfig(next);
  if (rt && !next.takeMode) rt.armed = null;
  connect(ctx);
  await draw(ctx);
}

export default defineModule<State, Config>({
  holdMs: HOLD_MS,

  async start(ctx) {
    rt?.client?.stop();
    rt = { client: null, armed: null, view: 'routes', ctx };
    await ctx.state.init({ selDest: 0, srcPage: 0, salvos: [] });
    await ctx.strip.set([
      { id: 'routes', label: 'Routes', icon: 'assets/routes.svg' },
      { id: 'salvos', label: 'Salvos', icon: 'assets/salvos.svg' },
      { id: 'labels', label: 'Labels', icon: 'assets/labels.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    connect(ctx); // listens only: no commands on start, whatever the reason
    await draw(ctx);
  },

  stop() {
    rt?.client?.removeAllListeners();
    rt?.client?.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const r = router();
    const { perPage, pages } = srcPaging(r.inputs);
    if (index < 10) {
      if (index === KEY.PAGE && pages > 1) {
        await ctx.state.patch({ srcPage: (ctx.state.value.srcPage + 1) % pages });
        return draw(ctx);
      }
      if (index < perPage) return pickSource(ctx, ctx.state.value.srcPage * perPage + index);
      return;
    }
    if (index === KEY.PREV) return selectDest(ctx, ctx.state.value.selDest - 1);
    if (index === KEY.NEXT) return selectDest(ctx, ctx.state.value.selDest + 1);
    if (index === KEY.SALVO2 && cfg(ctx).takeMode) return take(ctx);
  },

  async hold(ctx, index) {
    if (index === KEY.SALVO1 || (index === KEY.SALVO2 && !cfg(ctx).takeMode)) {
      const salvo = ctx.state.value.salvos[index - KEY.SALVO1];
      if (salvo) await recallSalvo(ctx, salvo.id);
    }
  },

  async strip(ctx, id) {
    if (!rt || !['routes', 'salvos', 'labels', 'setup'].includes(id)) return;
    rt.view = id as View;
    await draw(ctx);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'select-dest':
        return selectDest(ctx, Number(m.output));
      case 'src-page': {
        const page = Number(m.page);
        if (Number.isInteger(page) && page >= 0 && page < srcPaging(router().inputs).pages) await ctx.state.patch({ srcPage: page });
        return draw(ctx);
      }
      case 'pick-source':
        return pickSource(ctx, Number(m.input));
      case 'take':
        return take(ctx);
      case 'cancel':
        rt.armed = null;
        return draw(ctx);
      case 'route': {
        // From the web view, which keeps its own selection: an explicit output and input.
        const o = Number(m.output);
        const i = Number(m.input);
        const r = router();
        if (Number.isInteger(o) && Number.isInteger(i) && o >= 0 && o < r.outputs && i >= 0 && i < r.inputs) await route(ctx, o, i);
        return;
      }
      case 'view':
        if (['routes', 'salvos', 'labels', 'setup'].includes(m.view)) rt.view = m.view;
        return draw(ctx);
      case 'salvo-recall':
        return recallSalvo(ctx, String(m.id));
      case 'salvo-store':
        return storeSalvo(ctx, m.name, m.outputs);
      case 'salvo-rename':
        return editSalvos(ctx, (l) => l.map((s) => (s.id === m.id ? { ...s, name: salvoName(m.name, s.name) } : s)));
      case 'salvo-delete':
        return editSalvos(ctx, (l) => l.filter((s) => s.id !== m.id));
      case 'salvo-move': {
        const by = Number(m.by) < 0 ? -1 : 1;
        return editSalvos(ctx, (l) => {
          const i = l.findIndex((s) => s.id === m.id);
          const j = i + by;
          if (i < 0 || j < 0 || j >= l.length) return l;
          [l[i], l[j]] = [l[j]!, l[i]!];
          return l;
        });
      }
      case 'label': {
        if (!ready()) return ctx.notify('Not connected to the Videohub', 'warning');
        const kind = m.kind === 'input' ? 'input' : 'output';
        try {
          await rt.client!.setLabel(kind, Number(m.index), String(m.label ?? ''));
        } catch (e) {
          await ctx.notify(`Label not changed: ${(e as Error).message}`, 'error');
        }
        return draw(ctx); // the router's broadcast brings the new label; this puts back a refused one
      }
      case 'config':
        return setConfig(ctx, m.config ?? {});
      case 'reconnect':
        connect(ctx, true);
        return draw(ctx);
    }
  }
});
