// button-interaction 测试：QQ 官方 bot 按钮化审批的端到端语义。
// 覆盖：契约负载 roundtrip、INTERACTION 回调显式 key 裁决、接收人校验、
// 已决竞态回执、伪造 token 拒绝、文本形态兜底（指令按钮/旧客户端）、
// 广播去重（卡片成功后出站孪生静默）与广播兜底（卡片失败时照发）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { buildApprovalAction, parseApprovalAction } from '../src/inbound/_contract.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const OPENID_A = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4' // 审批接收人
const OPENID_B = 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5' // 另一位绑定成员

/** 最小装配：真实 bus/vault/store + 统一契约形状的 qq 假通道。 */
function makeRig({ timeoutMs = 5000, failCard = false } = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'dsh-notifier-btn-')), 'state.json'))
  const vault = createTokenVault({ secret: 'btn-secret' })
  const bus = createInboundBus({ allowUsers: [OPENID_A, OPENID_B], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } } }
  const broadcasts = []
  const notifier = {
    channels: ['qq-bot'], // 真实出站注册名（入站交互渠道名为 'qq'，经别名表桥接）
    notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true, delivered: [], skipped: [], failed: [] } },
  }
  const cards = []
  const receipts = []
  const edits = []
  const qqLike = {
    channel: 'qq',
    capabilities: { buttons: true },
    notifyTargets: () => [{ chatId: OPENID_A, userId: OPENID_A }],
    sendApprovalCard: async ({ chatId, title, content, approvalKey, token }) => {
      if (failCard) return null
      cards.push({ chatId, title, content, approvalKey, token })
      return { messageId: `msg-${cards.length}` }
    },
    editResolved: async (target, text) => { edits.push({ target, text }) },
    sendText: async (chatId, text) => { receipts.push({ chatId, text }); return true },
  }
  registerApprovalHandler({
    ctx, notifier, bus, vault, store, interactive: [qqLike],
    counterStart: 0,
    approvalConfig: { mode: 'answer', timeoutMs },
  })
  const handle = (request) => handlers['approval/request'](request, () => 'desktop-immediate')
  /** 模拟 qq-gw 的 INTERACTION_CREATE → bus.accept 注入路径。 */
  const click = (messageId, clickerOpenid, decision, approvalKey, token) => {
    const payload = buildApprovalAction(decision, approvalKey, token)
    const parsed = parseApprovalAction(payload)
    assert.notEqual(parsed, null, '契约负载必须可解析')
    return bus.accept({
      channel: 'qq',
      userId: clickerOpenid,
      chatId: clickerOpenid,
      messageId,
      text: `[审批按钮:${parsed.decision}] ${parsed.approvalKey}`,
      approvalAction: { decision: parsed.decision, approvalKey: parsed.approvalKey, token: parsed.token },
    })
  }
  return { store, bus, vault, cards, receipts, edits, broadcasts, handle, click }
}

test('契约负载 roundtrip：key 含冒号时中间段完整重组，token 取末段', () => {
  const key = 'ap:some-call-id:12345'
  const parsed = parseApprovalAction(buildApprovalAction('allowed-once', key, 'tok-abc'))
  assert.deepEqual(parsed, { decision: 'allowed-once', approvalKey: key, token: 'tok-abc' })
  assert.equal(parseApprovalAction('garbage'), null)
  assert.equal(parseApprovalAction('ap:only:three'), null) // 缺 token 段
})

test('按钮点击：显式 key 精确裁决 pending 审批 → allowed-once', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'pwsh', callId: 'bt1', reason: '按钮化测试' })
  await sleep(20)
  assert.equal(rig.cards.length, 1)
  assert.equal(rig.cards[0].approvalKey, 'ap:bt1:1')
  const result = rig.click('interaction-1', OPENID_A, 'allowed-once', rig.cards[0].approvalKey, rig.cards[0].token)
  assert.equal(result.ok, true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:bt1:1').decision, 'allowed-once')
})

test('非接收人点击：用户级校验拦截，行保持 pending，收到拒绝回执', async () => {
  const rig = makeRig({ timeoutMs: 900 })
  rig.handle({ toolName: 'pwsh', callId: 'bt2' })
  await sleep(20)
  rig.click('interaction-2', OPENID_B, 'rejected', rig.cards[0].approvalKey, rig.cards[0].token)
  assert.equal(rig.store.get('ap:bt2:1').status, 'pending')
  assert.ok(rig.receipts.some((r) => /仅审批接收人/.test(r.text)))
})

test('已决审批再点：回执「已被处理」，不翻账本（首达采纳）', async () => {
  const rig = makeRig({ timeoutMs: 900 })
  const pending = rig.handle({ toolName: 'rm', callId: 'bt3' })
  await sleep(20)
  rig.bus.decideTrusted({ approvalKey: 'ap:bt3:1', decision: 'rejected', via: 'test' })
  assert.equal(await pending, 'rejected')
  rig.click('interaction-3', OPENID_A, 'allowed-once', 'ap:bt3:1', rig.cards[0].token)
  assert.ok(rig.receipts.some((r) => /已被处理或已失效/.test(r.text)))
  assert.equal(rig.store.get('ap:bt3:1').decision, 'rejected') // 首达采纳不被推翻
})

test('伪造 token：bus.decide 验签拒绝，账本不动', async () => {
  const rig = makeRig({ timeoutMs: 900 })
  rig.handle({ toolName: 'edit', callId: 'bt4' })
  await sleep(20)
  rig.click('interaction-4', OPENID_A, 'allowed-once', 'ap:bt4:1', 'forged-token-value')
  assert.equal(rig.store.get('ap:bt4:1').status, 'pending')
  assert.ok(rig.receipts.some((r) => /已被处理或已失效/.test(r.text)))
})

test('文本形态按钮负载兜底：指令按钮发出的纯文本同样裁决成功', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'pwsh', callId: 'bt5' })
  await sleep(20)
  const payload = buildApprovalAction('allowed-once', rig.cards[0].approvalKey, rig.cards[0].token)
  // 模拟指令按钮/旧客户端：payload 作为普通文本消息到达（无 approvalAction 字段）
  const result = rig.bus.accept({
    channel: 'qq', userId: OPENID_A, chatId: OPENID_A,
    messageId: 'interaction-5',
    text: payload,
  })
  assert.equal(result.ok, true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:bt5:1').decision, 'allowed-once')
})

test('广播去重：卡片成功后不重发审批通知（qq 单渠道零冗余）', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'pwsh', callId: 'bc1' })
  await sleep(20)
  assert.equal(rig.cards.length, 1)      // 卡片已发
  assert.equal(rig.broadcasts.length, 0) // 出站孪生不再重发纯文本
  rig.click('interaction-bc1', OPENID_A, 'allowed-once', rig.cards[0].approvalKey, rig.cards[0].token)
  assert.equal(await pending, 'allowed-once')
})

test('广播兜底：卡片发送失败时广播照发（回复 1/2 教学不丢）', async () => {
  const rig = makeRig({ timeoutMs: 900, failCard: true })
  const pending = rig.handle({ toolName: 'pwsh', callId: 'bc2' })
  await sleep(20)
  assert.equal(rig.cards.length, 0)
  assert.equal(rig.broadcasts.length, 1) // 无卡 → 兜底广播必须到达
  rig.bus.decideTrusted({ approvalKey: 'ap:bc2:1', decision: 'rejected', via: 'test' })
  assert.equal(await pending, 'rejected')
})
