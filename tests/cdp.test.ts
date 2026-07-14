import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CdpClient, CdpError } from '../src/cdp.ts'
import { FakeCdp } from './helpers/fake-cdp.ts'

test('send() resolves with the command result and carries sessionId', async (t) => {
  const fake = await FakeCdp.start((cmd) => {
    if (cmd.method === 'Target.createTarget') return { targetId: 'T-1' }
    if (cmd.method === 'Runtime.evaluate') return { result: { value: `echo:${cmd.sessionId}` } }
    return {}
  })
  t.after(() => fake.close())

  const client = await CdpClient.connect(fake.url)
  t.after(() => client.close())

  const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  assert.equal(targetId, 'T-1')

  const res = await client.send<{ result: { value: string } }>('Runtime.evaluate', { expression: '1' }, 'SESSION-9')
  assert.equal(res.result.value, 'echo:SESSION-9')

  const evalCmd = fake.commands.find((c) => c.method === 'Runtime.evaluate')!
  assert.equal(evalCmd.sessionId, 'SESSION-9')
  assert.deepEqual(evalCmd.params, { expression: '1' })
})

test('CDP protocol errors reject with CdpError naming the method', async (t) => {
  const fake = await FakeCdp.start(() => ({ __error: 'Extension path does not exist' }))
  t.after(() => fake.close())
  const client = await CdpClient.connect(fake.url)
  t.after(() => client.close())

  await assert.rejects(
    client.send('Extensions.loadUnpacked', { path: '/nope' }),
    (e: unknown) => e instanceof CdpError && /Extensions\.loadUnpacked.*does not exist/.test((e as Error).message)
  )
})

test('events fan out to listeners; unsubscribe works', async (t) => {
  const fake = await FakeCdp.start(() => ({}))
  t.after(() => fake.close())
  const client = await CdpClient.connect(fake.url)
  t.after(() => client.close())

  const seen: string[] = []
  const off = client.on((e) => seen.push(e.method))

  fake.emitEvent('Target.targetCreated', { targetInfo: {} })
  await client.send('Browser.getVersion') // round-trip to flush the event
  assert.deepEqual(seen, ['Target.targetCreated'])

  off()
  fake.emitEvent('Target.targetDestroyed', {})
  await client.send('Browser.getVersion')
  assert.deepEqual(seen, ['Target.targetCreated'])
})

test('closing the connection rejects in-flight commands', async (t) => {
  const fake = await FakeCdp.start((cmd) => {
    if (cmd.method === 'Slow.command') {
      // never answer; the test kills the socket instead
      return { __error: '__never__' }
    }
    return {}
  })
  t.after(() => fake.close())

  // swallow the scripted answer by not responding: emulate via handler that
  // returns an error we never send — instead override sendRaw for this id
  const realSendRaw = fake.sendRaw.bind(fake)
  fake.sendRaw = (obj: unknown) => {
    const msg = obj as { error?: { message?: string } }
    if (msg.error?.message === '__never__') return
    realSendRaw(obj)
  }

  const client = await CdpClient.connect(fake.url)
  const pending = client.send('Slow.command')
  await fake.waitForCommand('Slow.command')
  client.close()
  await assert.rejects(pending, /CDP connection closed/)

  await assert.rejects(client.send('Browser.getVersion'), /connection is closed/)
})
