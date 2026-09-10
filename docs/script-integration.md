# Script change required: one line

In `start-devcontainer.sh`, the existing lock block gains a single line so the extension can
tell whether a build is in flight — including after an OOMKill, where no cleanup trap runs.

```bash
LOCK_FILE="${LOCK_FILE:-/tmp/.devcontainer-setup.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another devcontainer setup is in progress; waiting..."
  flock -w 900 9 || { echo "timed out waiting for the in-progress setup" >&2; exit 1; }
fi
echo $$ >&9          # <-- ADD THIS: publish the holder's PID into the locked file
```

That is the entire contract. No state file, no `write_state`, nothing to keep in sync.

The path must match `cheDevcontainer.lockPath` (default `/tmp/.devcontainer-setup.lock`). Keep
`LOCK_FILE` as the override on the script side and the setting on the extension side; do not
hardcode the literal twice.
