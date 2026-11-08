# 2. Desktop app: Tauri shell that spawns the bundled backend

Status: accepted (release workflow exists; desktop builds are not verified in this repository's CI)

## Context
A desktop build should reuse the web app instead of reimplementing mail handling in Rust.

## Decision
`src-tauri/` is a thin Rust shell. It starts a bundled Node binary running `server/index.js`
on a free loopback port chosen at launch (`scripts/bundle-backend.sh` builds the bundle),
then points the webview at it. No well-known port is hard-coded, so it cannot collide with
other local services. The webview has a strict content security policy.

## Consequences
- The desktop app and web app share all mail logic and tests.
- The bundle is large because it ships Node and its dependencies.
- Packaging depends on the build machine's Node and libraries.
