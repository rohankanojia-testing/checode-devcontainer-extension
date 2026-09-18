/**********************************************************************
 * Copyright (c) 2026 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { promisify } from 'util';

const run = promisify(execFile);

export type Phase = 'none' | 'building' | 'ready' | 'stale' | 'unavailable';

export interface Probe {
  phase: Phase;
  containerName: string;
  image?: string;
  remoteUser?: string;
  workspaceFolder?: string;
  /** Fingerprint the running container was built from (from the runtime description). */
  fingerprint?: string;
  /** Fingerprint of the config file as it is on disk right now. */
  expected?: string;
  runtime?: RuntimeDescription;
}

/** Published atomically by setup after successful lifecycle execution. */
export interface RuntimeDescription {
  version: 1;
  containerName: string;
  containerId: string;
  podmanPath: string;
  image: string;
  remoteUser: string;
  workspaceFolder: string;
  shell: string;
  remoteEnv: Record<string, string>;
  fingerprint: string;
  /** Absolute path of the config file setup hashed. Optional for older descriptions. */
  configPath?: string;
  /** SHA-256 of the raw bytes of `configPath`. Optional for older setup scripts. */
  configFileFingerprint?: string;
  /**
   * Extension ids from the merged `customizations.vscode.extensions`, as setup read them from
   * the built image's `devcontainer.metadata` label. The label is used rather than
   * devcontainer.json because Features contribute extensions the repository never names.
   */
  extensions?: string[];
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of the config file setup resolved. */
export function fingerprintOfContents(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/** First readable path wins, so callers must pass discovery order. */
export function fingerprintFromFiles(paths: string[]): string | undefined {
  for (const filePath of paths) {
    try {
      return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      continue;
    }
  }
  return undefined;
}

export function probeEquals(a: Probe | undefined, b: Probe | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.phase === b.phase &&
    a.containerName === b.containerName &&
    a.image === b.image &&
    a.remoteUser === b.remoteUser &&
    a.workspaceFolder === b.workspaceFolder &&
    a.fingerprint === b.fingerprint &&
    a.expected === b.expected &&
    runtimeEquals(a.runtime, b.runtime)
  );
}

function runtimeEquals(a: RuntimeDescription | undefined, b: RuntimeDescription | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.containerId === b.containerId &&
    a.containerName === b.containerName &&
    a.podmanPath === b.podmanPath &&
    a.image === b.image &&
    a.remoteUser === b.remoteUser &&
    a.workspaceFolder === b.workspaceFolder &&
    a.shell === b.shell &&
    a.fingerprint === b.fingerprint &&
    a.configPath === b.configPath &&
    a.configFileFingerprint === b.configFileFingerprint &&
    listEquals(a.extensions, b.extensions) &&
    envEquals(a.remoteEnv, b.remoteEnv)
  );
}

function listEquals(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

function envEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => a[key] === b[key]);
}

export function readRuntime(path: string): RuntimeDescription | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!value || value.version !== 1) return undefined;
    for (const key of ['containerName', 'containerId', 'podmanPath', 'image', 'workspaceFolder', 'shell', 'fingerprint']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].includes('\0')) return undefined;
    }
    if (typeof value.remoteUser !== 'string' || value.remoteUser.includes('\0')) return undefined;
    for (const key of ['configPath', 'configFileFingerprint']) {
      if (value[key] !== undefined &&
          (typeof value[key] !== 'string' || !value[key] || value[key].includes('\0'))) {
        return undefined;
      }
    }
    if (value.configPath === undefined || value.configFileFingerprint === undefined) {
      delete value.configPath;
      delete value.configFileFingerprint;
    }
    if (value.extensions !== undefined) {
      if (!Array.isArray(value.extensions)) return undefined;
      for (const id of value.extensions) {
        if (typeof id !== 'string' || !id || id.includes('\0')) return undefined;
      }
    }
    if (!value.remoteEnv || typeof value.remoteEnv !== 'object' || Array.isArray(value.remoteEnv)) return undefined;
    for (const [key, entry] of Object.entries(value.remoteEnv)) {
      if (!key || /[=\0]/.test(key) || typeof entry !== 'string' || entry.includes('\0')) return undefined;
    }
    return value as RuntimeDescription;
  } catch {
    return undefined;
  }
}

/** Keep arguments separate, including environment values containing shell syntax. */
export function terminalArgs(runtime: RuntimeDescription): string[] {
  const args = ['exec', '-it'];
  if (runtime.remoteUser) args.push('-u', runtime.remoteUser);
  for (const [key, value] of Object.entries(runtime.remoteEnv)) args.push('-e', `${key}=${value}`);
  args.push('-w', runtime.workspaceFolder, runtime.containerName, runtime.shell);
  return args;
}

/**
 * Is a build in flight? The script holds an flock on this file and writes its PID into it, so a
 * PID that is no longer alive means the file is stale — which is what makes this survive an
 * OOMKill, where no cleanup trap ever runs.
 */
export function buildInFlight(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch {
    return false;
  }
  // Digits only, deliberately not parseInt: parseInt('1.5abc') is 1, and PID 1 always exists, so
  // a truncated or corrupt lock file would report a build in flight forever with no way back.
  if (!/^[0-9]+$/.test(raw)) {
    return false;
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0); // signal 0 tests liveness without delivering anything
    return true;
  } catch {
    return false; // process gone; the file is a leftover
  }
}

/** Setup resolves terminal values; inspect verifies identity and liveness. */
export async function probe(
  containerName: string,
  lockPath: string,
  runtimePath = '/tmp/che-devcontainer/runtime.json'
): Promise<Probe> {
  if (buildInFlight(lockPath)) return { phase: 'building', containerName };
  const runtime = readRuntime(runtimePath);
  if (!runtime) return { phase: 'none', containerName };
  containerName = runtime.containerName;
  try {
    const { stdout } = await run(runtime.podmanPath, ['inspect', '--format', 'json', containerName], { timeout: 10000 });
    const inspected = JSON.parse(stdout);
    const container = Array.isArray(inspected) ? inspected[0] : undefined;
    if (!container || container.State?.Running !== true || container.Id !== runtime.containerId) {
      return { phase: 'none', containerName };
    }
    if (buildInFlight(lockPath)) return { phase: 'building', containerName };
    if (JSON.stringify(readRuntime(runtimePath)) !== JSON.stringify(runtime)) return { phase: 'none', containerName };
    // `fingerprint` hashes the resolved configuration for the script's rebuild logic.
    // Only prove staleness by comparing raw bytes of the same file setup recorded.
    // Older scripts, incomplete pairs and unreadable files cannot prove a change.
    const recorded = runtime.configPath && runtime.configFileFingerprint
      ? runtime.configFileFingerprint : undefined;
    const expected = recorded ? fingerprintFromFiles([runtime.configPath!]) : undefined;
    const provablyStale = recorded !== undefined && expected !== undefined && expected !== recorded;
    return {
      phase: provablyStale ? 'stale' : 'ready',
      containerName,
      expected,
      image: runtime.image,
      remoteUser: runtime.remoteUser,
      workspaceFolder: runtime.workspaceFolder,
      fingerprint: runtime.fingerprint,
      runtime,
    };
  } catch (err) {
    return { phase: (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unavailable' : 'none', containerName };
  }
}

/**
 * Pull the most specific cause out of a setup log, for a failure notification.
 *
 * A non-zero exit code alone sends the user to a several-hundred-line log to find one line. The
 * devcontainer CLI prints a recognisable marker when a Feature fails to install, which is the most
 * common real-world build failure and has nothing to do with this extension or with podman — so
 * naming it turns "go read the log" into a diagnosis.
 *
 * Only the tail is read: the interesting lines are at the end, and setup logs reach megabytes.
 */
export function firstReportedCause(logPath: string, tailBytes = 65536): string | undefined {
  let text: string;
  try {
    const { size } = fs.statSync(logPath);
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(tailBytes, size));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  // Scan backwards: a rebuild appends to the same log, so the last failure is the current one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const feature = /ERROR: Feature "([^"]+)"/.exec(lines[i]);
    if (feature) return `Feature "${feature[1]}" failed to install.`;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // Timestamps are prefixed by the CLI; strip one so the message reads as a sentence.
    const stripped = line.replace(/^\[[^\]]+\]\s*/, '');
    if (/^ERROR:\s/.test(stripped) || /^Error:\s/.test(stripped)) {
      return truncate(stripped);
    }
  }
  return undefined;
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
