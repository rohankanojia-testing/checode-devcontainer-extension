const { createHash } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fingerprintFromFiles,
  fingerprintOfContents,
  probeEquals,
  readRuntime,
  terminalArgs,
  probe,
} = require('../out/probe');

test('resolved terminal arguments are shared without shell interpolation', () => {
  const runtime = { remoteUser: 'node', workspaceFolder: '/workspace with spaces',
    containerName: 'custom', shell: '/bin/sh', remoteEnv: { TOKEN: 'value=$literal; echo nope\nsecond line' } };
  assert.deepEqual(terminalArgs(runtime), ['exec', '-it', '-u', 'node', '-e',
    'TOKEN=value=$literal; echo nope\nsecond line', '-w', '/workspace with spaces', 'custom', '/bin/sh']);
  assert.deepEqual(terminalArgs({ ...runtime, remoteUser: '', remoteEnv: {} }),
    ['exec', '-it', '-w', '/workspace with spaces', 'custom', '/bin/sh']);
});

test('config fingerprint is sha256 of the first readable file in discovery order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'che-fp-test-'));
  try {
    const first = path.join(dir, 'devcontainer.json');
    const second = path.join(dir, 'other.json');
    fs.writeFileSync(first, '{}\n');
    fs.writeFileSync(second, '{"name":"other"}\n');
    assert.equal(fingerprintOfContents('{}\n'), createHash('sha256').update('{}\n', 'utf8').digest('hex'));
    assert.equal(fingerprintFromFiles([first, second]), fingerprintOfContents('{}\n'));
    assert.equal(fingerprintFromFiles([path.join(dir, 'missing'), second]), fingerprintOfContents('{"name":"other"}\n'));
    assert.equal(fingerprintFromFiles([path.join(dir, 'missing')]), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('probe equality ignores object identity and remoteEnv key order', () => {
  const runtime = {
    version: 1, containerName: 'c', containerId: 'id', podmanPath: '/bin/podman',
    image: 'img', remoteUser: 'node', workspaceFolder: '/ws', shell: '/bin/sh',
    remoteEnv: { B: '2', A: '1' }, fingerprint: 'fp',
  };
  const a = { phase: 'ready', containerName: 'c', image: 'img', remoteUser: 'node',
    workspaceFolder: '/ws', fingerprint: 'fp', runtime: { ...runtime, remoteEnv: { A: '1', B: '2' } } };
  const b = { phase: 'ready', containerName: 'c', image: 'img', remoteUser: 'node',
    workspaceFolder: '/ws', fingerprint: 'fp', runtime };
  assert.equal(probeEquals(a, b), true);
  assert.equal(probeEquals(a, { ...a, phase: 'stale' }), false);
  assert.equal(probeEquals(undefined, a), false);
  assert.equal(probeEquals(a, undefined), false);
});

test('runtime description gates readiness on schema, successful publication and container identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'che-runtime-test-'));
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const lockPath = path.join(dir, 'lock');
    const engine = path.join(dir, 'podman');
    const inspected = path.join(dir, 'inspect.json');
    fs.writeFileSync(engine, `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(inspected)}));\n`, { mode: 0o700 });
    const runtime = { version: 1, containerName: 'custom', containerId: 'id-1', podmanPath: engine,
      image: 'custom:image', remoteUser: 'node', workspaceFolder: '/workspace', shell: '/bin/sh',
      remoteEnv: { A: 'quoted value' }, fingerprint: 'fp' };
    const check = (fingerprint) => probe('devcontainer', lockPath, runtimePath, fingerprint);
    const publish = value => fs.writeFileSync(runtimePath, JSON.stringify(value), { mode: 0o600 });
    assert.equal((await check()).phase, 'none');
    for (const bad of [null, {}, { ...runtime, version: 2 }, { ...runtime, shell: '' },
      { ...runtime, remoteEnv: [] }, { ...runtime, remoteEnv: { A: 4 } },
      { ...runtime, remoteEnv: { 'A=B': 'bad' } }]) {
      publish(bad); assert.equal(readRuntime(runtimePath), undefined);
    }
    publish(runtime);
    fs.writeFileSync(inspected, JSON.stringify([{ Id: 'id-1', State: { Running: true } }]));
    const ready = await check();
    assert.equal(ready.phase, 'ready');
    assert.deepEqual(ready.runtime, runtime);
    assert.equal(ready.containerName, 'custom');
    assert.equal((await check('fp')).phase, 'ready');
    assert.equal((await check('other')).phase, 'stale');
    publish({ ...runtime, podmanPath: path.join(dir, 'missing-podman') });
    assert.equal((await check()).phase, 'unavailable');
    publish(runtime);
    fs.writeFileSync(lockPath, String(process.pid));
    assert.equal((await check()).phase, 'building');
    fs.writeFileSync(lockPath, '');
    for (const container of [{ Id: 'replacement', State: { Running: true } },
      { Id: 'id-1', State: { Running: false } }]) {
      fs.writeFileSync(inspected, JSON.stringify([container]));
      assert.equal((await check()).phase, 'none');
    }
    fs.unlinkSync(runtimePath);
    assert.equal((await check()).phase, 'none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
