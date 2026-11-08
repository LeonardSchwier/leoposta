# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability"
button on the Security tab of this repository. Do not open a public issue for
a security problem. Include steps to reproduce and the affected commit.

## Scope and design

Leoposta handles three trust boundaries: HTML mail rendering, IMAP/SMTP
credentials on the backend, and the local REST API. The [README](README.md)
documents what is stored where and how the API token works, and `ROADMAP.md`
lists open `needs_validation` items.

## Dependency audit status

`npm audit` is run before each release. Runtime dependencies are clean. The
remaining findings are in build-time tooling only (`deepmerge`, `glob` and
`minimatch`, pulled in by `vite-plugin-pwa`/`workbox-build` and
`@sveltejs/vite-plugin-svelte`). They process trusted build inputs and are not
shipped in the app. They are tracked until upstream releases a fix, and
Dependabot proposes updates monthly.
