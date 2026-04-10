const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../src/data');

const {
  parseWslDistroList,
  getWslDistroList,
  getRunningWslDistroSet,
  filterWslDistrosForProcessScan,
  buildWslUncPath,
  parseWslProcessLine,
  parseWslPsSnapshotLine,
  resolveWslActiveSession,
  shortenHomePath,
} = data.__test;

test('parseWslDistroList decodes UTF-16LE output and strips BOM/nulls', () => {
  const raw = Buffer.from('\uFEFFUbuntu-24.04\r\ndocker-desktop\r\n', 'utf16le');
  assert.deepEqual(parseWslDistroList(raw), ['Ubuntu-24.04', 'docker-desktop']);
  assert.deepEqual(parseWslDistroList('\uFEFFUbuntu\0-24.04\r\ndocker\0-desktop\r\n'), ['Ubuntu-24.04', 'docker-desktop']);
});

test('getWslDistroList and getRunningWslDistroSet fail safely when WSL is unavailable', () => {
  assert.deepEqual(getWslDistroList(() => { throw new Error('ENOENT'); }), []);
  assert.equal(getRunningWslDistroSet(() => { throw new Error('disabled'); }), null);
});

test('getRunningWslDistroSet parses running distros and process scan filters to them', () => {
  const running = getRunningWslDistroSet(() => Buffer.from('\uFEFFUbuntu-24.04\r\ndebian\r\n', 'utf16le'));
  assert.deepEqual(Array.from(running).sort(), ['Ubuntu-24.04', 'debian']);
  assert.deepEqual(
    filterWslDistrosForProcessScan(['Ubuntu-24.04', 'docker-desktop', 'debian'], running),
    ['Ubuntu-24.04', 'debian']
  );
  assert.deepEqual(filterWslDistrosForProcessScan(['Ubuntu-24.04'], null), ['Ubuntu-24.04']);
});

test('buildWslUncPath and shortenHomePath normalize WSL-visible paths', () => {
  assert.equal(buildWslUncPath('Ubuntu-24.04', '/home/dius'), '\\\\wsl$\\Ubuntu-24.04\\home\\dius');
  assert.equal(buildWslUncPath('Ubuntu-24.04', '/'), '\\\\wsl$\\Ubuntu-24.04\\');
  assert.equal(buildWslUncPath('', '/home/dius'), '');
  assert.equal(buildWslUncPath('Ubuntu-24.04', 'home/dius'), '');
  assert.equal(shortenHomePath('/home/dius/projects/codedash', ['\\\\wsl$\\Ubuntu-24.04\\home\\dius']), '~/projects/codedash');
  assert.equal(shortenHomePath('\\\\wsl$\\Ubuntu-24.04\\home\\dius\\projects\\codedash', ['\\\\wsl$\\Ubuntu-24.04\\home\\dius']), '~\\projects\\codedash');
});

test('parseWslPsSnapshotLine and parseWslProcessLine normalize process data', () => {
  const snapshot = parseWslPsSnapshotLine('1190 985 0.0 1528 42 sh -c sleep 300 codex');
  assert.equal(snapshot.rawPid, 1190);
  assert.equal(snapshot.rawParentPid, 985);
  assert.equal(snapshot.rssKb, 1528);
  assert.equal(snapshot.commandLine, 'sh -c sleep 300 codex');

  const parsed = parseWslProcessLine('123\t45\t1.7\t20480\t600\t/home/dius/projects/codedash\tcodex resume 019d6dc8-03d4-72e0-8239-bda72acb65fb', 'Ubuntu-24.04');
  assert.equal(parsed.pid, 'wsl:Ubuntu-24.04:123');
  assert.equal(parsed.parentPid, 'wsl:Ubuntu-24.04:45');
  assert.equal(parsed.cwd, '/home/dius/projects/codedash');
  assert.equal(parsed.ws, 20480 * 1024);
});

test('resolveWslActiveSession uses cmdline, then cwd, then synthetic fallback', () => {
  const cmdlineProc = {
    distro: 'Ubuntu-24.04',
    rawPid: 123,
    commandLine: 'codex resume 019d6dc8-03d4-72e0-8239-bda72acb65fb',
    cwd: '/home/dius/projects/codedash',
    startedAt: '2026-04-09T10:00:00.000Z',
  };
  const sessions = [
    { id: '019d6dc8-03d4-72e0-8239-bda72acb65fb', project: '/real/from-session' },
    { id: 'cwd-session', project: '/home/dius/projects/codedash' },
  ];
  const latestByToolProject = {
    'codex|/home/dius/projects/codedash': { id: 'cwd-session' },
  };

  const fromCmdline = resolveWslActiveSession(cmdlineProc, 'codex', sessions, latestByToolProject);
  assert.equal(fromCmdline.sessionId, '019d6dc8-03d4-72e0-8239-bda72acb65fb');
  assert.equal(fromCmdline.sessionSource, 'cmdline');
  assert.equal(fromCmdline.unassociated, false);

  const fromCwd = resolveWslActiveSession({
    distro: 'Ubuntu-24.04',
    rawPid: 124,
    commandLine: 'codex',
    cwd: '/home/dius/projects/codedash',
    startedAt: '2026-04-09T10:00:00.000Z',
  }, 'codex', sessions, latestByToolProject);
  assert.equal(fromCwd.sessionId, 'cwd-session');
  assert.equal(fromCwd.sessionSource, 'cwd-match');

  const synthetic = resolveWslActiveSession({
    distro: 'Ubuntu-24.04',
    rawPid: 125,
    commandLine: 'codex',
    cwd: '/home/dius/projects/unknown',
    startedAt: '',
  }, 'codex', sessions, latestByToolProject);
  assert.equal(synthetic.sessionId, 'wsl-proc:Ubuntu-24.04:125');
  assert.equal(synthetic.sessionSource, 'wsl-proc');
  assert.equal(synthetic.unassociated, true);
});
