const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('configuration presence gates UI, probing and explicit actions across file changes', async () => {
  let present = false;
  let probes = 0;
  let taskFetches = 0;
  let profile;
  let create;
  let remove;
  let foldersChanged;
  const commands = new Map();
  const contexts = new Map();
  const messages = [];
  const patterns = [];
  const disposable = { dispose() {} };
  const status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    RelativePattern: class { constructor(folder, pattern) { this.base = folder; this.pattern = pattern; } },
    ThemeIcon: class {},
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    workspace: {
      workspaceFolders: [{ uri: 'workspace' }],
      findFiles: async pattern => { patterns.push(pattern.pattern); return present ? ['config'] : []; },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ ...disposable,
        onDidCreate: cb => { create = cb; return disposable; },
        onDidDelete: cb => { remove = cb; return disposable; } }),
      onDidChangeWorkspaceFolders: cb => { foldersChanged = cb; return disposable; },
    },
    window: {
      createStatusBarItem: () => status,
      registerTerminalProfileProvider: (_id, provider) => { profile = provider; return disposable; },
      showInformationMessage: async message => { messages.push(message); },
      showWarningMessage: async message => { messages.push(message); },
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
      onDidStartTask: () => disposable,
      onDidEndTask: () => disposable,
      onDidEndTaskProcess: () => disposable,
    },
  };
  const originalLoad = Module._load;
  Module._load = function(id, ...args) {
    if (id === 'vscode') return vscode;
    if (id === './probe') return { probe: async () => { probes++; return { phase: 'none' }; } };
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
    assert.ok(patterns.every(p => p === '{.devcontainer.json,.devcontainer/devcontainer.json,.devcontainer/*/devcontainer.json}'));
  } finally { for (const subscription of subscriptions) subscription.dispose(); }
});
