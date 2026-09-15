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
  "fingerprint": "lowercase-hex-sha256-of-the-config-file",
  "configPath": "/projects/example/.devcontainer/devcontainer.json"
}
```

`fingerprint` is the lowercase hex SHA-256 of the UTF-8 bytes of the config file setup used.
Discovery order (first readable file wins; both sides must use the same file):

1. `.devcontainer.json` at the workspace folder root
2. `.devcontainer/devcontainer.json`
3. `.devcontainer/*/devcontainer.json` (sorted by absolute path)

In the setup script this is `sha256sum "$CONFIG_FILE" | cut -d' ' -f1` — the **raw bytes of the
config file**, not the resolved configuration from `devcontainer read-configuration`. Hashing the
resolved config instead makes every freshly built container look permanently stale.

`configPath` is the absolute path of that same file, and it is what makes staleness detectable.
The extension reports **stale** only when `configPath` is present and hashing that exact file now
gives something other than `fingerprint`. Without `configPath` a running container is reported
**ready**: a mismatch against a file the extension found on its own is not evidence the config
changed — the two sides may simply have hashed different things, and a working container must not
be labelled out of date on a guess.

So stale detection is opt-in from the setup side. Until setup publishes `configPath`, editing
`devcontainer.json` will not be flagged.

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
