// question-card 测试：QQ 提问卡片 + 按钮回调/跳过/自定义文本作答的端到端语义。
// 覆盖：aq 契约负载 roundtrip、卡片推送落账、按钮选项作答、跳过交还桌面、
// 自定义教学回执、「答：」前缀自由文本作答、伪造 token 拒绝、非接收会话拦截。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { buildQuestionAction, parseQuestionAction } from '../src/inbound/_contract.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OPENID_A = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4'

/** 最小装配：真实 bridge/bus/vault/store + 统一契约形状的 qq 假通道。 */
function makeRig({ timeoutMs = 900 } = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'dsh-notifier-qcard-')), 'state.json'))
  const vault = createTokenVault({ secret: 'qcard-secret' })
  const bus = createInboundBus({ allowUsers: [OPENID_A], store, vault })
  const broadcasts = []
  const notifier = {
    channels: ['qq-bot'],
    notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true, delivered: [], skipped: [], failed: [] } },
  }
  const cards = []
  const texts = []
  const qqLike = {
    channel: 'qq',
    capabilities: { buttons: true },
    notifyTargets: () => [{ chatId: OPENID_A, userId: OPENID_A }],
    // 与 qq-gw 实现同契约：捕获入参、回 messageId（按钮构建正确性由 live 验证覆盖）
    sendQuestionCard: async (payload) => { cards.push(payload); return { messageId: `qm-${cards.length}` } },
    editResolved: async () => {},
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
  }
  const bridge = createQuestionBridge({
    bus, vault, store, notifier,
    interactive: () => [qqLike],
    logger: { warn: () => {} },
    config: { timeoutMs },
  })
  bridge.attach()
  const ask = (question = '选哪个方案？', options = [{ label: '方案 A' }, { label: '方案 B' }], multiSelect = false) =>
    bridge.askQuestions({ questions: [{ question, options, multiSelect }], timeoutMs }, {})
  /** 模拟 qq-gw INTERACTION → bus.accept 注入提问按钮回调。 */
  const clickButton = ({ qKey, optIdx, token }, chatId = OPENID_A) => bus.accept({
    channel: 'qq', userId: OPENID_A, chatId, messageId: `ix-${Math.random().toString(36).slice(2)}`,
    text: `[提问按钮:${optIdx}] ${qKey}`,
    questionAction: { qKey, optIdx, token },
  })
  return { store, bus, vault, cards, texts, broadcasts, bridge, ask, clickButton }
}

test('aq 契约负载 roundtrip：qKey 含前缀冒号时中间段完整重组', () => {
  const parsed = parseQuestionAction(buildQuestionAction('aq:ab12cd34', '0', 'tok-abc'))
  assert.deepEqual(parsed, { qKey: 'aq:ab12cd34', optIdx: '0', token: 'tok-abc' })
  assert.equal(parseQuestionAction('aq:x:s'), null) // 少于 4 段：格式不符
  assert.equal(parseQuestionAction('garbage'), null)
})

test('卡片推送：sendQuestionCard 收到契约参数并落账 pushedTo；不再重复发编号广播', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  assert.equal(rig.cards.length, 1)
  const card = rig.cards[0]
  assert.equal(card.title, '提问：选哪个方案？')
  assert.deepEqual(card.options, ['方案 A', '方案 B'])
  assert.equal(card.multiSelect, false)
  assert.match(String(card.qKey), /^aq:/)
  assert.ok(String(card.token).length > 10)
  const row = rig.store.get(card.qKey)
  assert.equal(row.status, 'pending')
  assert.equal(row.pushedTo[0].channel, 'qq')
  assert.equal(rig.broadcasts.length, 0) // 卡片已送达 qq：出站孪生不重复教编号
  rig.clickButton({ qKey: card.qKey, optIdx: '1', token: card.token })
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['方案 B'])
})

test('按钮作答：数字下标经验签+来源校验裁决，回执确认', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: '0', token: rig.cards[0].token })
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['方案 A'])
  assert.equal(outcome.results[0].via, 'qq:button')
  assert.ok(rig.texts.some((t) => /✅ 已作答：方案 A/.test(t.text)))
})

test('跳过按钮：立即交还桌面（answered=false, skipped-by-user），绝不代答', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: 's', token: rig.cards[0].token })
  const outcome = await pending
  assert.equal(outcome.answered, false)
  assert.equal(outcome.results[0].reason, 'skipped-by-user')
  assert.equal(rig.store.get(rig.cards[0].qKey).decision, 'skipped')
  assert.ok(rig.texts.some((t) => /⏭ 已跳过/.test(t.text)))
})

test('自定义教学按钮：问题保持待决，回执教「答：」前缀', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: 'c', token: rig.cards[0].token })
  await sleep(10)
  assert.ok(rig.texts.some((t) => /✍️ 自定义回答/.test(t.text)))
  assert.equal(rig.store.get(rig.cards[0].qKey).status, 'pending') // 未被消费
  // 教学之后按「答：」提交自由文本 → 成为答案
  rig.bus.accept({ channel: 'qq', userId: OPENID_A, chatId: OPENID_A, messageId: 'm-custom', text: '答：用方案 B，理由如下' })
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['用方案 B，理由如下'])
})

test('「答：」前缀自由文本：直接作为答案提交（无需先点教学按钮）', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  rig.bus.accept({ channel: 'qq', userId: OPENID_A, chatId: OPENID_A, messageId: 'm-t1', text: '答：都行，你定' })
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['都行，你定'])
  assert.equal(outcome.results[0].via, 'qq:text')
})

test('裸文本不受影响：非「答：」行首不消费提问、不产生回执', async () => {
  const rig = makeRig()
  const pending = rig.ask()
  await sleep(30)
  const textsBefore = rig.texts.length
  rig.bus.accept({ channel: 'qq', userId: OPENID_A, chatId: OPENID_A, messageId: 'm-t2', text: '回答一下：方案 B' })
  await sleep(10)
  assert.equal(rig.store.get(rig.cards[0].qKey).status, 'pending') // 保持待决
  assert.equal(rig.texts.length, textsBefore) // 未产生任何作答回执
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: '0', token: rig.cards[0].token }) // 收尾
  const outcome = await pending
  assert.equal(outcome.answered, true)
})

test('伪造 token：验签拒绝，提问保持待决直至超时交还桌面', async () => {
  const rig = makeRig({ timeoutMs: 600 })
  const pending = rig.ask()
  await sleep(30)
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: '0', token: 'forged-token' })
  await sleep(10)
  assert.equal(rig.store.get(rig.cards[0].qKey).status, 'pending')
  assert.ok(rig.texts.some((t) => /作答失败|校验失败/.test(t.text)))
  const outcome = await pending
  assert.equal(outcome.answered, false)
})

test('非接收会话：chatId 不在 pushedTo 的点击被拦截（跨会话不可操作）', async () => {
  const rig = makeRig({ timeoutMs: 600 })
  const pending = rig.ask()
  await sleep(30)
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: '0', token: rig.cards[0].token }, 'other-chat-id')
  await sleep(10)
  assert.equal(rig.store.get(rig.cards[0].qKey).status, 'pending')
  assert.ok(rig.texts.some((t) => /请到原会话操作/.test(t.text)))
  rig.clickButton({ qKey: rig.cards[0].qKey, optIdx: '0', token: rig.cards[0].token }) // 正确会话收尾
  const outcome = await pending
  assert.equal(outcome.answered, true)
})
