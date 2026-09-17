/**********************************************************************
 * Copyright (c) 2026 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/

import * as vscode from 'vscode';
import { firstReportedCause, Probe, probe, probeEquals, RuntimeDescription, terminalArgs } from './probe';

const TASK_START = 'Start dev container';
const TASK_REBUILD = 'Rebuild dev container';
const TASK_REBUILD_NO_CACHE = 'Rebuild dev container (no cache)';
const TASK_SHOW_LOG = 'Show dev container log';

let current: Probe | undefined;
let hasConfiguration = false;

/** Discovery order must match start-devcontainer.sh and docs/script-integration.md. */
const CONFIG_FILES = ['.devcontainer.json', '.devcontainer/devcontainer.json'] as const;
const CONFIG_NAMED = '.devcontainer/*/devcontainer.json';
const CONFIG_WATCH_GLOBS = [
  '**/.devcontainer.json',
  '**/.devcontainer/devcontainer.json',
  '**/.devcontainer/*/devcontainer.json',
];

function uriFsPath(uri: vscode.Uri): string | undefined {
  return uri && typeof uri === 'object' ? uri.fsPath : undefined;
}

async function findConfigUris(): Promise<vscode.Uri[]> {
  const found: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const rel of CONFIG_FILES) {
      found.push(...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, rel), null, 1)));
    }
    const named = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, CONFIG_NAMED));
    named.sort((a, b) => (uriFsPath(a) ?? '').localeCompare(uriFsPath(b) ?? ''));
    found.push(...named);
  }
  return found;
}

async function configurationExists(): Promise<boolean> {
  return (await findConfigUris()).length > 0;
}

function watchDevcontainerFiles(onEvent: () => void): vscode.Disposable {
  return vscode.Disposable.from(
    ...CONFIG_WATCH_GLOBS.map(pattern => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      return vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(onEvent),
        watcher.onDidChange(onEvent),
        watcher.onDidDelete(onEvent)
      );
    })
  );
}

function isRunnable(state: Probe | undefined): state is Probe & { runtime: RuntimeDescription } {
  return !!state && (state.phase === 'ready' || state.phase === 'stale') && !!state.runtime;
}

async function requireConfiguration(): Promise<boolean> {
  if (await configurationExists()) return true;
  void vscode.window.showInformationMessage('No devcontainer configuration found in this workspace.');
  return false;
}

let statusBar: vscode.StatusBarItem;
let lastNotified: Probe['phase'] | undefined;
/** Config fingerprint the stale warning was last shown for, so a rebuild does not re-warn. */
let lastStaleWarning: string | undefined;

/**
 * Terminals attached to the dev container. A rebuild runs `podman rm -f`, which SIGKILLs every
 * process in the container — including the `podman exec` behind each of these — and the editor
 * then reports "terminated with exit code: 137". Closing them first makes the teardown ours
 * rather than a crash the user has to interpret.
 */
const containerTerminals = new Set<vscode.Terminal>();

/**
 * podman path from the most recent runtime description. Kept separately from `current` because a
 * terminal can be opened while the probe reports `building`, which carries no runtime at all.
 */
let lastPodmanPath: string | undefined;

function closeContainerTerminals(): void {
  for (const terminal of containerTerminals) {
    terminal.dispose();
  }
  containerTerminals.clear();
}

/** Build tasks this window has running. Makes `building` work without any script cooperation. */
let activeBuilds = 0;
const BUILD_TASKS = new Set([TASK_START, TASK_REBUILD, TASK_REBUILD_NO_CACHE]);

/** EX_CONFIG from start-devcontainer.sh: the environment cannot support nested containers. */
const EXIT_UNSUPPORTED_ENVIRONMENT = 78;

/**
 * Status bar backgrounds are restricted to these two theme colours — `extHostStatusBar.ts` keeps
 * an allow-list and silently drops anything else, so no third colour is available.
 */
const WARNING_BACKGROUND = new vscode.ThemeColor('statusBarItem.warningBackground');
const ERROR_BACKGROUND = new vscode.ThemeColor('statusBarItem.errorBackground');

/** One place for the words shown to users, so the status bar and the action menu agree. */
const PHASE_LABELS: Record<Probe['phase'], string> = {
  none: 'Not started',
  building: 'Building',
  ready: 'Ready',
  stale: 'Config changed',
  unavailable: 'Unavailable',
};

function render(state: Probe | undefined): void {
  if (!hasConfiguration) {
    statusBar.hide();
    return;
  }
  if (!state) {
    // Configuration exists, but setup has not completed.
    statusBar.text = '$(vm-outline) Dev Container: Not started';
    statusBar.tooltip = 'No completed setup configuration is available. Click to build the environment.';
    statusBar.command = 'che-devcontainer.actions';
    statusBar.backgroundColor = undefined;
    statusBar.color = undefined;
    statusBar.show();
    return;
  }
  switch (state.phase) {
    case 'building':
      statusBar.text = '$(sync~spin) Dev Container: Building';
      statusBar.tooltip = 'Building from devcontainer.json';
      statusBar.command = 'che-devcontainer.showLog';
      // Only `statusBarItem.errorBackground` and `statusBarItem.warningBackground` are honoured
      // as status bar backgrounds; warning is the yellow one.
      statusBar.backgroundColor = WARNING_BACKGROUND;
      statusBar.color = undefined;
      break;
    case 'ready':
      // The state, not the image name — the image is in the tooltip where it belongs.
      statusBar.text = '$(pass-filled) Dev Container: Ready';
      statusBar.tooltip = new vscode.MarkdownString(
        [
          `**Dev container ready**`,
          ``,
          `- container: \`${state.containerName ?? '?'}\``,
          `- image: \`${state.image ?? '?'}\``,
          `- user: \`${state.remoteUser || 'root'}\``,
        ].join('\n')
      );
      statusBar.command = 'che-devcontainer.actions';
      // Default styling: ready is the steady state, so it stays quiet. Colour is reserved for
      // states that want attention (building, config changed, unavailable).
      statusBar.backgroundColor = undefined;
      statusBar.color = undefined;
      break;
    case 'stale':
      statusBar.text = '$(warning) Dev Container: Config changed';
      statusBar.tooltip = 'devcontainer.json changed since this container was built. Rebuild to apply.';
      statusBar.command = 'che-devcontainer.actions';
      statusBar.backgroundColor = WARNING_BACKGROUND;
      statusBar.color = undefined;
      break;
    case 'unavailable':
      statusBar.text = '$(circle-slash) Dev Container: Unavailable';
      statusBar.tooltip = 'podman was not found in this workspace, so the environment cannot be built.';
      statusBar.command = 'che-devcontainer.showLog';
      statusBar.backgroundColor = ERROR_BACKGROUND;
      statusBar.color = undefined;
      break;
    case 'none':
      statusBar.text = '$(vm-outline) Dev Container: Not started';
      statusBar.tooltip = 'No completed setup configuration is available. Click to build the environment.';
      statusBar.command = 'che-devcontainer.actions';
      statusBar.backgroundColor = undefined;
      statusBar.color = undefined;
      break;
  }
  statusBar.show();
}


async function notify(state: Probe): Promise<void> {
  if (!vscode.workspace.getConfiguration('cheDevcontainer').get<boolean>('notify', true)) {
    return;
  }
  if (state.phase === 'stale') {
    // Warn once per config content. Rebuilding does not change devcontainer.json, so a rebuild
    // must not produce another warning — only a further edit should.
    //
    // This gate is deliberately separate from the phase-transition gate below. Consecutive edits
    // leave the phase at `stale` throughout, so sharing that gate would suppress every edit after
    // the first: a new fingerprint IS a new edit, whatever the previous phase was.
    if (lastStaleWarning === (state.expected ?? '')) {
      lastNotified = state.phase;
      return;
    }
    lastStaleWarning = state.expected ?? '';
    lastNotified = state.phase;
  } else {
    if (state.phase === 'ready') {
      lastStaleWarning = undefined; // a matching build re-arms the warning for the next edit
    }
    if (state.phase === lastNotified) {
      return; // only on transition
    }
    lastNotified = state.phase;
  }

  if (state.phase === 'ready') {
    const open = 'Open Terminal in Dev Container';
    const choice = await vscode.window.showInformationMessage(
      'Dev container is ready. Use Open Terminal in Dev Container to access it.',
      open
    );
    if (choice === open) {
      await vscode.commands.executeCommand('che-devcontainer.openTerminal');
    }
  } else if (state.phase === 'stale') {
    const rebuild = 'Rebuild';
    const choice = await vscode.window.showWarningMessage(
      'devcontainer.json has changed since this container was built.',
      rebuild
    );
    if (choice === rebuild) {
      await vscode.commands.executeCommand('che-devcontainer.rebuild');
    }
  }
}

/** Run one of the devfile tasks che-commands contributes, by its label. */
async function runDevfileTask(label: string): Promise<void> {
  if (!await requireConfiguration()) return;
  const tasks = await vscode.tasks.fetchTasks({ type: 'devfile' });
  const task = tasks.find(t => t.name === label);
  if (!task) {
    vscode.window.showErrorMessage(`Devfile task not found: ${label}`);
    return;
  }
  await vscode.tasks.executeTask(task);
}

interface Action extends vscode.QuickPickItem {
  command: string;
}

/** The one menu that lists every lifecycle action, so the user never has to know task names. */
async function showActions(): Promise<void> {
  if (!await requireConfiguration()) return;
  const ready = isRunnable(current);
  const running = ready || current?.phase === 'building';
  const items: Action[] = [];
  if (!running) {
    items.push({
      label: '$(play) Start Dev Container Environment',
      detail: 'Build the image from devcontainer.json and run it with podman',
      command: 'che-devcontainer.start',
    });
  }
  items.push(
    {
      label: '$(terminal) Open Terminal in Dev Container',
      detail: ready ? undefined : 'Container is not ready',
      command: 'che-devcontainer.openTerminal',
    },
    { label: '$(refresh) Rebuild Dev Container', command: 'che-devcontainer.rebuild' },
    {
      label: '$(trash) Rebuild Dev Container (No Cache)',
      detail: 'Ignores the layer cache — slower, use after base image changes',
      command: 'che-devcontainer.rebuildNoCache',
    },
    { label: '$(output) Show Dev Container Log', command: 'che-devcontainer.showLog' }
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: `Dev Container: ${PHASE_LABELS[current?.phase ?? 'none']}`,
    placeHolder: 'Select an action',
  });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('che-devcontainer.terminal', {
      async provideTerminalProfile() {
        if (!await requireConfiguration()) return undefined;
        const state = current;
        if (!isRunnable(state)) {
          vscode.window.showWarningMessage('Dev container is not ready yet.');
          return undefined;
        }
        return new vscode.TerminalProfile({
          name: 'devcontainer',
          shellPath: state.runtime.podmanPath,
          shellArgs: terminalArgs(state.runtime),
          iconPath: new vscode.ThemeIcon('vm'),
        });
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('che-devcontainer.openTerminal', async () => {
      if (!await requireConfiguration()) return;
      const state = current;
      if (!isRunnable(state)) {
        vscode.window.showWarningMessage('Dev container is not ready yet.');
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: 'devcontainer',
        shellPath: state.runtime.podmanPath,
        shellArgs: terminalArgs(state.runtime),
        iconPath: new vscode.ThemeIcon('vm'),
      });
      containerTerminals.add(terminal);
      terminal.show();
    }),
    vscode.commands.registerCommand('che-devcontainer.actions', () => showActions()),
    vscode.commands.registerCommand('che-devcontainer.start', () => runDevfileTask(TASK_START)),
    vscode.commands.registerCommand('che-devcontainer.rebuild', () => runDevfileTask(TASK_REBUILD)),
    vscode.commands.registerCommand('che-devcontainer.rebuildNoCache', () =>
      runDevfileTask(TASK_REBUILD_NO_CACHE)
    ),
    vscode.commands.registerCommand('che-devcontainer.showLog', () => runDevfileTask(TASK_SHOW_LOG))
  );

  // Setup resolves terminal configuration; the probe verifies container identity and liveness.
  const cfg = () => vscode.workspace.getConfiguration('cheDevcontainer');
  let refreshVersion = 0;
  const refresh = async (): Promise<void> => {
    const version = ++refreshVersion;
    const uris = await findConfigUris();
    if (version !== refreshVersion) return;
    const found = uris.length > 0;
    const added = found && !hasConfiguration;
    hasConfiguration = found;
    void vscode.commands.executeCommand('setContext', 'cheDevcontainer.hasConfiguration', found);
    if (!found) {
      current = undefined;
      lastNotified = undefined;
      void vscode.commands.executeCommand('setContext', 'cheDevcontainer.state', 'noConfiguration');
      render(undefined);
      return;
    }
    const containerName = cfg().get<string>('containerName', 'devcontainer');
    // No fingerprint is computed here on purpose. Staleness is decided inside the probe against
    // the file setup recorded in `configPath`; hashing the files the extension discovered would
    // be a second, unrelated opinion — and doing it on every poll read every config file from
    // disk for a value nothing consumed.
    let next = await probe(
      containerName,
      cfg().get<string>('lockPath', '/tmp/.devcontainer-setup.lock'),
      cfg().get<string>('runtimePath', '/tmp/che-devcontainer/runtime.json')
    );
    if (version !== refreshVersion) return;
    if (next.runtime?.podmanPath) lastPodmanPath = next.runtime.podmanPath;
    // A build we launched outranks whatever the container currently looks like: during a rebuild
    // the old container is still up, and reporting "ready" then would be a lie.
    if (activeBuilds > 0) {
      next = { phase: 'building', containerName };
    }
    if (probeEquals(next, current)) {
      return;
    }
    current = next;
    void vscode.commands.executeCommand('setContext', 'cheDevcontainer.state', current.phase);
    render(current);
    void notify(current);
    if (added) void offerToStart(context);
  };

  // A build we started (or the user started from the task list) is observable through task
  // events, so the poll is only a slow backstop for anything started elsewhere.
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(t => {
      // The terminal profile creates terminals we never see a handle for at creation time, so they
      // are claimed here instead. Match on the shell that was launched, not on the name: a user is
      // free to name their own terminal "devcontainer" and it must not be disposed by a rebuild.
      const options = t.creationOptions as vscode.TerminalOptions | undefined;
      if (options?.shellPath && options.shellPath === lastPodmanPath) {
        containerTerminals.add(t);
      }
    }),
    vscode.window.onDidCloseTerminal(t => containerTerminals.delete(t)),
    vscode.tasks.onDidStartTask(e => {
      if (BUILD_TASKS.has(e.execution.task.name)) {
        activeBuilds++;
        // Rebuild removes the container with `podman rm -f`; terminals attached to it would
        // otherwise die with exit code 137 and surface as an error the user must decode.
        if (e.execution.task.name !== TASK_START) closeContainerTerminals();
      }
      void refresh();
    }),
    vscode.tasks.onDidEndTask(e => {
      // `Show dev container log` is a tail -f and never ends — only count real build tasks.
      if (BUILD_TASKS.has(e.execution.task.name)) {
        activeBuilds = Math.max(0, activeBuilds - 1);
      }
      void refresh();
    }),
    vscode.tasks.onDidEndTaskProcess(e => {
      if (hasConfiguration && BUILD_TASKS.has(e.execution.task.name)) {
        if (e.exitCode !== undefined && e.exitCode !== 0 && cfg().get<boolean>('notify', true)) {
          // 78 (EX_CONFIG) is the setup script's signal that the workspace itself cannot support
          // nested containers — an administrator problem, not a broken build. Saying so is the
          // difference between a clear answer and a day spent reading podman errors.
          // Anything else: name the cause from the log if one is recognisable. Most real failures
          // are a Feature that could not install — unrelated to podman or to this extension — and
          // the line saying so is buried hundreds of lines up.
          const cause =
            e.exitCode === EXIT_UNSUPPORTED_ENVIRONMENT
              ? undefined
              : firstReportedCause(cfg().get<string>('logPath', '/tmp/devcontainer.log'));
          const message =
            e.exitCode === EXIT_UNSUPPORTED_ENVIRONMENT
              ? 'This workspace cannot run nested containers. Container-run capabilities are not ' +
                'enabled on this cluster — an administrator must set ' +
                'devEnvironments.disableContainerRunCapabilities to false in the CheCluster CR.'
              : cause
                ? `${e.execution.task.name} failed (exit ${e.exitCode}). ${cause}`
                : `${e.execution.task.name} failed (exit ${e.exitCode}).`;
          void vscode.window.showErrorMessage(message, 'Show Log').then(c => {
            if (c === 'Show Log') {
              void vscode.commands.executeCommand('che-devcontainer.showLog');
            }
          });
        }
        void refresh();
      }
    })
  );

  context.subscriptions.push(
    watchDevcontainerFiles(() => void refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh())
  );

  const timer = setInterval(() => void refresh(), 5000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  void refresh(); // also detect configuration added after the window opened
}

const DISMISSED_KEY = 'cheDevcontainer.startPromptDismissed';

/**
 * The devfile has no postStart event: nothing builds the environment on its own. Ask once, rather
 * than starting a multi-minute build the user did not request.
 */
async function offerToStart(context: vscode.ExtensionContext): Promise<void> {
  if (!hasConfiguration || !await configurationExists()) return;
  if (current && current.phase !== 'none') {
    return; // ready, stale, a build in flight, or podman unavailable
  }
  if (context.workspaceState.get<boolean>(DISMISSED_KEY)) {
    return;
  }
  const yes = 'Build it';
  const later = 'Not now';
  const never = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(
    'devcontainer.json detected in this repository. Build the dev container environment with podman?',
    yes,
    later,
    never
  );
  if (choice === yes) {
    await vscode.commands.executeCommand('che-devcontainer.start');
  } else if (choice === never) {
    await context.workspaceState.update(DISMISSED_KEY, true);
  }
}

/** Exposed for tests: render a phase and let the caller inspect the status bar item. */
export const __renderForTest = (state: Probe | undefined): void => render(state);

export function deactivate(): void {
  // Timers and UI registrations are disposed through context.subscriptions.
}
