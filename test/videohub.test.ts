import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { VideohubClient } from '../src/client.js';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { MockVideohub } from '../src/mock.js';
import { applyBlock, BlockReader, emptyRouter } from '../src/protocol.js';

let hub: MockVideohub | null = null;
let sim: TestModule<State, Config> | null = null;
let client: VideohubClient | null = null;

afterEach(async () => {
  await sim?.close();
  client?.stop();
  await hub?.close();
  sim = null;
  hub = null;
  client = null;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const LABELS = ['CAM 1', 'CAM 2', 'CAM 3', 'CAM 4', 'PTZ 1', 'PTZ 2', 'GFX', 'PLAYBACK', 'ATEM PGM', 'ATEM PVW', 'LED CTRL', 'BARS'];

async function startHub(opts: ConstructorParameters<typeof MockVideohub>[0] = {}): Promise<number> {
  hub = new MockVideohub({ inputs: 12, outputs: 12, inputLabels: LABELS, outputLabels: ['LED WALL', 'IMAG L', 'IMAG R'], ...opts });
  return hub.listen(0);
}

async function startModule(port: number, extra: { state?: State; config?: Partial<Config>; reason?: 'boot' | 'restore' | 'user' } = {}) {
  sim = await startTestModule(mod, {
    config: { address: '127.0.0.1', port, takeMode: false, ...extra.config },
    state: extra.state,
    reason: extra.reason
  });
  await until(() => sim!.status?.connection === 'connected');
  await sim.settle();
  return sim;
}

const last = () => sim!.uiMessages.at(-1)?.message;

describe('protocol', () => {
  it('splits a stream into blocks across chunk boundaries', () => {
    const r = new BlockReader();
    expect(r.push('VIDEO OUTPUT ROUTING:\r\n0 3\n1')).toEqual([]);
    expect(r.push(' 4\n\nACK\n\n')).toEqual([
      { header: 'VIDEO OUTPUT ROUTING:', lines: ['0 3', '1 4'] },
      { header: 'ACK', lines: [] }
    ]);
  });

  it('builds router state from the prelude and ignores out-of-range lines', () => {
    const s = emptyRouter();
    applyBlock(s, { header: 'VIDEOHUB DEVICE:', lines: ['Device present: true', 'Model name: Smart Videohub 12x12', 'Video inputs: 12', 'Video outputs: 12'] });
    applyBlock(s, { header: 'INPUT LABELS:', lines: ['0 Camera 1', '99 Nope'] });
    applyBlock(s, { header: 'VIDEO OUTPUT ROUTING:', lines: ['2 5', '40 1'] });
    applyBlock(s, { header: 'VIDEO OUTPUT LOCKS:', lines: ['3 L'] });
    expect(s.inputLabels[0]).toBe('Camera 1');
    expect(s.inputLabels[1]).toBe('Input 2');
    expect(s.routes[2]).toBe(5);
    expect(s.routes[0]).toBe(-1);
    expect(s.locks[3]).toBe('L');
    expect(s.routes).toHaveLength(12);
  });
});

describe('client', () => {
  it('reads the router without sending anything, and reconnects after a drop', async () => {
    const port = await startHub();
    client = new VideohubClient('127.0.0.1', { port, retryMs: 50 });
    client.start();
    await until(() => client!.ready);
    expect(client.router.inputLabels[0]).toBe('CAM 1');
    expect(client.router.routes).toEqual(hub!.routes);
    hub!.dropClients();
    await until(() => !client!.ready);
    await until(() => client!.ready);
    expect(hub!.received).toEqual([]);
  });

  it('works with firmware that sends no END PRELUDE', async () => {
    const port = await startHub({ oldFirmware: true });
    client = new VideohubClient('127.0.0.1', { port });
    client.start();
    await until(() => client!.ready, 4000);
    expect(client.router.outputs).toBe(12);
  });

  it('shows routes from the router, not from what it sent', async () => {
    const port = await startHub({ lockedOutputs: [1] });
    client = new VideohubClient('127.0.0.1', { port });
    client.start();
    await until(() => client!.ready);
    await client.route([[0, 7]]);
    await until(() => client!.router.routes[0] === 7);
    await expect(client.route([[1, 7]])).rejects.toThrow(/refused/);
    expect(client.router.routes[1]).toBe(1);
    hub!.routeFromElsewhere(2, 9);
    await until(() => client!.router.routes[2] === 9);
  });

  it('gives up on a router that stops answering', async () => {
    const port = await startHub();
    client = new VideohubClient('127.0.0.1', { port, replyMs: 200, retryMs: 50 });
    client.start();
    await until(() => client!.ready);
    hub!.silent = true;
    await expect(client.route([[0, 1]])).rejects.toThrow(/did not answer/);
  });
});

describe('module', () => {
  it('only reads from the router on start, boot and restore', async () => {
    const port = await startHub();
    const saved: State = { selDest: 2, srcPage: 0, salvos: [{ id: 'a', name: 'Show', routes: [[0, 5], [1, 6]] }] };
    for (const reason of ['user', 'boot', 'restore'] as const) {
      await startModule(port, { state: saved, reason });
      expect(sim!.keys[KEY.DEST]?.label).toBe('IMAG R');
      await sim!.close();
      sim = null;
    }
    expect(hub!.commands).toEqual([]);
    expect(hub!.routes.slice(0, 2)).toEqual([0, 1]);
  });

  it('draws sources and the selected destination on the keys', async () => {
    const port = await startHub();
    await startModule(port);
    expect(sim!.keys[0]).toMatchObject({ label: 'CAM 1', sublabel: 'IN 1', background: '#F5A524' });
    expect(sim!.keys[1]).toMatchObject({ label: 'CAM 2', sublabel: 'IN 2' });
    expect(sim!.keys[KEY.PAGE]).toMatchObject({ label: 'MORE ▶', sublabel: 'page 1/2' });
    expect(sim!.keys[KEY.DEST]).toMatchObject({ label: 'LED WALL', sublabel: '← CAM 1' });
    expect(last()).toMatchObject({ type: 'snapshot', ready: true, selDest: 0 });
  });

  it('routes the selected destination when a source key is pressed', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.press(KEY.NEXT);
    await sim!.press(4);
    await until(() => hub!.routes[1] === 4);
    expect(hub!.commands).toEqual([{ header: 'VIDEO OUTPUT ROUTING:', lines: ['1 4'] }]);
    await until(() => sim!.keys[4]?.background === '#F5A524');
    expect(sim!.keys[KEY.DEST]).toMatchObject({ label: 'IMAG L', sublabel: '← PTZ 1' });
  });

  it('pages through sources with more than ten inputs', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.press(KEY.PAGE);
    expect(sim!.keys[0]).toMatchObject({ label: 'ATEM PVW', sublabel: 'IN 10' });
    expect(sim!.keys[2]).toMatchObject({ label: 'BARS' });
    expect(sim!.keys[3]).toEqual({});
    await sim!.press(2);
    await until(() => hub!.routes[0] === 11);
  });

  it('arms a source and routes it on TAKE in take mode', async () => {
    const port = await startHub();
    await startModule(port, { config: { takeMode: true } });
    await sim!.press(3);
    expect(sim!.keys[3]?.sublabel).toBe('ARMED');
    expect(sim!.keys[KEY.SALVO2]).toMatchObject({ label: 'TAKE', sublabel: 'CAM 4' });
    expect(hub!.commands).toEqual([]);
    await sim!.press(KEY.SALVO2);
    await until(() => hub!.routes[0] === 3);
    expect(hub!.commands).toHaveLength(1);
  });

  it('does not route to an output locked by another client', async () => {
    const port = await startHub({ lockedOutputs: [0] });
    await startModule(port);
    expect(sim!.keys[KEY.DEST]?.sublabel).toBe('LOCKED');
    await sim!.press(5);
    expect(hub!.commands).toEqual([]);
    expect(sim!.notifications.at(-1)?.text).toMatch(/locked/);
  });

  it('stores a salvo from the router and recalls it in one block with a held key', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.sendUi({ type: 'salvo-store', name: 'Show', outputs: [0, 2] });
    expect(sim!.state.salvos).toEqual([{ id: expect.any(String), name: 'Show', routes: [[0, 0], [2, 2]] }]);
    expect(hub!.commands).toEqual([]);
    hub!.routeFromElsewhere(0, 8);
    hub!.routeFromElsewhere(2, 9);
    await sim!.press(KEY.SALVO1); // a tap does nothing
    expect(hub!.commands).toEqual([]);
    await sim!.press(KEY.SALVO1, { holdMs: 800 });
    await until(() => hub!.routes[0] === 0 && hub!.routes[2] === 2);
    expect(hub!.commands).toEqual([{ header: 'VIDEO OUTPUT ROUTING:', lines: ['0 0', '2 2'] }]);
  });

  it('renames a router port only when asked, from the router broadcast', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.sendUi({ type: 'label', kind: 'input', index: 0, label: 'Wide\nShot' });
    await until(() => sim!.keys[0]?.label === 'Wide Shot');
    expect(hub!.inputLabels[0]).toBe('Wide Shot');
  });

  it('checks the address and reconnects when it changes', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.sendUi({ type: 'config', config: { address: 'not an address!' } });
    expect(sim!.config.address).toBe('127.0.0.1');
    await sim!.sendUi({ type: 'config', config: { address: '' } });
    await until(() => sim!.status?.connection === 'disconnected');
    expect(sim!.keys[KEY.DEST]).toMatchObject({ label: 'OFFLINE' });
    await sim!.sendUi({ type: 'config', config: { address: '127.0.0.1' } });
    await until(() => sim!.status?.connection === 'connected');
    expect(hub!.commands).toEqual([]);
  });

  it('sends a newly connected browser the whole view', async () => {
    const port = await startHub();
    await startModule(port);
    await sim!.connectClient('web-1');
    const m = sim!.uiMessages.at(-1)!;
    expect(m.clientId).toBe('web-1');
    expect(m.message.router.inputLabels).toHaveLength(12);
  });
});
