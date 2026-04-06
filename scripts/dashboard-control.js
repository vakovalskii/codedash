#!/usr/bin/env node

const net = require('net');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const DEFAULT_PORT = 3847;

const args = process.argv.slice(2);
const command = args[0] || 'help';
const port = parsePort(args) || DEFAULT_PORT;
const openBrowser = args.includes('--open');

function parsePort(argv) {
  const portArg = argv.find(arg => arg.startsWith('--port='));
  if (!portArg) return null;
  const value = parseInt(portArg.split('=')[1], 10);
  return Number.isFinite(value) ? value : null;
}

function isPortListening(portToCheck) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: portToCheck });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const onFail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('timeout', onFail);
    socket.once('error', onFail);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCliSync(cliArgs, inheritOutput = true) {
  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: repoRoot,
    stdio: inheritOutput ? 'inherit' : 'ignore',
    windowsHide: true
  });
  if (typeof result.status === 'number') return result.status;
  return result.error ? 1 : 0;
}

function openDashboard(portToOpen) {
  const url = `http://localhost:${portToOpen}`;
  if (process.platform === 'win32') {
    execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', [url], { windowsHide: true });
    return;
  }
  execFile('xdg-open', [url], { windowsHide: true });
}

async function startBackground({ port: portToStart, open }) {
  if (await isPortListening(portToStart)) {
    console.log(`codedash already running on http://localhost:${portToStart}`);
    if (open) openDashboard(portToStart);
    return 0;
  }

  const child = spawn(process.execPath, [cliPath, 'run', `--port=${portToStart}`, '--no-browser'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(250);
    if (await isPortListening(portToStart)) {
      console.log(`codedash started in background: http://localhost:${portToStart}`);
      if (open) openDashboard(portToStart);
      return 0;
    }
  }

  console.error(`codedash did not start on port ${portToStart}`);
  return 1;
}

async function restartBackground({ port: portToRestart, open }) {
  runCliSync(['stop', `--port=${portToRestart}`]);
  await sleep(400);
  return startBackground({ port: portToRestart, open });
}

async function main() {
  switch (command) {
    case 'start-bg':
      process.exitCode = await startBackground({ port, open: openBrowser });
      return;
    case 'restart-bg':
      process.exitCode = await restartBackground({ port, open: openBrowser });
      return;
    case 'stop':
      process.exitCode = runCliSync(['stop', `--port=${port}`]);
      return;
    case 'update':
      process.exitCode = runCliSync(['update']);
      return;
    case 'version':
      process.exitCode = runCliSync(['version']);
      return;
    case 'open':
      openDashboard(port);
      console.log(`opened http://localhost:${port}`);
      return;
    case 'help':
    default:
      console.log(`Usage:
  node scripts/dashboard-control.js start-bg [--open] [--port=3847]
  node scripts/dashboard-control.js restart-bg [--open] [--port=3847]
  node scripts/dashboard-control.js stop [--port=3847]
  node scripts/dashboard-control.js update
  node scripts/dashboard-control.js version
  node scripts/dashboard-control.js open [--port=3847]`);
  }
}

main().catch(error => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
