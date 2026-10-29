// Standalone smoke test for the setup path, without a dsh host.
// Run: node test/setup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { resolveBsk, wakeStrategy, TASK_NAME } from '../lib/platform.js'
import { buildShim, findCsc, defaultShimPath } from '../lib/shim/build-shim.mjs'

test('resolveBsk returns a usable path shape', () => {
  const p = resolveBsk({})
  assert.equal(typeof p, 'string')
  assert.ok(p.length > 0)
})

test('wakeStrategy matches the platform', () => {
  const s = wakeStrategy()
  if (process.platform === 'win32') assert.equal(s, 'windows-task')
  else assert.equal(s, 'detached')
})

test('TASK_NAME is a plain task name', () => {
  assert.equal(TASK_NAME, 'bsk-daemon')
})

test('buildShim compiles and embeds the bsk path', () => {
  if (process.platform !== 'win32') return // Windows-only shim
  if (!findCsc()) return // no in-box compiler on this machine

  const bsk = resolveBsk({})
  const out = defaultShimPath().replace(/bsk-shim\.exe$/, 'bsk-shim-test.exe')
  const r = buildShim({ bsk, task: 'bsk-daemon-test', out })
  assert.equal(r.ok, true, r.log)
  assert.equal(existsSync(out), true)
})
