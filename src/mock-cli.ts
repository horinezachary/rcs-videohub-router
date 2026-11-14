#!/usr/bin/env node
// npm run mock -- [--port 9990] [--inputs 20] [--outputs 20] [--locked 3,4] [--old-firmware]
// Starts a pretend Videohub with show-style labels. Point the module at 127.0.0.1 (and the port).

import { parseArgs } from 'node:util';
import { MockVideohub } from './mock.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9990' },
    host: { type: 'string', default: '127.0.0.1' },
    inputs: { type: 'string', default: '20' },
    outputs: { type: 'string', default: '20' },
    locked: { type: 'string', default: '' },
    'old-firmware': { type: 'boolean', default: false }
  }
});

const SOURCES = ['CAM 1', 'CAM 2', 'CAM 3', 'CAM 4', 'PTZ 1', 'PTZ 2', 'GFX', 'PLAYBACK', 'ATEM PGM', 'ATEM PVW', 'LED CTRL', 'BARS'];
const DESTS = ['LED WALL', 'IMAG L', 'IMAG R', 'RECORD', 'STREAM', 'CONF 1', 'CONF 2', 'MON 1', 'FOH', 'GREEN RM', 'LOBBY', 'SPARE'];

const hub = new MockVideohub({
  inputs: Number(values.inputs),
  outputs: Number(values.outputs),
  inputLabels: SOURCES,
  outputLabels: DESTS,
  lockedOutputs: values.locked ? values.locked.split(',').map((n) => Number(n) - 1) : [],
  oldFirmware: values['old-firmware']
});
const port = await hub.listen(Number(values.port), values.host);
console.log(`Mock Videohub ${hub.inputs}×${hub.outputs} on ${values.host}:${port}. Ctrl-C to stop.`);
setInterval(() => {
  const n = hub.commands.length;
  if (n !== last) console.log(`${n} command(s) received; last: ${JSON.stringify(hub.commands.at(-1))}`);
  last = n;
}, 500);
let last = 0;
