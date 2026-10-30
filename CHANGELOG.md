# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-30

The first tagged release. Everything below describes the state of the plugin as
published; `0.1.0` and `0.1.1` existed only as commits on `main`.

### Added

- **Continuous integration** (`.github/workflows/ci.yml`). The unit suite runs on
  Ubuntu, Windows and macOS against Node 22 and 24. A separate Windows job
  compiles the wake shim with the in-box `csc.exe`, so a broken shim build shows
  up here rather than on a user's machine.
- **`CHANGELOG.md`** — this file.
- **Troubleshooting section** in both READMEs, covering the four failures people
  actually hit: missing tools, `os error 5`, a daemon that never exits, and a
  missing `csc.exe`.
- **Architecture diagram** (mermaid) showing the shim → scheduled task → daemon
  path and the idle-exit edge.
- **Verify-it-worked section** with the expected `bsk_status` payload, calling out
  that `running: false` while idle is correct rather than a fault.

### Fixed

- **`bsk_*` tools silently missing after install.** A plugin that calls
  `ctx.tools.register` must declare the service it needs:

  ```js
  export const inject = ['tools']
  ```

  Without it the host mounts the plugin before the tool registry exists,
  `ctx.tools` is `undefined`, and every registration throws inside `apply()`.
  The mount path swallows plugin errors, so the plugin still reported as loaded —
  with zero tools and no error anywhere. This was the actual cause of "installed,
  but no tools appeared".
- **Hard crash when `@deepseek-ai/schemastery` is absent.** `lib/index.js` now
  falls back to `lib/schema-fallback.js` instead of failing at module load. This
  keeps a fresh clone runnable for tests and for hosts that do not bundle the
  package.

### Changed

- Repository description and topics set on GitHub, so the project is findable.
- Both READMEs rewritten to lead with the concrete failure users hit
  (`os error 5`) rather than with the mechanism, and to state plainly what the
  plugin does *not* do.
- `npm test` now runs `node --check` on both entry files before the suite, so a
  syntax error fails fast instead of surfacing as a confusing import error.

## [0.1.1] — 2026-10-30

### Fixed

- Declared `inject = ['tools']` so tool registration actually runs.
- Added a regression test asserting `inject` includes `tools`.

## [0.1.0] — 2026-10-30

### Added

- On-demand `bsk` daemon for BrowserSkill inside DeepSeek Harness: a trigger-less
  Windows scheduled task owns the daemon, and `bsk-shim.exe` wakes it on demand.
- Lifecycle tools: `bsk_status`, `bsk_setup`, `bsk_wake`, `bsk_stop`.
- Configurable `bskPath`, `taskName`, `daemonIdle`, `sessionIdle`, `autoSetup`,
  `autoWake`, `shimPath`.
- macOS/Linux path that spawns a plain detached process (no shim, no task).

[0.2.0]: https://github.com/like999888999-ui/dsh-bsk-daemon/compare/c8ff33d...v0.2.0
[0.1.1]: https://github.com/like999888999-ui/dsh-bsk-daemon/commit/c8ff33d
[0.1.0]: https://github.com/like999888999-ui/dsh-bsk-daemon/commit/5fd0794
