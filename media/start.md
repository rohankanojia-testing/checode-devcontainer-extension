### Building the environment

`devcontainer.json` describes the toolchain this repository expects — a base image, optional
Features, and lifecycle commands.

Starting the environment builds that image with the `devcontainer` CLI and runs it as a rootless
podman container next to the editor. The editor itself stays where it is; only your terminals and
the project's tooling move inside.

The first build pulls a base image and can take several minutes. Later starts reuse the container
unless `devcontainer.json` has changed.
