/**
 * Platform-specific knowledge for the bsk daemon.
 *
 * The daemon cannot be started the normal way from inside a dsh plugin on
 * Windows: the host runs in a Job Object that forbids detached children, so
 * `bsk daemon start` fails with "拒绝访问 (os error 5)". The working shape is
 * a scheduled task (which CAN break away) triggered on demand.
 *
 * macOS and Linux have no such restriction, so they get the simple path.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const TASK_NAME = 'bsk-daemon'

/** Candidate locations for the bsk binary, in preference order. */
export function bskCandidates(config = {}) {
  const explicit = typeof config.bskPath === 'string' ? config.bskPath.trim() : ''
  if (explicit) return [explicit]

  const home = homedir()
  const exe = process.platform === 'win32' ? 'bsk.exe' : 'bsk'
  const out = []
  if (process.platform === 'win32') {
    // `.local/bin` is where the project's install script puts it on Windows.
    out.push(join(home, '.local', 'bin', exe))
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'Programs', 'bsk', exe))
  } else {
    out.push(join(home, '.local', 'bin', exe))
    out.push(join(home, '.cargo', 'bin', exe))
  }
  out.push(exe) // last resort: rely on PATH
  return out
}

/** First candidate that exists, or the bare name so PATH resolution can try. */
export function resolveBsk(config = {}) {
  const candidates = bskCandidates(config)
  for (const c of candidates) {
    if (c === 'bsk' || c === 'bsk.exe') continue
    if (existsSync(c)) return c
  }
  return process.platform === 'win32' ? 'bsk.exe' : 'bsk'
}

/**
 * How this platform should wake the daemon.
 *
 * - `windows-task`: a scheduled task, because a detached spawn is impossible.
 * - `detached`:     a plain detached spawn works.
 * - `none`:         cannot be automated; the user must start it themselves.
 */
export function wakeStrategy() {
  if (process.platform === 'win32') return 'windows-task'
  return 'detached'
}

/** Where the daemon's home directory lives. */
export function bskHome() {
  return process.env.BSK_HOME || join(homedir(), '.bsk')
}
