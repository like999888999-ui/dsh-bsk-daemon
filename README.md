# dsh-bsk-daemon

English | [简体中文](README.zh-CN.md)

Make [BrowserSkill](https://github.com/Tencent/BrowserSkill)'s `bsk` daemon **start on demand and exit when idle** inside DeepSeek Harness — and fix the fact that on Windows it cannot start at all.

```sh
dsh plugin --profile desktop add github:like999888999-ui/dsh-bsk-daemon
```

## The problem

The `browser-skill` plugin drives a local `bsk` daemon. Either it stays resident (wasting memory) or `bsk` starts it on demand. The on-demand path is broken inside DSH:

```
automatic daemon startup failed: cannot start an independent Windows daemon;
the host may prohibit Job Object breakaway; ...
Access is denied. (os error 5)
```

The dsh host runs inside a Windows Job Object that forbids detached children. So the very first browser tool call fails, with no hint about how to fix it.

This plugin routes around the restriction with a **scheduled task**: tasks are spawned by `taskeng`, outside the host's Job Object, so they can break away. A tiny wake shim sits in front of `bsk`: if the daemon is down it triggers the task, waits for it to answer, then forwards the call verbatim.

Net effect: nothing resident while idle, automatic start when used, automatic exit after the idle timeout.

## Install

```sh
# 1. this plugin
dsh plugin --profile desktop add github:like999888999-ui/dsh-bsk-daemon

# 2. browser-skill, if you have not installed it yet
dsh plugin --profile desktop add @wxg-prc-cpg/browser-skill-dsh-plugin

# 3. fully quit dsh and start it again
```

The first load runs setup once (builds the shim, registers the task).

## Point browser-skill at the shim

The plugin builds `bsk-shim.exe` under `~/.local/bin/`. Tell `browser-skill` to use it instead of `bsk` — add this to the profile's `cordis.patch.yml`:

```yaml
- id: browserskill
  config:
    bskPath: 'C:\Users\<you>\.local\bin\bsk-shim.exe'
```

Restart the host. Every browser tool call now handles the daemon lifecycle transparently.

> Alternatively, leave `bskPath` alone and call this plugin's `bsk_wake` tool before a batch of browser work. Same effect, one extra step.

## Tools

| Tool | Purpose |
| :-- | :-- |
| `bsk_status` | Is the daemon running, how many browsers connected, shim and task state |
| `bsk_setup` | Rebuild the shim and re-register the task (idempotent; use after upgrading `bsk`) |
| `bsk_wake` | Start the daemon if down and wait until ready |
| `bsk_stop` | Stop now instead of waiting for the idle timeout |

## Configuration

Set in the profile's `cordis.patch.yml`, or from the settings page.

| Field | Default | Meaning |
| :-- | :-- | :-- |
| `bskPath` | empty (auto-detect) | Path to the `bsk` binary. Empty tries `~/.local/bin/bsk.exe`, `~/.cargo/bin/bsk`, then PATH |
| `taskName` | `bsk-daemon` | Scheduled task name |
| `daemonIdle` | `15m` | How long the daemon stays alive while idle |
| `sessionIdle` | `5m` | Per-session idle timeout |
| `autoSetup` | `true` | Run setup once at plugin load |
| `autoWake` | `true` | Pre-warm the daemon before a browser tool runs |
| `shimPath` | empty (`~/.local/bin/bsk-shim.exe`) | Where to build the shim |

## Platform notes

| Platform | Wake mechanism | Why |
| :-- | :-- | :-- |
| Windows | Scheduled task + shim | Job Object restriction makes a detached spawn impossible |
| macOS / Linux | Plain detached process | No restriction, no shim needed |

On non-Windows platforms the plugin only provides the status and lifecycle tools; no shim or task is created.

## Requirements

- Node.js ≥ 22.13.0
- The `bsk` CLI (see the [BrowserSkill quick start](https://github.com/Tencent/BrowserSkill#quick-start))
- On Windows, the in-box .NET Framework compiler `csc.exe` to build the shim (present on Windows 8 and later; nothing to download)

## Manual shim build (without the plugin)

```sh
git clone https://github.com/like999888999-ui/dsh-bsk-daemon
cd dsh-bsk-daemon
node lib/shim/build-shim.mjs --bsk "C:\Users\you\.local\bin\bsk.exe" --task bsk-daemon
```

Then register the task yourself, or let the plugin do it.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-bsk-daemon
schtasks /Delete /TN bsk-daemon /F
```

You can also delete `bsk-daemon-launch.vbs` and `bsk-daemon.xml` from `~/.bsk/`.

## Limitations

- **Windows-specific problem.** On macOS and Linux this mechanism is unnecessary (harmless, just unused).
- **Cold start costs ~4–8 s.** The first call after the daemon exits waits for it to come up. Subsequent calls in the same window are effectively free.
- **`csc.exe` dependency is build-time only.** Once built, the shim is a standalone exe.
- **Does not install the browser extension.** BrowserSkill's Chrome/Edge extension must be installed from the store by hand — browsers do not allow programmatic extension installs.

## License

MIT. See [LICENSE](LICENSE).
