// question-dual 测试：ask_user 双端并行（桌面弹窗 ↔ 远端卡片，先答先算）。
// 覆盖：桌面抢先（远端卡终结+答案映射）、远端先答（弹窗被 abort）、桌面取消回落、
// 无服务/关闭并行的旧行为保留、多问批次整批改用桌面答案。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge, registerAskUserTool } from '../src/questions/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OPENID_A = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4'
const ARGS = {
  questions: [{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }],
  timeoutMs: 60_000,
}

function makeDualRig({ parallel = true, userQuestions } = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'dsh-notifier-qdual-')), 'state.json'))
  const vault = createTokenVault({ secret: 'qdual-secret' })
  const bus = createInboundBus({ allowUsers: [OPENID_A], store, vault })
  const notifier = { channels: ['qq-bot'], notifyAll: async () => ({ ok: true, delivered: [], skipped: [], failed: [] }) }
  const cards = []
  const cardEdits = []
  const texts = []
  const qqLike = {
    channel: 'qq',
    capabilities: { buttons: true },
    notifyTargets: () => [{ chatId: OPENID_A, userId: OPENID_A }],
    sendQuestionCard: async (payload) => { cards.push(payload); return { messageId: `qm-${cards.length}` } },
    editResolved: async (_target, text) => { cardEdits.push(text) },
    sendText: async (_chatId, text) => { texts.push(text); return true },
  }
  const bridge = createQuestionBridge({
    bus, vault, store, notifier,
    interactive: () => [qqLike],
    logger: { warn: () => {} },
    config: { timeoutMs: 60_000 },
  })
  bridge.attach()
  let registeredTool = null
  const ctx = {
    tools: { register: (tool) => { registeredTool = tool; return () => {} } },
    ...(userQuestions !== undefined ? { userQuestions } : {}),
  }
  registerAskUserTool(ctx, bridge, { rateLimitPerMinute: 6, defaultTimeoutMs: 300_000, parallel })
  const clickOption0 = () => bus.accept({
    channel: 'qq', userId: OPENID_A, chatId: OPENID_A, messageId: `ix-${Math.random().toString(36).slice(2)}`,
    text: '[提问按钮:0] x',
    questionAction: { qKey: cards[0].qKey, optIdx: '0', token: cards[0].token },
  })
  return { store, bridge, cards, cardEdits, texts, tool: () => registeredTool, clickOption0 }
}

test('桌面抢先提交：远端待决卡被终结（🖥️ 文案）+ 整批改用桌面答案', async () => {
  const rig = makeDualRig({
    userQuestions: { ask: async () => ({ answers: [{ id: 'q1', selected: ['乙'] }] }) },
  })
  const outcome = await rig.tool().execute(ARGS, {})
  assert.equal(outcome.answered, true)
  assert.equal(outcome.via, 'web')
  assert.deepEqual(outcome.results[0].answers, ['乙'])
  assert.ok(rig.cardEdits.some((t) => /🖥️ 已在桌面\/Web 作答/.test(t)))
})

test('远端先答：QQ 按钮作答生效，桌面弹窗收到 abort 信号', async () => {
  let aborted = false
  const rig = makeDualRig({
    userQuestions: { ask: (req) => new Promise((_resolve, reject) => {
      // 模拟 apiproxy 真提供方：abort 即拒绝（弹窗被撤）
      req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('ASK_ABORTED')) }, { once: true })
    }) },
  })
  const pending = rig.tool().execute(ARGS, {})
  await sleep(40)
  rig.clickOption0()
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['甲'])
  assert.equal(outcome.results[0].via, 'qq:button')
  assert.equal(aborted, true) // 远端赢 → 撤掉没人理的弹窗
})

test('桌面被用户关掉：回落远端结论，行为与单端一致', async () => {
  const rig = makeDualRig({
    userQuestions: { ask: async () => { throw new Error('ASK_ABORTED') } },
  })
  const pending = rig.tool().execute(ARGS, {})
  await sleep(40)
  rig.clickOption0()
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['甲'])
  assert.equal(outcome.dualEnd, undefined) // 实际走的是远端结果
})

test('无 userQuestions 服务：旧行为逐字节保留', async () => {
  const rig = makeDualRig({ userQuestions: undefined })
  const pending = rig.tool().execute(ARGS, {})
  await sleep(40)
  rig.clickOption0()
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.deepEqual(outcome.results[0].answers, ['甲'])
})

test('parallel:false：即使服务在也走单端瀑布', async () => {
  let asked = false
  const rig = makeDualRig({
    parallel: false,
    userQuestions: { ask: async () => { asked = true; return { answers: [] } } },
  })
  const pending = rig.tool().execute(ARGS, {})
  await sleep(40)
  rig.clickOption0()
  const outcome = await pending
  assert.equal(outcome.answered, true)
  assert.equal(asked, false) // 原生询问从未被触发
})

test('多问批次：桌面一次答全 → 全部按桌面答案；后续问题不再外发', async () => {
  const multiArgs = {
    questions: [
      { question: '第一问', options: [{ label: 'A1' }, { label: 'A2' }] },
      { question: '第二问', options: [{ label: 'B1' }, { label: 'B2' }] },
    ],
    timeoutMs: 60_000,
  }
  const rig = makeDualRig({
    userQuestions: { ask: async () => ({ answers: [
      { id: 'q1', selected: ['A2'] },
      { id: 'q2', custom: '我就随便说说' },
    ] }) },
  })
  const outcome = await rig.tool().execute(multiArgs, {})
  assert.equal(outcome.answered, true)
  assert.equal(rig.cards.length <= 1, true) // 第二问不再外发卡片（旗标短路）
  assert.deepEqual(outcome.results[0].answers, ['A2'])
  assert.deepEqual(outcome.results[1].answers, ['我就随便说说']) // custom 自由文本
})
