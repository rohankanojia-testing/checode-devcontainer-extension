const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('configuration presence gates UI, probing and explicit actions across file changes', async () => {
  let present = false;
  let probes = 0;
  let taskFetches = 0;
  let profile;
  let terminalOpened, terminalClosed, taskStarted, taskEnded, taskProcessEnded;
  const PODMAN = '/usr/bin/podman.orig';
  const READY = {
    phase: 'ready',
    containerName: 'devcontainer',
    runtime: { podmanPath: PODMAN, containerName: 'devcontainer', workspaceFolder: '/workspace',
      shell: 'bash', remoteUser: 'node', remoteEnv: {} },
  };
  let probeResult = { phase: 'none' };
  const disposedTerminals = [];
  let create;
  let remove;
  let foldersChanged;
  const commands = new Map();
  const contexts = new Map();
  const messages = [];
  const patterns = [];
  const watchPatterns = [];
  const disposable = { dispose() {} };
  class Disposable {
    constructor(dispose) { this.dispose = dispose; }
    static from(...items) {
      return new Disposable(() => { for (const item of items) item?.dispose?.(); });
    }
  }
  const status = { visible: false, text: '', color: undefined, backgroundColor: undefined,
    show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    RelativePattern: class { constructor(folder, pattern) { this.base = folder; this.pattern = pattern; } },
    ThemeIcon: class {},
    Disposable,
    workspace: {
      workspaceFolders: [{ uri: 'workspace' }],
      findFiles: async pattern => { patterns.push(pattern.pattern); return present ? ['config'] : []; },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: pattern => {
        watchPatterns.push(pattern);
        return { ...disposable,
          onDidCreate: cb => { create = cb; return disposable; },
          onDidChange: () => disposable,
          onDidDelete: cb => { remove = cb; return disposable; } };
      },
      onDidChangeWorkspaceFolders: cb => { foldersChanged = cb; return disposable; },
    },
    window: {
      createStatusBarItem: () => status,
      registerTerminalProfileProvider: (_id, provider) => { profile = provider; return disposable; },
      showInformationMessage: async message => { messages.push(message); },
      showWarningMessage: async message => { messages.push(message); },
      showErrorMessage: async message => { messages.push(message); },
      createTerminal: options => ({ ...options, creationOptions: options,
        show() {}, dispose() { disposedTerminals.push(this.name); } }),
      onDidOpenTerminal: cb => { terminalOpened = cb; return disposable; },
      onDidCloseTerminal: cb => { terminalClosed = cb; return disposable; },
    },
    commands: {
      registerCommand: (id, cb) => { commands.set(id, cb); return disposable; },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') contexts.set(args[0], args[1]);
        else await commands.get(id)(...args);
      },
    },
    tasks: {
      fetchTasks: async () => { taskFetches++; return []; },
      onDidStartTask: cb => { taskStarted = cb; return disposable; },
      onDidEndTask: cb => { taskEnded = cb; return disposable; },
      onDidEndTaskProcess: cb => { taskProcessEnded = cb; return disposable; },
    },
  };
  const originalLoad = Module._load;
  Module._load = function(id, ...args) {
    if (id === 'vscode') return vscode;
    if (id === './probe') {
      return {
        probe: async () => { probes++; return probeResult; },
        probeEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        terminalArgs: () => [],
      };
    }
    return originalLoad.call(this, id, ...args);
  };
  let extension;
  try { extension = require('../out/extension'); } finally { Module._load = originalLoad; }
  const subscriptions = [];
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  try {
    extension.activate({ subscriptions, workspaceState: { get: () => false } });
    await flush();
    assert.equal(contexts.get('cheDevcontainer.state'), 'noConfiguration');
    assert.equal(contexts.get('cheDevcontainer.hasConfiguration'), false);
    assert.equal(status.visible, false);
    assert.equal(probes, 0);
    assert.deepEqual(messages, []);
    for (const command of commands.values()) await command();
    assert.equal(await profile.provideTerminalProfile(), undefined);
    assert.equal(taskFetches, 0);
    assert.ok(messages.every(m => m === 'No devcontainer configuration found in this workspace.'));
    messages.length = 0;
    present = true;
    create();
    await flush();
    assert.equal(contexts.get('cheDevcontainer.hasConfiguration'), true);
    assert.equal(status.visible, true);
    assert.equal(probes, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /devcontainer.json detected/);
    present = false;
    remove();
    await flush();
    assert.equal(contexts.get('cheDevcontainer.state'), 'noConfiguration');
    assert.equal(status.visible, false);
    assert.equal(probes, 1);
    assert.equal(messages.length, 1);
    vscode.workspace.workspaceFolders = [];
    foldersChanged();
    await flush();
    assert.equal(status.visible, false);
    const discovery = ['.devcontainer.json', '.devcontainer/devcontainer.json', '.devcontainer/*/devcontainer.json'];
    assert.ok(patterns.length > 0);
    assert.ok(patterns.every(p => discovery.includes(p)));
    assert.deepEqual([...new Set(patterns)].sort(), [...discovery].sort());
    assert.deepEqual(watchPatterns, [
      '**/.devcontainer.json',
      '**/.devcontainer/devcontainer.json',
      '**/.devcontainer/*/devcontainer.json',
    ]);

    // Bring the workspace back to a running dev container: a configuration is present again and
    // the probe reports ready, which is what the remaining assertions exercise.
    vscode.workspace.workspaceFolders = [{ uri: 'workspace' }];
    present = true;
    probeResult = READY;
    foldersChanged();
    await flush();
    messages.length = 0;

    // Consecutive edits to devcontainer.json each deserve their own warning. The phase stays
    // `stale` throughout, so a naive transition check would announce the first edit and silently
    // swallow every one after it.
    const settle = async result => { probeResult = result; foldersChanged(); await flush(); };
    const stale = expected => ({ phase: 'stale', containerName: 'devcontainer', expected, runtime: READY.runtime });
    await settle(stale('hash-one'));
    await settle(stale('hash-one'));   // a poll, not an edit: must stay quiet
    await settle(stale('hash-two'));   // a second edit: must warn again
    const warnings = messages.filter(m => /has changed since this container was built/.test(m));
    assert.equal(warnings.length, 2, 'each edit warns once, and a re-poll of the same content does not');

    // A rebuild that matches the config re-arms the warning for the next edit.
    await settle(READY);
    messages.length = 0;
    await settle(stale('hash-two'));
    assert.equal(messages.filter(m => /has changed since this container was built/.test(m)).length, 1);
    await settle(READY);
    taskEnded({ execution: { task: { name: 'Rebuild dev container' } } });

    // A rebuild runs `podman rm -f`, SIGKILLing the exec sessions behind any attached terminal.
    // The extension closes them first so the user never sees "terminated with exit code: 137".
    // Ownership is decided by the shell that was launched, not by the terminal's name.
    const open = (name, shellPath = PODMAN) => {
      const t = vscode.window.createTerminal({ name, shellPath }); terminalOpened(t); return t;
    };
    open('devcontainer');
    open('devcontainer');
    open('bash', '/bin/bash');          // not ours; must survive
    open('devcontainer', '/bin/bash');  // user's own terminal that happens to share the name
    taskStarted({ execution: { task: { name: 'Rebuild dev container' } } });
    assert.deepEqual(disposedTerminals, ['devcontainer', 'devcontainer']);

    // The first build destroys nothing, so terminals stay open.
    disposedTerminals.length = 0;
    open('devcontainer');
    taskStarted({ execution: { task: { name: 'Start dev container' } } });
    assert.deepEqual(disposedTerminals, []);

    // Status bar wording and colour per state. Only warning/error backgrounds exist, and ready
    // deliberately uses neither — colour is reserved for states that want attention.
    const render = extension.__renderForTest ?? null;
    if (render) {
      const seen = phase => { render(phase === 'none' ? undefined : { phase, containerName: 'devcontainer' });
        return { text: status.text, color: status.color?.id, background: status.backgroundColor?.id }; };
      assert.match(seen('ready').text, /Dev Container: Ready$/);
      assert.equal(seen('ready').color, undefined);      // steady state stays unstyled
      assert.equal(seen('ready').background, undefined);
      assert.match(seen('building').text, /Dev Container: Building$/);
      assert.equal(seen('building').background, 'statusBarItem.warningBackground');
      assert.match(seen('stale').text, /Dev Container: Config changed$/);
      assert.equal(seen('stale').background, 'statusBarItem.warningBackground');
      assert.equal(seen('unavailable').background, 'statusBarItem.errorBackground');
    }

    // A terminal the user closed is forgotten rather than disposed twice.
    const closed = open('devcontainer');
    terminalClosed(closed);
    taskStarted({ execution: { task: { name: 'Rebuild dev container' } } });
    assert.deepEqual(disposedTerminals, ['devcontainer']);

    // A build task this window started outranks the probe: during a rebuild the old container is
    // still up and reporting `ready` would be a lie. The counter must also come back down.
    messages.length = 0;
    probeResult = READY;
    // Earlier steps started build tasks to exercise terminal teardown and never ended them. Drain
    // the counter first; it floors at zero, so over-draining is safe.
    for (let i = 0; i < 6; i++) taskEnded({ execution: { task: { name: 'Rebuild dev container' } } });
    // The status bar was last painted directly by __renderForTest, and an unchanged probe does not
    // repaint it. Move through a different phase so the ready render below is a real one.
    await settle({ phase: 'none', containerName: 'devcontainer' });
    await settle(READY);
    assert.match(status.text, /Dev Container: Ready$/, 'no build in flight to begin with');
    taskStarted({ execution: { task: { name: 'Rebuild dev container' } } });
    await flush();
    assert.match(status.text, /Dev Container: Building$/, 'build in flight outranks a ready probe');
    taskEnded({ execution: { task: { name: 'Rebuild dev container' } } });
    await flush();
    assert.match(status.text, /Dev Container: Ready$/, 'counter decremented when the task ended');

    // `Show dev container log` is a tail -f that never ends, so it must not be counted as a build.
    taskStarted({ execution: { task: { name: 'Show dev container log' } } });
    await flush();
    assert.match(status.text, /Dev Container: Ready$/, 'the log task is not a build');
    taskEnded({ execution: { task: { name: 'Show dev container log' } } });
    await flush();

    // Exit 78 (EX_CONFIG) is the setup script saying the cluster cannot run nested containers.
    // Reporting it as a generic build failure is the difference between a clear answer and a day
    // spent reading podman errors, so the wording is asserted rather than just the presence.
    messages.length = 0;
    taskProcessEnded({ execution: { task: { name: 'Rebuild dev container' } }, exitCode: 78 });
    await flush();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /cannot run nested containers/);
    assert.match(messages[0], /disableContainerRunCapabilities/);

    // Any other non-zero exit names the task and the code, and nothing is said on success.
    messages.length = 0;
    taskProcessEnded({ execution: { task: { name: 'Rebuild dev container' } }, exitCode: 1 });
    await flush();
    assert.deepEqual(messages, ['Rebuild dev container failed (exit 1).']);
    messages.length = 0;
    taskProcessEnded({ execution: { task: { name: 'Rebuild dev container' } }, exitCode: 0 });
    taskProcessEnded({ execution: { task: { name: 'Show dev container log' } }, exitCode: 2 });
    await flush();
    assert.deepEqual(messages, [], 'success is silent, and the log task is not a build');
  } finally { for (const subscription of subscriptions) subscription.dispose(); }
});
