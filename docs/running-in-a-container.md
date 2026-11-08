# Running Leoposta in a container

Leoposta ships as an OCI image that runs with `podman run` and `docker run`. It serves
the web app and the API on one port (3001).

## Download

Two ways, both built by [image.yml](../.github/workflows/image.yml) on every push to `main`:

| Source | Needs a login | Command / URL |
|--------|---------------|---------------|
| GitHub release asset (amd64) | no | <https://github.com/LeonardSchwier/leoposta/releases/download/latest-image/leoposta-image-linux-amd64.tar.gz> |
| GitHub release asset (arm64) | no | <https://github.com/LeonardSchwier/leoposta/releases/download/latest-image/leoposta-image-linux-arm64.tar.gz> |
| Registry | only if the package is private | `ghcr.io/leonardschwier/leoposta:latest` |

Version tags (`v*`) attach the same two tarballs to that tag's release and push the
version as an image tag.

## Fedora (podman)

```bash
curl -LO https://github.com/LeonardSchwier/leoposta/releases/download/latest-image/leoposta-image-linux-amd64.tar.gz
podman load -i leoposta-image-linux-amd64.tar.gz
podman run -d --name leoposta -p 127.0.0.1:3001:3001 -v leoposta-data:/data \
  ghcr.io/leonardschwier/leoposta:latest
```

Open <http://localhost:3001>, then add your mail account under Settings.

## Debian (docker or podman)

```bash
curl -LO https://github.com/LeonardSchwier/leoposta/releases/download/latest-image/leoposta-image-linux-amd64.tar.gz
docker load -i leoposta-image-linux-amd64.tar.gz      # or: podman load -i ...
docker run -d --name leoposta -p 127.0.0.1:3001:3001 -v leoposta-data:/data \
  ghcr.io/leonardschwier/leoposta:latest
```

On an arm64 machine (Raspberry Pi, Apple silicon VM) download the `arm64` tarball instead.

## Configuration

No secret is baked into the image. All settings are optional.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEOPOSTA_TOKEN` | random per start | API token. Letters, digits, `.`, `_`, `-` only. Set it to keep it stable across restarts. |
| `LEOPOSTA_IMAP_PASS`, `LEOPOSTA_SMTP_PASS` | unset | Passwords for the first account, kept out of the data volume ([README](../README.md#credentials)) |
| `ALLOWED_ORIGINS` | `http://localhost:3001,http://127.0.0.1:3001,...` | Comma-separated browser origins allowed by CORS. Set it when you open the app under another host name. |
| `PORT` | `3001` | Listening port inside the container |
| `LEOPOSTA_DATA_DIR` | `/data` | Where accounts, rules, scheduled mail and PGP keys are stored |

Example: `-e LEOPOSTA_TOKEN=change-me-to-a-long-random-string -e ALLOWED_ORIGINS=http://mail.lan:3001`.

| Item | Value |
|------|-------|
| Port | `3001/tcp` |
| Volume | `/data` (use a named volume, as above; with a bind mount on Fedora add `:Z` and make it writable for uid 1000) |
| User | `node` (uid 1000), never root |
| Healthcheck | `GET /api/health`, every 30 s |

Security note: the API token is embedded in the page the container serves, so anyone
who can open the page can use the API. Publish the port on loopback as shown, or put
it behind an authenticating proxy ([ADR 0003](adr/0003-api-token.md)).

## Build it yourself

```bash
docker build -t leoposta .        # or: podman build -t leoposta .
scripts/container-smoke.sh leoposta
```

## What was verified

See the "Verification" section below; it is updated with each change to the image.

