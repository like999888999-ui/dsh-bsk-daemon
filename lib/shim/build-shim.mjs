#!/usr/bin/env node
/**
 * Build the Windows wake shim (bsk-shim.exe) from BskShim.cs.
 *
 * The shim is what makes "start the daemon on demand" possible on Windows,
 * where a dsh plugin cannot spawn a detached process. It is a tiny C# program
 * compiled with the in-box .NET Framework compiler, so no toolchain download
 * is required: every Windows install since 8 ships csc.exe.
 *
 * Substitutions baked in at build time: the absolute path to bsk.exe and the
 * scheduled-task name. Everything else is runtime behaviour.
 *
 * Usage: node lib/shim/build-shim.mjs [--bsk <path>] [--task <name>] [--out <path>]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
]

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bsk') out.bsk = argv[++i]
    else if (a === '--task') out.task = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

export function findCsc() {
  for (const c of CSC_CANDIDATES) if (existsSync(c)) return c
  return null
}

export function defaultBskPath() {
  const exe = process.platform === 'win32' ? 'bsk.exe' : 'bsk'
  const local = join(homedir(), '.local', 'bin', exe)
  if (existsSync(local)) return local
  return exe
}

export function defaultShimPath() {
  return join(homedir(), '.local', 'bin', 'bsk-shim.exe')
}

/**
 * Compile the shim. Returns { ok, path, log } and never throws, so callers can
 * report a usable message instead of a stack trace.
 */
export function buildShim({ bsk, task = 'bsk-daemon', out, csc } = {}) {
  const compiler = csc || findCsc()
  if (!compiler) {
    return { ok: false, log: 'csc.exe not found: this shim needs the in-box .NET Framework compiler (Windows only).' }
  }

  const srcPath = join(HERE, 'BskShim.cs')
  if (!existsSync(srcPath)) return { ok: false, log: `shim source missing: ${srcPath}` }

  const bskPath = bsk || defaultBskPath()
  const outPath = out || defaultShimPath()

  let src = readFileSync(srcPath, 'utf8')
  // The placeholders sit inside C# verbatim strings (@"..."), so a backslash is
  // literal and a double quote would need doubling. Paths never contain quotes.
  src = src.split('@@BSK_PATH@@').join(bskPath)
  src = src.split('@@TASK_NAME@@').join(task)

  const tmpSrc = join(tmpdir(), `bsk-shim-${process.pid}-${Date.now()}.cs`)
  writeFileSync(tmpSrc, src, 'utf8')
  mkdirSync(dirname(outPath), { recursive: true })
  try { rmSync(outPath, { force: true }) } catch { }

  const res = spawnSync(compiler, ['-nologo', '-target:exe', `-out:${outPath}`, tmpSrc], {
    encoding: 'utf8',
    windowsHide: true,
  })
  try { rmSync(tmpSrc, { force: true }) } catch { }

  const log = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (res.status !== 0 || !existsSync(outPath)) {
    return { ok: false, path: outPath, log: log || `csc exited with ${res.status}` }
  }
  return { ok: true, path: outPath, bsk: bskPath, task, log }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node lib/shim/build-shim.mjs [--bsk <bsk.exe>] [--task <name>] [--out <shim.exe>]')
    process.exit(0)
  }
  const r = buildShim(args)
  if (!r.ok) {
    console.error(`build failed: ${r.log}`)
    process.exit(1)
  }
  console.log(`built ${r.path}`)
  console.log(`  bsk  -> ${r.bsk}`)
  console.log(`  task -> ${r.task}`)
}
