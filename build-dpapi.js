'use strict';

// Build the Node-API DPAPI binding (native/dpapi, from Bedrock Panel) and copy it into shell/native
// so electron-builder includes it. Node-API keeps this binary compatible between Node and Electron ABIs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);

const root = __dirname;
const inputs = [
  path.join(root, 'native', 'dpapi', 'dpapi.cc'),
  path.join(root, 'native', 'dpapi', 'binding.gyp'),
  __filename,
];
const built = path.join(root, 'native', 'dpapi', 'build', 'Release', 'filebridge_dpapi.node');
const output = path.join(root, 'shell', 'native', 'filebridge_dpapi.node');

let stale = true;
try {
  const outputTime = fs.statSync(output).mtimeMs;
  stale = !inputs.every(input => outputTime >= fs.statSync(input).mtimeMs);
} catch (e) {}
if (!stale) { console.log('[build:dpapi] up to date'); process.exit(0); }

const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
console.log('[build:dpapi] compiling Windows DPAPI binding');
execFileSync(process.execPath, [nodeGyp, 'rebuild', '--directory', path.join(root, 'native', 'dpapi')], { stdio: 'inherit' });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(built, output);
console.log('[build:dpapi] built ' + output);
