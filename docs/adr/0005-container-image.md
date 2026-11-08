# 5. One container image, runtime token, non-root

Status: accepted

## Context
Users want to run Leoposta with `podman run` or `docker run` without a Node toolchain.
The frontend needs the API token at build time ([ADR 0003](0003-api-token.md)), but an
image must not contain a secret.

## Decision
A multi-stage [Dockerfile](../../Dockerfile): build the frontend, install production-only
dependencies, then copy both into a small Alpine Node image pinned by version and digest.
The container runs as the unprivileged `node` user, keeps all state in the `/data` volume,
listens on port 3001 and has a healthcheck on `/api/health`. The frontend is built with a
placeholder token; [entrypoint.sh](../../container/entrypoint.sh) replaces it at start with
`LEOPOSTA_TOKEN` or a freshly generated random value. CI builds for amd64 and arm64,
smoke-tests the image ([container-smoke.sh](../../scripts/container-smoke.sh)), pushes to
ghcr.io and attaches `docker save` tarballs to a release so a plain download works.

## Consequences
- No secret in the image or its layers; the token changes per container unless set.
- The static files must be writable by the container user at start (they are).
- A read-only root filesystem needs the token supplied by other means (not supported yet).
- Image hosting on ghcr.io depends on package visibility; the release tarball does not.
