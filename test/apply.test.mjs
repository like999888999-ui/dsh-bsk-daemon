// Load the plugin against a fake dsh context and confirm apply() wires up
// without throwing. Catches the two failure modes that only show up at mount
// time: a bad event name and a tool registration that is missing a field the
// host requires.
//
// Run: node test/apply.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

const events = []
const tools = []
const logs = []

const fakeCtx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
  },
  on(event, handler) {
    events.push([event, handler])
    return () => {}
  },
  tools: {
    register(tool) {
      tools.push(tool)
    },
  },
}

test('apply() registers the lifecycle tools and the pre-execute hook', async () => {
  const mod = await import('../lib/index.js')
  // Minimal config: disable autoSetup so the test never touches the filesystem
  // or registers a real scheduled task.
  mod.apply(fakeCtx, {
    bskPath: '',
    taskName: 'bsk-daemon-test',
    daemonIdle: '15m',
    sessionIdle: '5m',
    autoSetup: false,
    autoWake: true,
    shimPath: '',
  })

  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['bsk_setup', 'bsk_status', 'bsk_stop', 'bsk_wake'])

  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
    assert.ok(tool.description.length > 20, `${tool.name} description is too thin`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name} needs parameters`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object schema`)
  }

  const pre = events.find(([e]) => e === 'tools/pre-execute')
  assert.ok(pre, 'tools/pre-execute hook must be registered')
  assert.equal(typeof pre[1], 'function')
})

test('pre-execute hook passes non-browser tools straight through', async () => {
  const [, handler] = events.find(([e]) => e === 'tools/pre-execute')
  let called = false
  const next = async () => {
    called = true
    return 'continued'
  }
  const result = await handler({ tool: { name: 'bash' } }, next)
  assert.equal(called, true)
  assert.equal(result, 'continued')
})

test('plugin module exports the dsh contract', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.name, 'string')
  assert.equal(mod.name, 'dsh-bsk-daemon')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config, 'Config schema must be exported')
})

test('plugin declares the tools service it depends on', async () => {
  const mod = await import('../lib/index.js')
  // Regression guard: without `tools` in inject, the host mounts this plugin
  // before the tool registry exists. apply() then throws on ctx.tools.register
  // and the plugin ends up loaded with zero tools and no visible error.
  assert.ok(Array.isArray(mod.inject), 'inject must be an array')
  assert.ok(mod.inject.includes('tools'), 'inject must include "tools"')
})
