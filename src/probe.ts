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
}

/** One entry of the devcontainer.metadata image label, which is an ARRAY of partial configs. */
interface MetadataEntry {
  remoteUser?: string;
  containerUser?: string;
  workspaceFolder?: string;
}

/**
 * Merge the metadata array the way the spec (and start-devcontainer.sh) does: last non-null wins.
 */
export function mergeMetadata(raw: string): MetadataEntry {
  let entries: MetadataEntry[];
  try {
    const parsed: unknown = JSON.parse(raw);
    entries = Array.isArray(parsed) ? (parsed as MetadataEntry[]) : [parsed as MetadataEntry];
  } catch {
    return {};
  }
  const last = <K extends keyof MetadataEntry>(key: K): MetadataEntry[K] => {
    let value: MetadataEntry[K] | undefined = undefined;
    for (const e of entries) {
      if (e && e[key] !== undefined && e[key] !== null) {
        value = e[key];
      }
    }
    return value;
  };
  return {
    remoteUser: last('remoteUser') ?? last('containerUser'),
    workspaceFolder: last('workspaceFolder'),
  };
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

export function podmanPath(): string {
  return process.env.ORIGINAL_PODMAN_PATH || '/usr/bin/podman.orig';
}

/**
 * Derive everything from the container itself — no cooperation from the script required.
 * `devcontainer.metadata` is written by `devcontainer build`; `che.devcontainer.config` is the
 * config fingerprint start-devcontainer.sh stamps on so staleness is detectable.
 */
export async function probe(
  containerName: string,
  lockPath: string,
  expectedFingerprint?: string
): Promise<Probe> {
  if (buildInFlight(lockPath)) {
    return { phase: 'building', containerName };
  }
  let stdout: string;
  try {
    ({ stdout } = await run(podmanPath(), ['inspect', '--format', 'json', containerName]));
  } catch (err) {
    // ENOENT means the podman binary is absent — a different situation from "no such container",
    // and one where offering to build would be pointless.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { phase: 'unavailable', containerName };
    }
    return { phase: 'none', containerName };
  }
  let inspected: Array<{
    Config?: { Labels?: Record<string, string>; Image?: string };
    Image?: string;
    State?: { Running?: boolean };
  }>;
  try {
    inspected = JSON.parse(stdout);
  } catch {
    return { phase: 'none', containerName };
  }
  const c = inspected[0];
  if (!c || c.State?.Running !== true) {
    return { phase: 'none', containerName };
  }
  const labels = c.Config?.Labels ?? {};
  const meta = mergeMetadata(labels['devcontainer.metadata'] ?? '');
  const fingerprint = labels['che.devcontainer.config'];
  const stale = expectedFingerprint !== undefined && fingerprint !== expectedFingerprint;
  return {
    phase: stale ? 'stale' : 'ready',
    containerName,
    image: c.Config?.Image ?? c.Image,
    remoteUser: meta.remoteUser,
    workspaceFolder: meta.workspaceFolder,
    fingerprint,
  };
}
