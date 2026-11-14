#!/usr/bin/env node
// Links the module SDK, the protocol package and the simulator from a checkout of the main
// rack-control-surface repo into node_modules/@rcs, until the SDK is published to npm.
//
//   npm run link-sdk                          ../rack-control-surface
//   npm run link-sdk -- C:\src\rack-control-surface
//   RCS_REPO=/path/to/rack-control-surface npm run link-sdk
//
// npm install runs it with --if-found, so a checkout next to this one is picked up on its own and a
// missing one is not an error. The checkout must be installed and built (npm install && npm run build
// there); this script builds it once if dist/ is missing. Re-run it after npm ci, which clears
// node_modules.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const ifFound = args.includes('--if-found');
const given = args.find((a) => !a.startsWith('--')) ?? process.env.RCS_REPO;
const repo = path.resolve(here, given ?? '../rack-control-surface');
const PACKAGES = ['protocol', 'module-sdk', 'controller', 'panel'];

function fail(message) {
  if (ifFound) {
    console.log(`link-sdk: ${message}\nlink-sdk: skipped. Run "npm run link-sdk -- <path to rack-control-surface>" to link the SDK.`);
    process.exit(0);
  }
  console.error(`link-sdk: ${message}`);
  process.exit(1);
}

const sdkPkg = path.join(repo, 'packages', 'module-sdk', 'package.json');
if (!existsSync(sdkPkg)) fail(`no rack-control-surface checkout at ${repo}`);
const sdkVersion = JSON.parse(await readFile(sdkPkg, 'utf8')).version;

if (!existsSync(path.join(repo, 'node_modules'))) fail(`${repo} is not installed: run "npm install" there first`);
if (PACKAGES.some((p) => !existsSync(path.join(repo, 'packages', p, 'dist')))) {
  console.log(`link-sdk: building ${repo}`);
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
}

const scope = path.join(here, 'node_modules', '@rcs');
await mkdir(scope, { recursive: true });
for (const name of PACKAGES) {
  const at = path.join(scope, name);
  if (await lstat(at).catch(() => null)) await rm(at, { recursive: true, force: true });
  // A junction on Windows needs no admin rights or Developer Mode.
  await symlink(path.join(repo, 'packages', name), at, process.platform === 'win32' ? 'junction' : 'dir');
}
console.log(`link-sdk: linked @rcs/{${PACKAGES.join(',')}} from ${repo} (SDK ${sdkVersion})`);
