// A pretend Videohub for development and tests: speaks the Ethernet protocol on TCP, keeps routes,
// labels and locks, answers ACK/NAK and broadcasts changes to every client like the real router.
// Run it with `npm run mock` (see mock-cli.ts), then point the module at 127.0.0.1.

import net from 'node:net';
import { BlockReader, formatBlock, type Block, type Lock } from './protocol.js';

export interface MockOptions {
  inputs?: number;
  outputs?: number;
  model?: string;
  name?: string;
  inputLabels?: string[];
  outputLabels?: string[];
  routes?: number[];
  /** Outputs locked by some other client (shown to everyone as L). */
  lockedOutputs?: number[];
  /** Leave out END PRELUDE, like firmware before protocol 2.4. */
  oldFirmware?: boolean;
  /** Stop answering commands (to test timeouts). */
  silent?: boolean;
}

export class MockVideohub {
  readonly inputs: number;
  readonly outputs: number;
  readonly model: string;
  name: string;
  inputLabels: string[];
  outputLabels: string[];
  routes: number[];
  locked: Set<number>;
  silent: boolean;
  /** Every block clients sent, for tests: proves what did (and did not) go to the router. */
  readonly received: Block[] = [];
  private readonly server: net.Server;
  private readonly clients = new Set<net.Socket>();
  private readonly oldFirmware: boolean;

  constructor(opts: MockOptions = {}) {
    this.inputs = opts.inputs ?? 20;
    this.outputs = opts.outputs ?? 20;
    this.model = opts.model ?? `Blackmagic Smart Videohub ${this.inputs} x ${this.outputs}`;
    this.name = opts.name ?? 'Mock Videohub';
    this.inputLabels = Array.from({ length: this.inputs }, (_, i) => opts.inputLabels?.[i] ?? `Input ${i + 1}`);
    this.outputLabels = Array.from({ length: this.outputs }, (_, i) => opts.outputLabels?.[i] ?? `Output ${i + 1}`);
    this.routes = Array.from({ length: this.outputs }, (_, i) => opts.routes?.[i] ?? i % this.inputs);
    this.locked = new Set(opts.lockedOutputs ?? []);
    this.oldFirmware = opts.oldFirmware ?? false;
    this.silent = opts.silent ?? false;
    this.server = net.createServer((s) => this.accept(s));
  }

  listen(port = 9990, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Drops every client, as a router reboot or a pulled cable would. */
  dropClients(): void {
    for (const c of this.clients) c.destroy();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Commands only: ACK/NAK-worthy blocks other than PING and empty dump requests. */
  get commands(): Block[] {
    return this.received.filter((b) => b.header !== 'PING:' && b.lines.length > 0);
  }

  /** A change made at the router itself (front panel, another app). */
  routeFromElsewhere(output: number, input: number): void {
    this.routes[output] = input;
    this.broadcast(formatBlock('VIDEO OUTPUT ROUTING:', [`${output} ${input}`]));
  }

  private lockFor(o: number): Lock {
    return this.locked.has(o) ? 'L' : 'U';
  }

  private accept(s: net.Socket): void {
    this.clients.add(s);
    s.setEncoding('utf8');
    s.on('close', () => this.clients.delete(s));
    s.on('error', () => {});
    const reader = new BlockReader();
    s.on('data', (chunk: string) => {
      for (const b of reader.push(chunk)) this.onBlock(s, b);
    });
    const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
    s.write(
      [
        formatBlock('PROTOCOL PREAMBLE:', ['Version: 2.8']),
        formatBlock('VIDEOHUB DEVICE:', [
          'Device present: true',
          `Model name: ${this.model}`,
          `Friendly name: ${this.name}`,
          'Unique ID: 7C2E0D0A1B2C',
          `Video inputs: ${this.inputs}`,
          'Video processing units: 0',
          `Video outputs: ${this.outputs}`,
          'Video monitoring outputs: 0',
          'Serial ports: 0'
        ]),
        formatBlock('INPUT LABELS:', range(this.inputs, (i) => `${i} ${this.inputLabels[i]}`)),
        formatBlock('OUTPUT LABELS:', range(this.outputs, (i) => `${i} ${this.outputLabels[i]}`)),
        formatBlock('VIDEO OUTPUT LOCKS:', range(this.outputs, (i) => `${i} ${this.lockFor(i)}`)),
        formatBlock('VIDEO OUTPUT ROUTING:', range(this.outputs, (i) => `${i} ${this.routes[i]}`)),
        formatBlock('CONFIGURATION:', ['Take Mode: false']),
        this.oldFirmware ? '' : formatBlock('END PRELUDE:')
      ].join('')
    );
  }

  private onBlock(s: net.Socket, b: Block): void {
    this.received.push(b);
    if (this.silent) return;
    const ack = (): void => void s.write('ACK\n\n');
    const nak = (): void => void s.write('NAK\n\n');
    const pairs = b.lines.map((l) => /^(\d+) (.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
    switch (b.header) {
      case 'PING:':
        return ack();
      case 'VIDEO OUTPUT ROUTING:': {
        if (!b.lines.length) {
          ack();
          s.write(formatBlock(b.header, this.routes.map((r, i) => `${i} ${r}`)));
          return;
        }
        const moves = pairs.map((m) => [Number(m[1]), Number(m[2])] as const);
        if (moves.length !== b.lines.length || moves.some(([o, i]) => o >= this.outputs || i >= this.inputs || !Number.isInteger(i) || this.locked.has(o))) {
          return nak();
        }
        ack();
        for (const [o, i] of moves) this.routes[o] = i;
        return this.broadcast(formatBlock(b.header, moves.map(([o, i]) => `${o} ${i}`)));
      }
      case 'INPUT LABELS:':
      case 'OUTPUT LABELS:': {
        const list = b.header === 'INPUT LABELS:' ? this.inputLabels : this.outputLabels;
        if (pairs.length !== b.lines.length || pairs.some((m) => Number(m[1]) >= list.length)) return nak();
        ack();
        for (const m of pairs) list[Number(m[1])] = m[2]!;
        return this.broadcast(formatBlock(b.header, pairs.map((m) => `${m[1]} ${m[2]}`)));
      }
      default:
        return nak();
    }
  }

  private broadcast(text: string): void {
    for (const c of this.clients) c.write(text);
  }
}
