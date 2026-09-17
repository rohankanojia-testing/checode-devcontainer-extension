# Setup / extension contract

The setup script owns config resolution and container creation. The extension owns terminal UI.

After acquiring the setup lock, remove the old runtime description before running setup. Only
publish a new description after setup succeeds and the target container is running. Write JSON
to a temporary file in the same directory with mode 0600, then atomically rename it.

Default path: `/tmp/che-devcontainer/runtime.json`. The script override
`CHE_DEVCONTAINER_RUNTIME` must match the extension setting `cheDevcontainer.runtimePath`.
The parent directory is created with mode 0700. Keep the file outside the repository:
`remoteEnv` can include credentials, and its contents must not be logged.

```json
{
  "version": 1,
  "containerName": "devcontainer",
  "containerId": "full-podman-container-id",
  "podmanPath": "/usr/bin/podman.orig",
  "image": "localhost/devcontainer:latest",
  "remoteUser": "node",
  "workspaceFolder": "/workspace",
  "shell": "bash",
  "remoteEnv": {},
  "fingerprint": "lowercase-hex-sha256-of-the-resolved-configuration",
  "configPath": "/projects/example/.devcontainer/devcontainer.json",
  "configFileFingerprint": "lowercase-hex-sha256-of-the-raw-config-file"
}
```

`fingerprint` is the lowercase hex SHA-256 of the resolved configuration JSON used by
setup. It retains its existing role in setup's reuse decision and container label; the extension
does not compare it with file contents.

`configPath` is the absolute path reported by `configuration.configFilePath.fsPath` in
`devcontainer read-configuration`. If CLI resolution fails, setup uses the file its fallback
parser read. The extension does not repeat discovery.

`configFileFingerprint` is the lowercase hex SHA-256 of the **raw bytes** of `configPath`,
computed by setup with `sha256sum`. The extension compares the current bytes of that exact file
with this value. The resolved configuration and raw file usually have different hashes.

Publish `configPath` and `configFileFingerprint` together, only when both are available.
For a verified running container, a missing or incomplete pair, or an unreadable/deleted file,
means **Ready**: staleness cannot be proven. Present fields must be non-empty strings without
NUL characters; malformed fields invalidate the description and show **Not started**.
Older scripts that omit both fields remain supported.

**Config changed** tracks only the selected `devcontainer.json` (or `.devcontainer.json`).
Editing a Dockerfile or referenced compose file, or an external image/feature changing without
an edit to the config file, does not trigger this UI state. Editing a feature version inside
`devcontainer.json` does trigger it. Setup's existing resolved-config reuse check is unchanged;
this file comparison does not add dependency tracking to that check.

These are the script's resolved values, including the detected shell fallback and environment
passed to lifecycle commands. An empty remoteUser means use the container's default user.
The extension validates the description, inspects the container using its recorded engine, and
requires the same container ID and running state. Missing, malformed, or obsolete descriptions
never enable a terminal. Both the command and the contributed profile use one argument builder.
Regular editor terminals keep their existing default; setup must not set terminal profiles.

The setup parent also publishes its PID in `/tmp/.devcontainer-setup.lock` after acquiring flock.
It must not truncate the previous PID while waiting, and children must not inherit the lock fd.
Clear the PID before releasing the lock. `LOCK_FILE` must match `cheDevcontainer.lockPath`.

Upgrade both setup and extension together and rerun setup to publish the description. Older
workspaces with a script-generated default terminal profile need that old machine setting
removed (or a fresh workspace); this extension does not rewrite user terminal preferences.
