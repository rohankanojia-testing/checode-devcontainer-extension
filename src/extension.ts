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
import { Probe, probe, terminalArgs } from './probe';

const TASK_START = 'Start dev container';
const TASK_REBUILD = 'Rebuild dev container';
const TASK_REBUILD_NO_CACHE = 'Rebuild dev container (no cache)';
const TASK_SHOW_LOG = 'Show dev container log';

let current: Probe | undefined;
let statusBar: vscode.StatusBarItem;
let lastNotified: Probe['phase'] | undefined;

/** Build tasks this window has running. Makes `building` work without any script cooperation. */
let activeBuilds = 0;
const BUILD_TASKS = new Set([TASK_START, TASK_REBUILD, TASK_REBUILD_NO_CACHE]);

/** EX_CONFIG from start-devcontainer.sh: the environment cannot support nested containers. */
const EXIT_UNSUPPORTED_ENVIRONMENT = 78;

function render(state: Probe | undefined): void {
  if (!state) {
    // The extension only activates when devcontainer.json is present, so "not started" is the
    // honest label here — and it keeps a click target after the prompt is dismissed.
    statusBar.text = '$(vm-outline) Dev Container: not started';
    statusBar.tooltip = 'No completed setup configuration is available. Click to build the environment.';
    statusBar.command = 'che-devcontainer.actions';
    statusBar.backgroundColor = undefined;
    statusBar.show();
    return;
  }
  switch (state.phase) {
    case 'building':
      statusBar.text = '$(sync~spin) Dev Container: building';
      statusBar.tooltip = 'Building from devcontainer.json';
      statusBar.command = 'che-devcontainer.showLog';
      statusBar.backgroundColor = undefined;
      break;
    case 'ready':
      statusBar.text = `$(vm-active) Dev Container${state.image ? ': ' + shortImage(state.image) : ''}`;
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
      statusBar.backgroundColor = undefined;
      break;
    case 'stale':
      statusBar.text = '$(warning) Dev Container: config changed';
      statusBar.tooltip = 'devcontainer.json changed since this container was built. Rebuild to apply.';
      statusBar.command = 'che-devcontainer.actions';
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'unavailable':
      statusBar.text = '$(circle-slash) Dev Container: unavailable';
      statusBar.tooltip = 'podman was not found in this workspace, so the environment cannot be built.';
      statusBar.command = 'che-devcontainer.showLog';
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'none':
      statusBar.text = '$(vm-outline) Dev Container: not started';
      statusBar.tooltip = 'No completed setup configuration is available. Click to build the environment.';
      statusBar.command = 'che-devcontainer.actions';
      statusBar.backgroundColor = undefined;
      break;
  }
  statusBar.show();
}

function shortImage(image: string): string {
  const withoutRegistry = image.includes('/') ? image.slice(image.lastIndexOf('/') + 1) : image;
  return withoutRegistry.split(':')[0];
}

async function notify(state: Probe): Promise<void> {
  if (!vscode.workspace.getConfiguration('cheDevcontainer').get<boolean>('notify', true)) {
    return;
  }
  if (state.phase === lastNotified) {
    return; // only on transition
  }
  lastNotified = state.phase;

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
  const ready = current?.phase === 'ready';
  const running = current?.phase === 'ready' || current?.phase === 'building';
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
    title: `Dev Container: ${current?.phase ?? 'not started'}`,
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
      provideTerminalProfile() {
        if (!current || current.phase !== 'ready' || !current.runtime) {
          vscode.window.showWarningMessage('Dev container is not ready yet.');
          return undefined;
        }
        return new vscode.TerminalProfile({
          name: 'devcontainer',
          shellPath: current.runtime.podmanPath,
          shellArgs: terminalArgs(current.runtime),
          iconPath: new vscode.ThemeIcon('vm'),
        });
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('che-devcontainer.openTerminal', () => {
      if (!current || current.phase !== 'ready' || !current.runtime) {
        vscode.window.showWarningMessage('Dev container is not ready yet.');
        return;
      }
      vscode.window
        .createTerminal({
          name: 'devcontainer',
          shellPath: current.runtime.podmanPath,
          shellArgs: terminalArgs(current.runtime),
          iconPath: new vscode.ThemeIcon('vm'),
        })
        .show();
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
  const refresh = async (): Promise<void> => {
    const containerName = cfg().get<string>('containerName', 'devcontainer');
    let next = await probe(
      containerName,
      cfg().get<string>('lockPath', '/tmp/.devcontainer-setup.lock'),
      cfg().get<string>('runtimePath', '/tmp/che-devcontainer/runtime.json')
    );
    // A build we launched outranks whatever the container currently looks like: during a rebuild
    // the old container is still up, and reporting "ready" then would be a lie.
    if (activeBuilds > 0) {
      next = { phase: 'building', containerName };
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return;
    }
    current = next;
    void vscode.commands.executeCommand('setContext', 'cheDevcontainer.state', current.phase);
    render(current);
    void notify(current);
  };

  // A build we started (or the user started from the task list) is observable through task
  // events, so the poll is only a slow backstop for anything started elsewhere.
  context.subscriptions.push(
    vscode.tasks.onDidStartTask(e => {
      if (BUILD_TASKS.has(e.execution.task.name)) {
        activeBuilds++;
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
      if (BUILD_TASKS.has(e.execution.task.name)) {
        if (e.exitCode !== undefined && e.exitCode !== 0) {
          // 78 (EX_CONFIG) is the setup script's signal that the workspace itself cannot support
          // nested containers — an administrator problem, not a broken build. Saying so is the
          // difference between a clear answer and a day spent reading podman errors.
          const message =
            e.exitCode === EXIT_UNSUPPORTED_ENVIRONMENT
              ? 'This workspace cannot run nested containers. Container-run capabilities are not ' +
                'enabled on this cluster — an administrator must set ' +
                'devEnvironments.disableContainerRunCapabilities to false in the CheCluster CR.'
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

  const timer = setInterval(() => void refresh(), 5000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  void refresh(); // pick up a container that was already ready before the window opened

  void refresh().then(() => offerToStart(context));
}

const DISMISSED_KEY = 'cheDevcontainer.startPromptDismissed';

/**
 * The devfile has no postStart event: nothing builds the environment on its own. Ask once, rather
 * than starting a multi-minute build the user did not request.
 */
async function offerToStart(context: vscode.ExtensionContext): Promise<void> {
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

export function deactivate(): void {
  // Timers and UI registrations are disposed through context.subscriptions.
}
