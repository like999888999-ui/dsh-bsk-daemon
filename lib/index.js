/**
 * dsh-bsk-daemon — keep the BrowserSkill daemon available on demand.
 *
 * The problem this solves
 * -----------------------
 * The `browser-skill` plugin drives a local `bsk` daemon. On Windows that daemon
 * cannot be started from inside a dsh plugin: the host runs in a Job Object that
 * forbids detached children, so `bsk daemon start` fails with "拒绝访问
 * (os error 5)". Users hit this as a hard error the first time they call a
 * browser tool, with no obvious fix.
 *
 * What this plugin does
 * ---------------------
 * 1. `bsk_setup` (also run once at startup when `autoSetup` is on) builds a tiny
 *    wake shim and registers an on-demand scheduled task. A scheduled task is
 *    the only shape that can break away from the host's Job Object.
 * 2. Point `browser-skill`'s `bskPath` at the shim. Every browser tool call then
 *    transparently wakes the daemon if it is down, waits for it, and forwards.
 * 3. The daemon exits again after `daemonIdle`, so nothing stays resident.
 *
 * Lifecycle tools are exposed so the agent can inspect and repair the setup.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// @deepseek-ai/schemastery ships with the dsh host, so a mounted plugin always
// has it. A fresh clone running the tests does not, and a hard top-level import
// would turn that into a module-load crash. Fall back to a defaults-only shim.
let Schema
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = (await import('./schema-fallback.js')).default
}

import { buildShim, defaultShimPath, findCsc } from './shim/build-shim.mjs'
import { bskHome, resolveBsk, TASK_NAME, wakeStrategy } from './platform.js'

export const name = 'dsh-bsk-daemon'

export const Config = Schema.object({
  bskPath: Schema.string().default('')
    .description('Absolute path to the bsk binary. Leave empty to auto-detect (~/.local/bin/bsk.exe, ~/.cargo/bin/bsk, then PATH).'),
  taskName: Schema.string().default(TASK_NAME)
    .description('Windows scheduled task name used to host the daemon.'),
  daemonIdle: Schema.string().default('15m')
    .description('How long the daemon stays alive with no activity before exiting. Accepts bsk duration syntax (30s, 15m, 2h).'),
  sessionIdle: Schema.string().default('5m')
    .description('Per-session idle timeout handed to the daemon.'),
  autoSetup: Schema.boolean().default(true)
    .description('Run setup once at plugin load (build the shim and register the task when missing). Idempotent; set false to manage it by hand with bsk_setup.'),
  autoWake: Schema.boolean().default(true)
    .description('Wake the daemon before a browser tool runs, so the first call does not pay the cold-start cost mid-conversation.'),
  shimPath: Schema.string().default('')
    .description('Where to build the wake shim. Leave empty for ~/.local/bin/bsk-shim.exe.'),
})

// ── small helpers ───────────────────────────────────────────────────────────

function run(cmd, args, { timeout = 60_000, input } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(null)
    }, timeout)
    timer.unref?.()
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (error) => {
      stderr += String(error?.message ?? error)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    if (input !== undefined) {
      try { child.stdin.end(input) } catch { /* ignore */ }
    } else {
      try { child.stdin.end() } catch { /* ignore */ }
    }
  })
}

/** `bsk status --json`, parsed. Never throws. */
async function daemonStatus(bskPath) {
  const r = await run(bskPath, ['status', '--json'], { timeout: 15_000 })
  if (r.code !== 0) return { up: false, raw: r.stdout, error: (r.stderr || '').trim(), code: r.code }
  try {
    const data = JSON.parse(r.stdout)
    return { up: true, data, raw: r.stdout }
  } catch {
    return { up: false, raw: r.stdout, error: 'status returned unparseable JSON', code: r.code }
  }
}

// ── Windows setup: VBS launcher + on-demand scheduled task ──────────────────

function vbsLauncherPath(taskName) {
  return join(bskHome(), `${taskName}-launch.vbs`)
}

/**
 * The task action must not show a console window, and must survive the task
 * ending. A VBS launcher started with window style 0 does both.
 */
function writeVbsLauncher({ bskPath, taskName, daemonIdle, sessionIdle }) {
  const path = vbsLauncherPath(taskName)
  mkdirSync(bskHome(), { recursive: true })
  // VBScript quoting: the whole command is one string literal, and the quotes
  // around the executable path are doubled inside it. So the source line is
  //   sh.Run """C:\path\bsk.exe"" daemon start ...", 0, False
  // Window style 0 = hidden; the trailing False = do not wait.
  const body = [
    "' On-demand launcher for the bsk daemon (hidden, detached).",
    "'",
    "' Registered by dsh-bsk-daemon as a scheduled task with NO trigger: the wake",
    "' shim runs `schtasks /run /tn <task>` when the daemon is missing, so it starts",
    "' only when a browser tool needs it and exits again after the idle timeout.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${homedir()}"`,
    `sh.Run """${bskPath}"" daemon start --foreground --daemon-idle ${daemonIdle} --session-idle ${sessionIdle} --quiet", 0, False`,
    '',
  ].join('\r\n')
  writeFileSync(path, body, 'utf8')
  return path
}

/**
 * Task XML with no trigger. schtasks' CLI cannot express "no trigger", and a
 * logon trigger would defeat the on-demand design, so register from XML.
 */
function taskXml({ taskName, vbsPath }) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const user = process.env.USERNAME || ''
  const domain = process.env.USERDOMAIN || ''
  const author = domain ? `${domain}\\${user}` : user
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>BrowserSkill bsk daemon (on demand; started by dsh-bsk-daemon's wake shim).</Description>
    <Author>${esc(author)}</Author>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>${esc(author)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${esc(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

async function registerTask({ taskName, vbsPath }) {
  const xmlPath = join(bskHome(), `${taskName}.xml`)
  mkdirSync(bskHome(), { recursive: true })
  // schtasks wants UTF-16 for /XML.
  writeFileSync(xmlPath, Buffer.from('\ufeff' + taskXml({ taskName, vbsPath }), 'utf16le'))
  const r = await run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], { timeout: 30_000 })
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr, xmlPath }
}

async function taskExists(taskName) {
  const r = await run('schtasks.exe', ['/Query', '/TN', taskName], { timeout: 15_000 })
  return r.code === 0
}

// ── setup ───────────────────────────────────────────────────────────────────

/**
 * Idempotent setup. Returns a structured report so both the tool and the
 * startup path can show exactly what happened.
 */
export async function setup(config, { log } = {}) {
  const strategy = wakeStrategy()
  const bskPath = resolveBsk(config)
  const report = { strategy, bskPath, steps: [], ok: true }

  const status = await daemonStatus(bskPath)
  report.daemon = status.up ? 'running' : 'stopped'
  if (status.up && status.data) {
    report.daemonPid = status.data.pid
    report.browsers = Array.isArray(status.data.browsers) ? status.data.browsers.length : 0
  }

  if (strategy !== 'windows-task') {
    // macOS/Linux: no shim needed, `bsk` starts the daemon itself.
    report.steps.push({ step: 'shim', result: 'skipped', detail: 'not required on this platform' })
    report.steps.push({ step: 'task', result: 'skipped', detail: 'not required on this platform' })
    report.shimPath = null
    return report
  }

  if (!findCsc()) {
    report.ok = false
    report.steps.push({ step: 'shim', result: 'failed', detail: 'csc.exe (in-box .NET Framework compiler) not found' })
    return report
  }

  const shimTarget = config.shimPath || defaultShimPath()
  const built = buildShim({ bsk: bskPath, task: config.taskName, out: shimTarget })
  report.shimPath = built.ok ? built.path : null
  report.steps.push({
    step: 'shim',
    result: built.ok ? 'built' : 'failed',
    detail: built.ok ? built.path : built.log,
  })
  if (!built.ok) {
    report.ok = false
    return report
  }

  const vbsPath = writeVbsLauncher({
    bskPath,
    taskName: config.taskName,
    daemonIdle: config.daemonIdle,
    sessionIdle: config.sessionIdle,
  })
  report.steps.push({ step: 'launcher', result: 'written', detail: vbsPath })

  const registered = await registerTask({ taskName: config.taskName, vbsPath })
  report.steps.push({
    step: 'task',
    result: registered.ok ? 'registered' : 'failed',
    detail: registered.ok ? config.taskName : (registered.stderr || registered.stdout || '').trim(),
  })
  if (!registered.ok) report.ok = false

  report.nextStep = 'Point browser-skill at the shim: set `bskPath` in its plugin config to '
    + report.shimPath
  log?.(`bsk-daemon: ${report.ok ? 'setup complete' : 'setup incomplete'} (shim ${report.shimPath})`)
  return report
}

// ── plugin ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = ctx.logger
  let warned = false

  const resolveConfig = () => ({
    bskPath: resolveBsk(config),
    taskName: config.taskName || TASK_NAME,
    daemonIdle: config.daemonIdle || '15m',
    sessionIdle: config.sessionIdle || '5m',
    autoSetup: config.autoSetup !== false,
    autoWake: config.autoWake !== false,
    shimPath: config.shimPath || '',
  })

  // Run setup once, lazily: the first browser tool call is the moment the
  // daemon actually matters, and deferring avoids touching the filesystem at
  // plugin load on machines that never use browser tools.
  let setupPromise = null
  const ensureSetup = () => {
    if (setupPromise) return setupPromise
    setupPromise = setup(resolveConfig(), { log: (m) => logger?.info?.(m) }).catch((error) => {
      logger?.warn?.(`bsk-daemon: setup failed: ${error?.message ?? error}`)
      return { ok: false, steps: [], error: String(error?.message ?? error) }
    })
    return setupPromise
  }

  if (config.autoSetup !== false) {
    // Fire and forget: a failed setup must never block plugin load.
    void ensureSetup()
  }

  // Wake before a browser tool runs so the cold start is not paid mid-turn.
  ctx.on?.('tools/pre-execute', async (exec, next) => {
    try {
      const toolName = exec?.tool?.name ?? exec?.name ?? ''
      if (config.autoWake !== false && /^bsk_/.test(String(toolName))) {
        const cfg = resolveConfig()
        const status = await daemonStatus(cfg.bskPath)
        if (!status.up && cfg.taskName) {
          await run('schtasks.exe', ['/Run', '/TN', cfg.taskName], { timeout: 15_000 })
        }
      }
    } catch (error) {
      // Never let the wake attempt break the tool call itself.
      if (!warned) {
        warned = true
        logger?.warn?.(`bsk-daemon: pre-execute wake skipped: ${error?.message ?? error}`)
      }
    }
    return next()
  })

  const json = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'bsk_status',
    description:
      'Report whether the BrowserSkill bsk daemon is running, which browsers are connected, and how the wake shim is configured. Use when browser tools fail or before starting browser work.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_a, v) => json(v) },
    isConcurrencySafe: () => true,
    async execute() {
      const cfg = resolveConfig()
      const status = await daemonStatus(cfg.bskPath)
      return {
        platform: process.platform,
        strategy: wakeStrategy(),
        bskPath: cfg.bskPath,
        bskExists: existsSync(cfg.bskPath),
        shimPath: cfg.shimPath || defaultShimPath(),
        shimExists: existsSync(cfg.shimPath || defaultShimPath()),
        taskName: cfg.taskName,
        taskExists: process.platform === 'win32' ? await taskExists(cfg.taskName) : null,
        daemonIdle: cfg.daemonIdle,
        running: status.up,
        pid: status.data?.pid ?? null,
        uptimeSecs: status.data?.uptime_secs ?? null,
        browsers: status.data?.browsers ?? [],
        error: status.up ? null : status.error || null,
      }
    },
  })

  ctx.tools.register({
    name: 'bsk_setup',
    description:
      'Build the wake shim and register the on-demand daemon task (idempotent). Run this after installing the plugin or after moving the bsk binary. On macOS/Linux it only reports that no setup is needed.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_a, v) => json(v) },
    isConcurrencySafe: () => false,
    async execute() {
      setupPromise = null
      const report = await setup(resolveConfig(), { log: (m) => logger?.info?.(m) })
      return report
    },
  })

  ctx.tools.register({
    name: 'bsk_wake',
    description:
      'Start the BrowserSkill daemon if it is not running and wait until it answers. Use before a batch of browser work so the first call is fast.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_a, v) => json(v) },
    isConcurrencySafe: () => true,
    async execute() {
      const cfg = resolveConfig()
      const before = await daemonStatus(cfg.bskPath)
      if (before.up) return { alreadyRunning: true, pid: before.data?.pid ?? null }

      if (process.platform === 'win32') {
        await run('schtasks.exe', ['/Run', '/TN', cfg.taskName], { timeout: 15_000 })
      } else {
        spawn(cfg.bskPath, ['daemon', 'start'], { detached: true, stdio: 'ignore', windowsHide: true })
          .on('error', () => {})
          .unref()
      }

      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const status = await daemonStatus(cfg.bskPath)
        if (status.up) return { alreadyRunning: false, pid: status.data?.pid ?? null, waitedMs: 30_000 - (deadline - Date.now()) }
        await new Promise((r) => setTimeout(r, 400))
      }
      return { alreadyRunning: false, started: false, error: 'daemon did not become ready within 30s' }
    },
  })

  ctx.tools.register({
    name: 'bsk_stop',
    description:
      'Stop the BrowserSkill daemon. It restarts on demand, so this is only useful to free the process immediately rather than waiting for the idle timeout.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_a, v) => json(v) },
    isConcurrencySafe: () => false,
    async execute() {
      const cfg = resolveConfig()
      const r = await run(cfg.bskPath, ['daemon', 'stop'], { timeout: 20_000 })
      const after = await daemonStatus(cfg.bskPath)
      return { stopped: !after.up, exitCode: r.code, message: (r.stdout || r.stderr || '').trim() }
    },
  })

  logger?.info?.('bsk-daemon: loaded (on-demand daemon tools registered)')
}
