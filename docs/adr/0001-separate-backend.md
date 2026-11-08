# 1. A Node.js backend next to a browser frontend

Status: accepted

## Context
A mail client must speak IMAP and SMTP, which browsers cannot do (no raw TCP sockets).
Credentials and PGP keys also should not live in page JavaScript.

## Decision
The frontend is a Svelte single-page app. A small Express backend (`server/`) holds the
IMAP connections, the SMTP transport and the credentials, and exposes a JSON/HTTP API.
In production the backend also serves the built `dist/`, so one port serves everything.

## Consequences
- One codebase serves the browser, the container and the desktop app.
- The backend is a trust boundary that needs authentication ([ADR 0003](0003-api-token.md)).
- A user always runs a server process, even for local use.
