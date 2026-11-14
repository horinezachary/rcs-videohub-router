// A connection to one Videohub. It keeps itself connected and mirrors what the router reports.
//
// Connecting only listens: the router sends its prelude by itself, so nothing goes out until the
// operator routes, recalls a salvo or renames a port. The only thing sent unprompted is PING, a
// keepalive that changes nothing on the router. Routes shown are always the router's own broadcasts,
// never our guess at what a command did.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { applyBlock, BlockReader, cleanLabel, DEFAULT_PORT, emptyRouter, formatBlock, type Block, type RouterState } from './protocol.js';

export type Connection = 'connected' | 'connecting' | 'disconnected';

export interface ClientOptions {
  host: string;
  port?: number;
  /** First retry delay; doubles up to retryMaxMs. */
  retryMs?: number;
  retryMaxMs?: number;
  /** Idle time before a PING. */
  pingMs?: number;
  /** How long to wait for ACK or NAK. */
  replyMs?: number;
}

export class CommandError extends Error {}

interface Pending {
  resolve(): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export interface VideohubClient {
  on(event: 'status', fn: (connection: Connection, text: string) => void): this;
  on(event: 'change', fn: (router: RouterState) => void): this;
}

export class VideohubClient extends EventEmitter {
  router: RouterState = emptyRouter();
  connection: Connection = 'disconnected';
  statusText = '';
  /** True once the prelude is in: the router's state is complete. */
  ready = false;

  private socket: net.Socket | null = null;
  private reader = new BlockReader();
  private pending: Pending[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private preludeTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private stopped = true;
  readonly port: number;
  private readonly retryMs: number;
  private readonly retryMaxMs: number;
  private readonly pingMs: number;
  private readonly replyMs: number;

  constructor(readonly host: string, opts: Omit<ClientOptions, 'host'> = {}) {
    super();
    this.port = opts.port ?? DEFAULT_PORT;
    this.retryMs = opts.retryMs ?? 1000;
    this.retryMaxMs = opts.retryMaxMs ?? 10_000;
    this.pingMs = opts.pingMs ?? 10_000;
    this.replyMs = opts.replyMs ?? 3000;
    this.retryDelay = this.retryMs;
  }

  get address(): string {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new CommandError('Disconnected'));
    this.setStatus('disconnected', 'Stopped');
  }

  /** Routes outputs to inputs in one block, so the router takes them together. */
  route(pairs: [output: number, input: number][]): Promise<void> {
    if (!pairs.length) return Promise.resolve();
    for (const [o, i] of pairs) {
      if (!Number.isInteger(o) || o < 0 || o >= this.router.outputs) return Promise.reject(new CommandError(`No output ${o + 1}`));
      if (!Number.isInteger(i) || i < 0 || i >= this.router.inputs) return Promise.reject(new CommandError(`No input ${i + 1}`));
    }
    return this.send(formatBlock('VIDEO OUTPUT ROUTING:', pairs.map(([o, i]) => `${o} ${i}`)));
  }

  setLabel(kind: 'input' | 'output', index: number, label: string): Promise<void> {
    const count = kind === 'input' ? this.router.inputs : this.router.outputs;
    if (!Number.isInteger(index) || index < 0 || index >= count) return Promise.reject(new CommandError(`No ${kind} ${index + 1}`));
    const text = cleanLabel(label);
    if (!text) return Promise.reject(new CommandError('A label cannot be empty'));
    return this.send(formatBlock(kind === 'input' ? 'INPUT LABELS:' : 'OUTPUT LABELS:', [`${index} ${text}`]));
  }

  private send(text: string): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.ready) return Promise.reject(new CommandError('Not connected to the Videohub'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A router that stops answering is gone; reconnect rather than guess what it did.
        reject(new CommandError('The Videohub did not answer'));
        this.pending = this.pending.filter((p) => p.timer !== timer);
        socket.destroy();
      }, this.replyMs);
      this.pending.push({ resolve, reject, timer });
      socket.write(text);
      this.schedulePing();
    });
  }

  private connect(): void {
    this.router = emptyRouter();
    this.ready = false;
    this.reader = new BlockReader();
    this.setStatus('connecting', `Connecting to ${this.address}`);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setTimeout(this.replyMs * 2, () => {
      if (!this.ready) socket.destroy(new Error('no answer'));
    });
    socket.on('connect', () => {
      this.setStatus('connecting', `Reading ${this.address}`);
      // Old firmware has no END PRELUDE: take the state as complete once the dump goes quiet.
      this.preludeTimer = setTimeout(() => this.markReady(), 1500);
    });
    socket.on('data', (chunk: string) => {
      let blocks: Block[];
      try {
        blocks = this.reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const b of blocks) this.onBlock(b);
    });
    socket.on('error', (e) => {
      this.statusText = e.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const why = this.statusText;
      this.teardown(new CommandError('Lost the connection to the Videohub'));
      if (this.stopped) return;
      this.setStatus('disconnected', `${this.address}: ${friendly(why)} · retrying`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) this.connect();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
    });
  }

  private teardown(reason: Error): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.preludeTimer) clearTimeout(this.preludeTimer);
    this.pingTimer = this.preludeTimer = null;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    const s = this.socket;
    this.socket = null;
    s?.destroy();
    if (this.ready) {
      this.ready = false;
      this.emit('change', this.router);
    }
  }

  private onBlock(b: Block): void {
    if (b.header === 'ACK' || b.header === 'NAK') {
      const p = this.pending.shift();
      if (!p) return;
      clearTimeout(p.timer);
      if (b.header === 'ACK') p.resolve();
      else p.reject(new CommandError('The Videohub refused it'));
      return;
    }
    if (b.header === 'END PRELUDE:') {
      this.markReady();
      return;
    }
    const changed = applyBlock(this.router, b);
    if (b.header === 'VIDEOHUB DEVICE:' && this.ready) this.setStatus('connected', this.describe());
    if (changed && this.ready) this.emit('change', this.router);
  }

  private markReady(): void {
    if (this.ready || !this.socket) return;
    if (this.preludeTimer) clearTimeout(this.preludeTimer);
    this.preludeTimer = null;
    this.ready = true;
    this.retryDelay = this.retryMs;
    this.setStatus('connected', this.describe());
    this.emit('change', this.router);
    this.schedulePing();
  }

  private describe(): string {
    const r = this.router;
    if (r.present === 'false') return `${this.address}: no router attached`;
    if (r.present === 'needs_update') return `${this.address}: router needs a firmware update`;
    return `${r.name || r.model || 'Videohub'} · ${r.inputs}×${r.outputs} · ${this.address}`;
  }

  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      if (this.socket && this.ready) this.send(formatBlock('PING:')).catch(() => {});
    }, this.pingMs);
  }

  private setStatus(connection: Connection, text: string): void {
    if (connection === this.connection && text === this.statusText) return;
    this.connection = connection;
    this.statusText = text;
    this.emit('status', connection, text);
  }
}

function friendly(message: string): string {
  if (/ECONNREFUSED/.test(message)) return 'refused';
  if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return 'unreachable';
  if (/ETIMEDOUT|no answer/.test(message)) return 'no answer';
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return 'address not found';
  return message ? 'connection lost' : 'connection lost';
}
