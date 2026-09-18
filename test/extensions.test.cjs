const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const INSTALL_COMMAND = 'workbench.extensions.installExtension';
const SEARCH_COMMAND = 'workbench.extensions.search';
const PODMAN = '/usr/bin/podman.orig';
const PROMPT_PREFIX = 'Dev container recommends';

// The module keeps state between activations (`current`, in particular), and node's test runner
// runs every test in this file in one process. Each harness therefore reports a container id no
// other test used, so the probe result is never equal to the one left behind by the test before.
let containers = 0;

/**
 * A vscode stub with just the surface `activate` touches, wired so a test can drive one refresh
 * and inspect what was offered. Everything a test varies — installed extensions, which commands
 * the editor contributes, what the user clicks — is a field on the returned harness.
 */
function harness(options = {}) {
  const messages = [];
  const offers = [];
  const executed = [];
  const stored = new Map();
  const disposable = { dispose() {} };
  const commands = new Map();
  let foldersChanged;
  let probeResult = { phase: 'none', containerName: 'devcontainer' };

  const state = {
    installed: new Set(options.installed ?? []),
    contributed: options.contributed ?? [INSTALL_COMMAND, SEARCH_COMMAND],
    failing: new Set(options.failing ?? []),
    notify: options.notify ?? true,
    respond: options.respond ?? (() => undefined),
    messages,
    offers,
    executed,
    stored,
  };

  class Disposable {
    constructor(dispose) { this.dispose = dispose; }
    static from(...items) { return new Disposable(() => { for (const i of items) i?.dispose?.(); }); }
  }
  const status = { text: '', show() {}, hide() {}, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeIcon: class {},
    TerminalProfile: class { constructor(o) { Object.assign(this, o); } },
    Disposable,
    extensions: {
      getExtension: id => (state.installed.has(id) ? { id } : undefined),
    },
    workspace: {
      workspaceFolders: [{ uri: 'workspace' }],
      findFiles: async () => ['config'],
      getConfiguration: () => ({
        get: (key, fallback) => (key === 'notify' ? state.notify : fallback),
      }),
      createFileSystemWatcher: () => ({ ...disposable,
        onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable }),
      onDidChangeWorkspaceFolders: cb => { foldersChanged = cb; return disposable; },
    },
    window: {
      createStatusBarItem: () => status,
      registerTerminalProfileProvider: () => disposable,
      showInformationMessage: async (message, ...choices) => {
        messages.push(message);
        // The ready notification also carries buttons; only this feature's prompt is under test.
        if (!message.startsWith(PROMPT_PREFIX)) return undefined;
        offers.push({ message, choices });
        return state.respond(message, choices);
      },
      showWarningMessage: async message => { messages.push(message); },
      showErrorMessage: async message => { messages.push(message); },
      createTerminal: options => ({ ...options, show() {}, dispose() {} }),
      onDidOpenTerminal: () => disposable,
      onDidCloseTerminal: () => disposable,
    },
    commands: {
      registerCommand: (id, cb) => { commands.set(id, cb); return disposable; },
      getCommands: async () => [...state.contributed],
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') return;
        executed.push([id, ...args]);
        if (id === INSTALL_COMMAND) {
          // The real command rejects when the gallery has no such extension.
          if (state.failing.has(args[0])) throw new Error(`not found: ${args[0]}`);
          state.installed.add(args[0]);
          return;
        }
        if (commands.has(id)) return commands.get(id)(...args);
      },
    },
    tasks: {
      fetchTasks: async () => [],
      onDidStartTask: () => disposable,
      onDidEndTask: () => disposable,
      onDidEndTaskProcess: () => disposable,
    },
  };

  const originalLoad = Module._load;
  Module._load = function(id, ...args) {
    if (id === 'vscode') return vscode;
    if (id === './probe') {
      return {
        probe: async () => probeResult,
        firstReportedCause: () => undefined,
        probeEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        terminalArgs: () => [],
      };
    }
    return originalLoad.call(this, id, ...args);
  };
  let extension;
  // Each harness supplies its own vscode stub, and the module binds to whichever one was in place
  // when it was first loaded — so it must be loaded again, not served from the require cache.
  delete require.cache[require.resolve('../out/extension')];
  try { extension = require('../out/extension'); } finally { Module._load = originalLoad; }

  const subscriptions = [];
  extension.activate({ subscriptions, workspaceState: {
    get: key => stored.get(key),
    update: async (key, value) => { stored.set(key, value); },
  } });

  state.dispose = () => { for (const s of subscriptions) s.dispose(); };
  state.flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  /** Report a running container asking for `extensions`, and let one refresh observe it. */
  state.ready = async (extensions, revision = 0) => {
    probeResult = {
      phase: 'ready',
      containerName: 'devcontainer',
      runtime: {
        podmanPath: PODMAN, containerName: 'devcontainer', containerId: `id-${++containers}-${revision}`,
        image: 'img', workspaceFolder: '/workspace', shell: 'bash', remoteUser: 'node',
        remoteEnv: {}, fingerprint: 'f', extensions,
      },
    };
    foldersChanged();
    await state.flush();
  };
  /** A poll that sees exactly what the previous one saw, minus the probe-equality short circuit. */
  state.poll = async () => {
    const runtime = probeResult.runtime;
    probeResult = { phase: 'stale', containerName: 'devcontainer', expected: 'x', runtime };
    foldersChanged();
    await state.flush();
    probeResult = { phase: 'ready', containerName: 'devcontainer', runtime };
    foldersChanged();
    await state.flush();
  };
  state.recommendations = () => messages.filter(m => m.startsWith(PROMPT_PREFIX));
  return state;
}

test('extensions the dev container asks for are recommended, not installed behind the user', async () => {
  const h = harness({
    installed: ['dbaeumer.vscode-eslint'],
    respond: () => 'Install',
  });
  try {
    await h.ready(['dbaeumer.vscode-eslint', 'streetsidesoftware.code-spell-checker', 'ms-azuretools.vscode-docker']);

    // Already-installed ids are filtered out: nothing is gained by naming them, and a prompt that
    // lists what the user already has reads as noise.
    assert.equal(h.recommendations().length, 1);
    assert.match(h.recommendations()[0], /recommends 2 extensions: streetsidesoftware\.code-spell-checker, ms-azuretools\.vscode-docker/);
    assert.deepEqual(h.offers[0].choices, ['Install', 'Show', "Don't ask again"]);

    // Install goes through the editor's own command, one id at a time.
    assert.deepEqual(
      h.executed.filter(([id]) => id === INSTALL_COMMAND),
      [[INSTALL_COMMAND, 'streetsidesoftware.code-spell-checker'], [INSTALL_COMMAND, 'ms-azuretools.vscode-docker']]
    );
    assert.ok(h.messages.includes('Installed 2 extensions.'));

    // Nothing is missing any more, so a later poll says nothing.
    await h.poll();
    assert.equal(h.recommendations().length, 1);
  } finally { h.dispose(); }
});

test('an extension missing from the registry is named, and does not start a prompt loop', async () => {
  const h = harness({
    failing: ['ms-vscode.cpptools'],
    respond: () => 'Install',
  });
  try {
    await h.ready(['ms-vscode.cpptools', 'twxs.cmake']);
    assert.equal(h.recommendations().length, 1);

    // Open VSX carries cmake but not cpptools. Saying "not available in this editor's registry"
    // turns a silent no-op into a fact the user can act on.
    const failure = h.messages.find(m => m.startsWith('Installed 1 of 2'));
    assert.equal(failure, "Installed 1 of 2. Not available in this editor's registry: ms-vscode.cpptools.");

    // cpptools is still missing. Keyed on the list rather than on ids, the next poll would see a
    // one-item list, call it new, and ask again — every five seconds, forever.
    await h.poll();
    await h.poll();
    assert.equal(h.recommendations().length, 1, 'an extension that cannot be installed is asked about once');
  } finally { h.dispose(); }
});

test('a rebuild that adds an extension is worth a new prompt', async () => {
  const h = harness({ respond: () => undefined });
  try {
    await h.ready(['twxs.cmake']);
    assert.equal(h.recommendations().length, 1);
    await h.poll();
    assert.equal(h.recommendations().length, 1, 'the same list again is not news');

    await h.ready(['twxs.cmake', 'dbaeumer.vscode-eslint'], 1);
    assert.equal(h.recommendations().length, 2);
    assert.match(h.recommendations()[1], /recommends 2 extensions: twxs\.cmake, dbaeumer\.vscode-eslint/);
  } finally { h.dispose(); }
});

test('without an install command the editor can only be pointed at the extensions view', async () => {
  const h = harness({ contributed: [SEARCH_COMMAND], respond: () => 'Show' });
  try {
    await h.ready(['twxs.cmake', 'dbaeumer.vscode-eslint']);

    // che-code is a fork; a button that does nothing when pressed is worse than no button.
    assert.deepEqual(h.offers[0].choices, ['Show', "Don't ask again"]);
    assert.deepEqual(
      h.executed.filter(([id]) => id === SEARCH_COMMAND),
      [[SEARCH_COMMAND, '@id:twxs.cmake @id:dbaeumer.vscode-eslint']]
    );
    assert.equal(h.executed.filter(([id]) => id === INSTALL_COMMAND).length, 0);
  } finally { h.dispose(); }
});

test('with neither command the ids are still reported, in plain text', async () => {
  const h = harness({ contributed: [], respond: () => 'Show' });
  try {
    await h.ready(['twxs.cmake']);
    assert.ok(h.messages.includes('Recommended extensions: twxs.cmake'));
  } finally { h.dispose(); }
});

test("\"Don't ask again\" is remembered for the workspace", async () => {
  const h = harness({ respond: () => "Don't ask again" });
  try {
    await h.ready(['twxs.cmake']);
    assert.equal(h.recommendations().length, 1);
    assert.equal(h.stored.get('cheDevcontainer.extensionsPromptDismissed'), true);
    assert.equal(h.executed.filter(([id]) => id === INSTALL_COMMAND).length, 0);

    // A different set of extensions, which would otherwise be news, stays quiet.
    await h.ready(['twxs.cmake', 'dbaeumer.vscode-eslint'], 1);
    assert.equal(h.recommendations().length, 1);
  } finally { h.dispose(); }
});

test('the notify setting governs this prompt too, and a container asking for nothing is silent', async () => {
  const quiet = harness({ notify: false, respond: () => 'Install' });
  try {
    await quiet.ready(['twxs.cmake']);
    assert.deepEqual(quiet.recommendations(), []);
  } finally { quiet.dispose(); }

  const empty = harness({ respond: () => 'Install' });
  try {
    await empty.ready([]);
    await empty.ready(undefined, 1); // an older setup script publishes no `extensions` at all
    assert.deepEqual(empty.recommendations(), []);
  } finally { empty.dispose(); }
});
