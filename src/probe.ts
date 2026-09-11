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
  fingerprint?: string;
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
}

export function readRuntime(path: string): RuntimeDescription | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!value || value.version !== 1) return undefined;
    for (const key of ['containerName', 'containerId', 'podmanPath', 'image', 'workspaceFolder', 'shell', 'fingerprint']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].includes('\0')) return undefined;
    }
    if (typeof value.remoteUser !== 'string' || value.remoteUser.includes('\0')) return undefined;
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
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
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
  runtimePath = '/tmp/che-devcontainer/runtime.json',
  expectedFingerprint?: string
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
    return {
      phase: expectedFingerprint !== undefined && runtime.fingerprint !== expectedFingerprint ? 'stale' : 'ready',
      containerName,
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
