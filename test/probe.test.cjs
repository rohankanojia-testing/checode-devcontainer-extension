const { createHash } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildInFlight,
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
    // A fingerprint the CALLER discovered is not evidence: without configPath the two sides may
    // simply have hashed different files, and a running container must not be labelled stale.
    assert.equal((await check('fp')).phase, 'ready');
    assert.equal((await check('other')).phase, 'ready');

    // With configPath recorded, staleness is provable and is reported.
    const cfgFile = path.join(dir, 'devcontainer.json');
    fs.writeFileSync(cfgFile, '{"image":"alpine"}');
    const hashOf = f => createHash('sha256').update(fs.readFileSync(f, 'utf8'), 'utf8').digest('hex');
    publish({ ...runtime, configPath: cfgFile, fingerprint: hashOf(cfgFile) });
    assert.equal((await check()).phase, 'ready');
    fs.writeFileSync(cfgFile, '{"image":"alpine:3.20"}');   // edited after the build
    assert.equal((await check()).phase, 'stale');
    fs.rmSync(cfgFile);                                      // recorded file gone -> cannot prove
    assert.equal((await check()).phase, 'ready');
    publish(runtime);
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

test('configPath in the runtime description decides staleness, not the caller discovery order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-fp-'));
  const configPath = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(configPath, '{"image":"alpine"}');
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, '{"image":"something-else"}');

  const hashOf = p => createHash('sha256').update(fs.readFileSync(p, 'utf8'), 'utf8').digest('hex');

  const runtimePath = path.join(dir, 'runtime.json');
  const write = extra => fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1, containerName: 'devcontainer', containerId: 'abc', podmanPath: '/bin/true',
    image: 'localhost/devcontainer:latest', remoteUser: 'node', workspaceFolder: '/w',
    shell: 'bash', remoteEnv: {}, ...extra,
  }));

  // the description records the file it hashed, and it still matches -> ready, even though the
  // caller passes the fingerprint of a completely different file
  write({ fingerprint: hashOf(configPath), configPath });
  assert.equal(readRuntime(runtimePath).configPath, configPath);
  assert.equal(fingerprintFromFiles([configPath]), hashOf(configPath));

  // edit the recorded file -> the recorded fingerprint no longer matches it
  fs.writeFileSync(configPath, '{"image":"alpine:3.20"}');
  assert.notEqual(fingerprintFromFiles([configPath]), hashOf(other));

  // a description without configPath is still accepted (older setup scripts)
  write({ fingerprint: 'abc' });
  assert.equal(readRuntime(runtimePath).configPath, undefined);

  // a malformed configPath invalidates the whole description rather than being ignored
  write({ fingerprint: 'abc', configPath: '' });
  assert.equal(readRuntime(runtimePath), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a build is in flight only while the PID in the lock file is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lock-'));
  try {
    const lockPath = path.join(dir, 'lock');
    assert.equal(buildInFlight(lockPath), false, 'no lock file at all');

    fs.writeFileSync(lockPath, `${process.pid}\n`);
    assert.equal(buildInFlight(lockPath), true, 'own PID is alive, trailing newline tolerated');

    // The point of storing a PID rather than relying on flock: a SIGKILLed or OOMKilled build
    // leaves the file behind and no cleanup trap ever runs. A dead PID must read as "not building",
    // otherwise the status bar spins forever with no way back.
    const dead = findDeadPid();
    fs.writeFileSync(lockPath, String(dead));
    assert.equal(buildInFlight(lockPath), false, `stale lock from dead PID ${dead}`);

    for (const junk of ['', '   ', 'not-a-number', '0', '-1', '1.5abc']) {
      fs.writeFileSync(lockPath, junk);
      assert.equal(buildInFlight(lockPath), false, `junk lock contents ${JSON.stringify(junk)}`);
    }

    fs.rmSync(lockPath);
    fs.mkdirSync(lockPath);   // a directory where the file should be: readFileSync throws EISDIR
    assert.equal(buildInFlight(lockPath), false, 'unreadable lock path');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A PID that is certainly not running, so the stale-lock branch is exercised for real. */
function findDeadPid() {
  for (let candidate = 30000; candidate < 40000; candidate++) {
    try { process.kill(candidate, 0); } catch (err) {
      if (err.code === 'ESRCH') return candidate;   // no such process
    }
  }
  throw new Error('no free PID found to use as a dead PID');
}

test('probe degrades to a phase rather than throwing when podman misbehaves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-podman-'));
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const lockPath = path.join(dir, 'lock');
    const engine = path.join(dir, 'podman');
    const runtime = { version: 1, containerName: 'devcontainer', containerId: 'id-1',
      podmanPath: engine, image: 'img:1', remoteUser: 'node', workspaceFolder: '/workspace',
      shell: 'bash', remoteEnv: {}, fingerprint: 'fp' };
    const publish = value => fs.writeFileSync(runtimePath, JSON.stringify(value));
    const script = body => fs.writeFileSync(engine, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    const check = () => probe('devcontainer', lockPath, runtimePath);
    publish(runtime);

    // Exit code 78 territory aside, any non-zero exit is just "cannot tell" -> not started.
    script('process.exit(1);');
    assert.equal((await check()).phase, 'none', 'podman exited non-zero');

    // Output that is not JSON at all must not escape as an exception.
    script('process.stdout.write("Error: no such container\\n");');
    assert.equal((await check()).phase, 'none', 'unparseable inspect output');

    // Valid JSON of an unexpected shape: an empty array has no [0].
    script('process.stdout.write("[]");');
    assert.equal((await check()).phase, 'none', 'no container in inspect output');

    script('process.stdout.write(JSON.stringify({}));');
    assert.equal((await check()).phase, 'none', 'inspect returned an object, not an array');

    // podman missing from the image entirely is the one case worth telling the user about.
    publish({ ...runtime, podmanPath: path.join(dir, 'no-such-binary') });
    assert.equal((await check()).phase, 'unavailable', 'podman binary absent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a runtime description republished mid-probe is not reported as ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-race-'));
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const lockPath = path.join(dir, 'lock');
    const engine = path.join(dir, 'podman');
    const runtime = { version: 1, containerName: 'devcontainer', containerId: 'id-1',
      podmanPath: engine, image: 'img:1', remoteUser: 'node', workspaceFolder: '/workspace',
      shell: 'bash', remoteEnv: {}, fingerprint: 'fp' };
    fs.writeFileSync(runtimePath, JSON.stringify(runtime));

    // `podman inspect` is the slow part of a probe, and a rebuild finishing during it republishes
    // runtime.json. Reporting `ready` here would hand the caller terminal arguments for a
    // container that has just been replaced, so the description is re-read and the probe restarts.
    fs.writeFileSync(engine, `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(runtimePath)},
  JSON.stringify(${JSON.stringify({ ...runtime, containerId: 'id-2', image: 'img:2' })}));
process.stdout.write(JSON.stringify([{ Id: 'id-1', State: { Running: true } }]));
`, { mode: 0o700 });

    assert.equal((await probe('devcontainer', lockPath, runtimePath)).phase, 'none');

    // Control: with no republication mid-flight, the identical inspect output is ready.
    fs.writeFileSync(runtimePath, JSON.stringify(runtime));
    fs.writeFileSync(engine, `#!${process.execPath}
process.stdout.write(JSON.stringify([{ Id: 'id-1', State: { Running: true } }]));
`, { mode: 0o700 });
    assert.equal((await probe('devcontainer', lockPath, runtimePath)).phase, 'ready');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
