# DevContainer runtime support with podman

Builds and runs the environment declared in `devcontainer.json` as a rootless podman container
inside an Eclipse Che workspace, and opens terminals in it.

> **Proof of concept.** An experiment attached to
> [eclipse-che/che#23458](https://github.com/eclipse-che/che/issues/23458). Not supported, not
> hardened, and not affiliated with the Eclipse Foundation. It depends on unstable interfaces —
> `start-devcontainer.sh` and exact devfile task labels — and the container runs repository code
> with `--network=host`. Discussion belongs on the tracking issue.

![Dev container built and run with podman inside Eclipse Che](docs/images/demo.gif)

## How it works

`start-devcontainer.sh` in the workspace is the engine: it resolves the config, builds the image,
runs lifecycle commands and starts the container. This extension is only the UI over it — it owns
no devcontainer logic, which keeps the che-code diff small and the script independently testable.

It reads the runtime description the script publishes, verifies the container with
`podman inspect`, and renders one status bar item:

| State | Meaning |
| --- | --- |
| Not started | A configuration exists, but nothing has been built |
| Building | A build is in flight — started here, or found via the script's lock file |
| Ready | Container running and verified by ID |
| Config changed | `devcontainer.json` differs from what the running container was built from |
| Unavailable | podman is not present in this workspace |

Clicking it opens every action in one menu: **Open Terminal in Dev Container**, **Rebuild**,
**Rebuild (No Cache)**, **Show Log**. Rebuild and log run the existing devfile tasks rather than
reimplementing them. A `devcontainer` terminal profile is also registered; regular new terminals
stay in the outer workspace container.

The contract with the script — runtime JSON, lock file, config fingerprint — is documented in
[docs/script-integration.md](docs/script-integration.md). The extension cannot start a container
on its own, so review it alongside the `start-devcontainer.sh` change that publishes
`runtime.json`.

## Not implemented yet

- Installing the extensions `devcontainer.json` asks for (they surface as recommendations)
- Applying its `settings` block (currently written at machine scope, so user settings win)
- Any `devcontainer.json` parsing — deliberately left in the script

## Build

Requires Node 18 or newer. There are no runtime dependencies.

```bash
npm install
npm run compile   # tsc -p .  ->  out/extension.js
npm test          # type-check plus unit tests
npm run package   # -> devcontainer-runtime-podman-<version>.vsix
```

`vsce` compiles for you during packaging; `npm run watch` recompiles on save.

To try it: press <kbd>F5</kbd> for an Extension Development Host, or install the VSIX with
**Extensions: Install from VSIX…** and reload the window. In an Eclipse Che workspace you can
build it in place — UDI has Node.

Without a `devcontainer.json` the extension hides its status bar item, does not probe containers,
and declines its commands with an explanatory message. It discovers `.devcontainer.json`,
`.devcontainer/devcontainer.json` and `.devcontainer/*/devcontainer.json`, including files added
while the editor is open.

## Continuous integration

`.github/workflows/build.yaml` runs `npm ci`, `npm test` and `npx vsce package` on pushes to
`main`, on pull requests, and on `v*` tags, uploading the VSIX as a build artifact. A `v*` tag
also attaches it to a GitHub release.
