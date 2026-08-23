// approval.parallel 测试：并行竞速语义 + 缺省排他回归。
// 断言安全红线不破：静默永不批准、单次返回、首达采纳、异常退回桌面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 最小依赖装配：真实 bus/vault/store + 假 ctx/notifier/telegram。
 * deferredDesktop=true 时 next() 返回挂起的 promise，由 releaseDesktop() 手动放行，
 * 用于模拟"桌面询问在途/迟到"的竞速场景。
 */
function makeRig({ approvalConfig = {}, deferredDesktop = false } = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'dsh-notifier-par-')), 'state.json'))
  const vault = createTokenVault({ secret: 'par-secret' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const handlers = {}
  const ctx = {
    on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } },
  }
  const broadcasts = []
  const notifier = {
    notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true, delivered: [], skipped: [], failed: [] } },
  }
  const cards = []
  const edits = []
  const telegram = {
    notifyChatIds: () => ['100'],
    sendApprovalCard: async ({ chatId, title, approvalKey, token }) => {
      const card = { chatId, title, approvalKey, token, messageId: cards.length + 1 }
      cards.push(card)
      return { messageId: card.messageId }
    },
    editResolved: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }) },
  }
  registerApprovalHandler({
    ctx, notifier, bus, vault, store, telegram,
    counterStart: 0,
    approvalConfig: { mode: 'answer', ...approvalConfig },
  })
  let releaseDesktop = () => {}
  let desktopValue = 'desktop-deferred'
  const desktopGate = new Promise((resolve) => {
    releaseDesktop = (value) => { if (value !== undefined) desktopValue = value; resolve() }
  })
  const nextCalls = []
  const handle = (request) => handlers['approval/request'](request, () => {
    nextCalls.push(Date.now())
    if (!deferredDesktop) return 'desktop-immediate'
    return desktopGate.then(() => desktopValue)
  })
  return { store, bus, broadcasts, cards, edits, handle, releaseDesktop, nextCalls }
}

test('parallel：next 立即放行；远程先决返回 allowed-once', async () => {
  const rig = makeRig({ approvalConfig: { parallel: true, timeoutMs: 5000 }, deferredDesktop: true })
  const pending = rig.handle({ toolName: 'rm', callId: 'p1', reason: '删除文件' })
  await sleep(10) // 让推卡与 next() 放行完成
  assert.equal(rig.nextCalls.length, 1) // 桌面询问已立即发出（排他模式此时为 0）
  rig.bus.decideTrusted({ approvalKey: 'ap:p1:1', decision: 'allowed-once', via: 'qq:reply', userId: '42' })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:p1:1').decision, 'allowed-once')
})

test('parallel：桌面先行——结果透传、远程 waiter 撤销、卡片改写', async () => {
  const rig = makeRig({ approvalConfig: { parallel: true, timeoutMs: 3000 }, deferredDesktop: true })
  const pending = rig.handle({ toolName: 'rm', callId: 'p2' })
  await sleep(20)
  rig.releaseDesktop('desktop-said-ok')
  assert.equal(await pending, 'desktop-said-ok') // 下游返回值原样透传
  const verdict = rig.bus.decideTrusted({ approvalKey: 'ap:p2:1', decision: 'allowed-once', via: 'qq:reply', userId: '42' })
  assert.equal(verdict.ok, false) // 迟到的远程裁决被拒收
  assert.equal(verdict.reason, 'already-resolved')
  assert.equal(rig.store.get('ap:p2:1').status, 'resolved') // 账本不悬挂 pending
  assert.ok(rig.edits.some((e) => /已在桌面处理/.test(e.text)))
})

test('parallel：远程先决后，迟到的桌面结果不影响账本与返回值', async () => {
  const rig = makeRig({ approvalConfig: { parallel: true, timeoutMs: 3000 }, deferredDesktop: true })
  const pending = rig.handle({ toolName: 'rm', callId: 'p3' })
  await sleep(20)
  rig.bus.decideTrusted({ approvalKey: 'ap:p3:1', decision: 'rejected', via: 'qq:reply', userId: '42' })
  assert.equal(await pending, 'rejected')
  rig.releaseDesktop() // 迟到的桌面结果——不得抛未处理拒绝、不得改账本
  await sleep(10)
  assert.equal(rig.store.get('ap:p3:1').decision, 'rejected')
  assert.ok(rig.edits.some((e) => /已远程拒绝/.test(e.text)))
})

test('parallel：远程窗口先超时——卡片改交还文案，最终以桌面结果收束', async () => {
  // 注意 router 将 timeoutMs 钳制到下限 1000ms：用例用 1000ms 并等 1150ms 再断言
  const rig = makeRig({ approvalConfig: { parallel: true, timeoutMs: 1000 }, deferredDesktop: true })
  const pending = rig.handle({ toolName: 'rm', callId: 'p4' })
  await sleep(1150)
  assert.ok(rig.edits.some((e) => /手机端等待超时/.test(e.text)))
  rig.releaseDesktop('desktop-late')
  assert.equal(await pending, 'desktop-late')
  assert.ok(rig.edits.some((e) => /已在桌面处理/.test(e.text)))
})

test('parallel 缺省：保持上游排他语义——等待期内不调用 next', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 80 }, deferredDesktop: true })
  const t0 = Date.now()
  const pending = rig.handle({ toolName: 'rm', callId: 'p5' })
  await sleep(30)
  assert.equal(rig.nextCalls.length, 0) // 排他模式：等待期内桌面不被询问
  rig.releaseDesktop() // 超时交还后 next() 会等待桌面结果——放行闸门
  const result = await pending
  assert.ok(Date.now() - t0 >= 70)
  assert.equal(result, 'desktop-deferred')
  assert.ok(rig.edits.some((e) => /超时未响应/.test(e.text)))
})
