// dsh-notifier approval/router.mjs
// approval/request 瀑布流处理器（远程审批，阶段 4 核心）。
// 宿主事实（已核对 user-approval 源码）：ApprovalRequest = { agent, toolName, callId?, reason?, signal? }
// ——没有 id 字段，审批 id 由 service 内部签发。因此本模块自行铸 key：
//   key = ap:<callId ?? toolName>:<单调计数>，并把 agent/session 一起入账。
// 安全红线：
//  - 静默永不批准：超时/无响应/解析失败/异常一律 return next() 交还桌面
//  - 一次点击只授权一次操作：token 单次核销 + 账本状态机（首达采纳）
//  - A listener never throws：整个 handler 包 try/catch，任何异常退回 next()
//  - observe 模式只旁观：推完卡片立即 next()，桌面照常决定
//
// parallel 并行裁决：approvalConfig.parallel === true 时推卡后立即放行 next()，
// 远程 bus.wait 与下游结果竞速、先答先算；缺省 false 为排他瀑布（等待期不询问桌面）。

import { createEscalationChain } from './escalation.mjs'
import { normalizeInbound, parseApprovalAction } from '../inbound/_contract.mjs'
import { guardTargets } from '../inbound/target-guard.mjs'
import { workspaceOf } from '../routing/session-registry.mjs'

const OUTCOME_ALLOWED = 'allowed-once'
const OUTCOME_REJECTED = 'rejected'

// 通道名 → 用户可读名（广播文案用；telegram 显示名保持 v0.2.0 原样，测试契约不破）
const DISPLAY_NAMES = {
  telegram: 'Telegram',
  feishu: '飞书',
  qq: 'QQ',
  wxpusher: 'WxPusher',
  wechat: '微信',
  dingtalk: '钉钉',
}

// 出站渠道类型 → 入站交互渠道名的显式别名表（严格逐名映射，无通配）。
// dsh-notifier 的 QQ 只有一种实现（官方机器人），但注册了两个名字：入站交互
// 渠道 'qq'（WS 网关）、出站通知渠道 'qq-bot'（REST）——不同适配器、不同投递面，
// 必须严格区分。本表仅桥接这一对名字；未来若新增其他 QQ 实现（onebot/qmsg 等）
// 各自独立注册、绝不共用别名。
const INTERACTIVE_ALIASES = Object.freeze({ 'qq-bot': 'qq' })

// 升级链默认节奏：30s / 60s 各再提醒一轮（timeoutMs 默认 120s 内完成两轮升级）
const DEFAULT_ESCALATION_STAGES = [
  { afterMs: 30_000, level: 'timeSensitive', note: '第 1 次升级提醒' },
  { afterMs: 60_000, level: 'timeSensitive', note: '第 2 次升级提醒' },
]

/**
 * 注册 approval/request 处理器。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（ctx.on）
 * @param {object} deps.notifier - createNotifier 实例（升级链推送用）
 * @param {ReturnType<typeof import('../inbound/bus.mjs').createInboundBus>} deps.bus
 * @param {ReturnType<typeof import('../inbound/tokens.mjs').createTokenVault>} deps.vault
 * @param {import('../inbound/store.mjs').store} deps.store - pending 账本持久化
 * @param {object} deps.telegram - （旧入口，v0.2.0 兼容）createTelegramInbound 实例；可为 null
 * @param {object[]} [deps.interactive] - 交互渠道实例列表（v0.3.0 多通道入口；提供时优先于 deps.telegram）。
 *   每项实现统一契约（channel/notifyTargets/sendApprovalCard/editResolved/sendText，
 *   见 inbound/_contract.mjs）；telegram 旧形状（notifyChatIds/editResolved(chatId,messageId,text)）也接受
 * @param {{ mode?: 'observe'|'answer', timeoutMs?: number, numberedReply?: boolean,
 *           parallel?: boolean,
 *           escalation?: { enabled?: boolean, stages?: Array<object> } }} [deps.approvalConfig]
 *   parallel: true：推卡后立即放行 next() 与下游结果竞速、先答先算；缺省 false 排他瀑布。
 * @param {object} [deps.logger]
 * @param {number} [deps.counterStart=随机] - 审批 key 计数器起点。生产随机化（v0.6.4：
 *   重启后 counter 归零 + 同 callId 复现会让旧卡片 token 撞新审批的 key，在 tokenSecret
 *   持久化 + 10min TTL 内可被旧卡误裁决——随机起点把撞 key 概率压到 1e-6 级）；测试传 0
 *   保住 `ap:<callId>:<n>` 的确定性断言。
 * @param {ReturnType<typeof import('../routing/agent-router.mjs').createAgentRouter>} [deps.router]
 *   - v0.3.2 审批分流：request.agent 可解析时，审批只发该 agent 绑定的通道（替代全局广播）。
 *     审批不受 quiet 影响——静音审批 = 审批永远超时回落桌面，违背「沉默永不批准」的可预期性。
 * @returns {() => void} 反注册函数
 */
export function registerApprovalHandler(deps) {
  const { ctx, notifier, bus, vault, store } = deps
  const router = deps.router ?? null
  const approvalConfig = deps.approvalConfig ?? {}
  const mode = approvalConfig.mode === 'answer' ? 'answer' : 'observe'
  const timeoutMs = Math.max(1000, Number(approvalConfig.timeoutMs) || 120000)
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/approval]', message) } catch { /* 日志失败绝不致命 */ }
  }

  // 升级链：主推送无人响应时按 stages 节奏再提醒（answer 模式下与 wait 并行）
  const escalationCfg = (approvalConfig.escalation !== null && typeof approvalConfig.escalation === 'object')
    ? approvalConfig.escalation
    : {}
  const escalationStages = Array.isArray(escalationCfg.stages) && escalationCfg.stages.length > 0
    ? escalationCfg.stages
    : DEFAULT_ESCALATION_STAGES
  const escalation = createEscalationChain({
    stages: escalationCfg.enabled === false ? [] : escalationStages,
    logger: deps.logger,
  })

  let counter = Number.isFinite(deps.counterStart) ? deps.counterStart : Math.floor(Math.random() * 1_000_000)
  // 交互渠道列表（统一契约）：deps.interactive 优先；未提供时回退 v0.2.0 的单 telegram 入口
  const rawInteractive = Array.isArray(deps.interactive)
    ? deps.interactive
    : (deps.telegram !== null && deps.telegram !== undefined ? [deps.telegram] : [])
  const interactive = rawInteractive
    .map((raw) => normalizeInbound(raw))
    .filter((entry) => entry !== null && entry.channel !== '')
  const interactiveByChannel = new Map(interactive.map((entry) => [entry.channel, entry]))
  // v0.6.4：交互渠道名集合（编号回复 intended 兜底用——真实装配里能回话到 bus 的
  // 通道必然在此集合内，广播也必然覆盖它们）
  const interactiveChannels = new Set(interactive.map((entry) => entry.channel))
  // 升级提醒里的按钮渠道提示（无交互渠道时退化为纯编号回复话术）
  const cardChannelNames = interactive
    .map((entry) => DISPLAY_NAMES[entry.channel] ?? entry.channel)
    .join('/')

  const ledger = {
    add(key, row) {
      store.set(key, { ...row, status: 'pending', createdAt: Date.now() })
    },
    get(key) {
      return store.get(key)
    },
    resolve(key, decision) {
      const row = store.get(key)
      if (row === undefined) return false
      store.set(key, { ...row, status: 'resolved', decision, resolvedAt: Date.now() })
      return true
    },
    terminate(key, extra = {}) {
      const row = store.get(key)
      if (row === undefined || row.status !== 'pending') return false
      store.set(key, { ...row, ...extra, status: 'resolved', decision: 'terminated', resolvedAt: Date.now() })
      return true
    },
    /**
     * 最近一条待决审批（编号回复降级用）。匹配优先级：
     *  1) 精确：卡片实际送达过该 (channel,userId)；
     *  2) 同渠道：卡片送达过该 channel（他人代决兜底）；
     *  3) v0.6.4 intended 兜底：该 channel 属于本审批的意图送达渠道（分流解析结果；
     *     全局广播时 = 全部交互渠道）——堵住「卡片发送失败但广播文案教用户回复 1」的死路
     *     （审查 R1-P2-1）。注意 intended 只做 channel 级（广播无用户定向），跨渠道的
     *     非意图渠道（如分流只发 feishu 时 telegram 的日常裸 1）仍拒绝——收紧价值保留。
     */
    latestPendingFor(channel, userId) {
      let exact = null
      let onChannel = null
      let intended = null
      for (const key of store.keys('ap:')) {
        const row = store.get(key)
        if (row?.status !== 'pending') continue
        const pushed = Array.isArray(row.pushedTo) ? row.pushedTo : []
        if (pushed.some((target) => target.channel === channel)) {
          if (onChannel === null || row.createdAt > onChannel.row.createdAt) onChannel = { key, row }
          if (pushed.some((target) => target.channel === channel && String(target.userId) === String(userId))) {
            if (exact === null || row.createdAt > exact.row.createdAt) exact = { key, row }
          }
        }
        if (intended === null && isIntendedChannel(row, channel)) intended = { key, row }
      }
      return exact ?? onChannel ?? intended
    },
  }

  /** v0.6.4：row 的意图渠道判定——intended 数组含该渠道，或 null（全局广播）时任意交互渠道。 */
  function isIntendedChannel(row, channel) {
    if (Array.isArray(row.intendedChannels)) return row.intendedChannels.includes(channel)
    if (row.intendedChannels === null) return interactiveChannels.has(channel)
    return false // 旧版行无此字段：不兜底（从严，升级瞬间的在途审批最多超时回退）
  }

  /**
   * v0.3.2 审批分流：request.agent 有 id 时按 agent 解析链算目标通道集合。
   * 返回 null = 不分流（全局广播，向后兼容）；解析异常同样回落 null。
   */
  function resolveApprovalChannels(request) {
    if (router === null) return null
    const agentId = request?.agent?.id ?? request?.agent?.session?.id ?? null
    if (agentId === null) return null
    try {
      const globalTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
      const { channelTypes } = router.resolveOutbound(String(agentId), workspaceOf(request.agent), globalTypes)
      if (!Array.isArray(channelTypes)) return channelTypes
      // v0.8.4 QQ 渠道别名修复：出站适配器注册名是 'qq-bot'，入站交互渠道名是 'qq'，
      // 两者不同名（同一官方机器人实现的两个投递面，见 INTERACTIVE_ALIASES 注）。
      // 分流结果只含出站名时 planApprovalTargets 会把 qq 交互渠道整体过滤掉——卡片
      // 零发送、pushedTo 恒空、编号回复 intended 兜底失效（裸数字漏进会话路由，
      // 2026-08-23 全天事故链的总根因）。这里把出站名展开为「出站名 + 别名入站名」
      // 并入集合；广播侧未知类型由 notifyAll 自然跳过，无副作用。
      const merged = new Set(channelTypes)
      for (const type of channelTypes) {
        const alias = INTERACTIVE_ALIASES[type]
        if (alias !== undefined) merged.add(alias)
      }
      return [...merged]
    } catch (error) {
      // P1-2 错误可见性（2026-08-20，Trae1，自上游 0.8.6 接力）：路由解析异常与
      // 「空集」同样回落全局广播（fail-safe 投递语义不变），但异常路径原先零日志
      // ——路由子系统坏了会无声地把审批卡广播到全渠道。
      warn(`审批分流解析异常，回落全局广播（路由引擎报错: ${error instanceof Error ? error.message : String(error)}）`)
      return null
    }
  }

  /**
   * v0.8.3 SEC-1：规划本次审批的卡片目标（与推送共用同一份结果，避免 wait 的
   * allowChats 与 pushApproval 各自解析导致的不一致）。返回 Map<channel, kept[]>。
   */
  function planApprovalTargets(channelTypes) {
    const targets = new Map()
    for (const inbound of interactive) {
      if (channelTypes !== null && !channelTypes.includes(inbound.channel)) continue
      // v0.7 形状守卫（计划书 §3.5）：目标进发送前按渠道校验 id 形态——TG 数字 id 混进
      // 飞书目标位这类跨渠道串门在此拦截（warn + skip，不中断其余目标）。
      const { kept, skipped } = guardTargets(inbound.channel, inbound.notifyTargets(), warn)
      if (skipped.length > 0) warn(`形状守卫跳过 ${skipped.length} 个目标（${inbound.channel}）`)
      targets.set(inbound.channel, kept)
    }
    return targets
  }

  async function pushApproval(key, token, request, channelTypes, targetsByChannel) {
    const title = `需要批准：${request.toolName}`
    // v0.8.4 双端提示：并行模式下网页弹窗与远程卡片同问，远程先决时网页弹窗成为
    // 孤儿应答（宿主 api-proxy 无「已解决」广播机制），但迟到点击被首达采纳自然
    // 忽略、无副作用——文案明示用户可随意处置，避免等待/困惑。
    const content = `${request.reason ?? 'agent 请求执行一个需要授权的操作'}\n\n批准将仅对本次调用生效（token 单次核销）。\n双端同问、先答先算：一处裁决后即生效，另一端的网页弹窗/卡片可随意关闭或忽略。`
    const pushedTo = []
    const buttonChannels = []
    const textChannels = []
    // 交互渠道：带按钮卡片（逐通道逐目标推送；单渠道失败降级为纯通知）。
    // v0.3.2 分流：channelTypes 非空时只推解析出的通道（审批不广播到无关 agent 的通道）。
    // v0.6.4 增量落账（审查 R1-P1-1）：pushedTo 原来要等整轮推送（多通道限速门下数秒）
    // 完成才写账——窗口内早到的编号回复读不到送达渠道，裁决落空且裸「1」漏进会话
    // 路由。现在每张卡送达立刻落账，窗口收敛到单卡发送耗时。
    const persistPushed = () => {
      try {
        const row = ledger.get(key)
        if (row !== undefined) store.set(key, { ...row, pushedTo: [...pushedTo] })
      } catch { /* 增量落账失败不致命，末尾还有一次整体落账兜底 */ }
    }
    for (const [channel, kept] of targetsByChannel) {
      const inbound = interactiveByChannel.get(channel)
      if (inbound === undefined) continue
      let anySuccess = false
      for (const target of kept) {
        const card = await inbound.sendApprovalCard({
          chatId: target.chatId,
          title,
          content,
          approvalKey: key,
          token,
        })
        if (card !== null) {
          anySuccess = true
          pushedTo.push({ channel, chatId: target.chatId, userId: target.userId, messageId: card.messageId })
          persistPushed()
        }
      }
      if (anySuccess) {
        const name = DISPLAY_NAMES[channel] ?? channel
        if (inbound.capabilities?.buttons !== false) buttonChannels.push(name)
        else textChannels.push(name)
      }
    }
    // v0.8.4 渠道级去重广播：广播线降级为「未收到卡片的渠道」的兜底（单向渠道、
    // 卡片发送失败场景）。已成功收到卡片的交互渠道，其出站孪生不再重发纯文本——
    // 严格按渠道名逐个判断（仅别名命中 carded 才抑制），不做任何跨平台归并。
    // qq 单渠道拓扑效果：卡片必达 → 广播整体跳过，审批只发一条消息。
    const cardedInteractive = new Set(pushedTo.map((target) => String(target?.channel ?? '')))
    const outboundKnown = new Set(Array.isArray(notifier?.channels) ? notifier.channels : [])
    // ⚠️ 范围声明：广播去重仅测试过 QQ 官方 bot（qq-bot ↔ qq 别名对，同一实现的
    // 出站/入站两个注册面）。其他平台理论可行但未逐一实测，暂不启用——无别名映射的
    // 渠道一律保持上游「卡片+广播」双发行为；后续实测一个平台，把名字对加进
    // INTERACTIVE_ALIASES 即自动纳入去重。
    // 判定不出出站面时（无 router 分流且 notifier 未暴露渠道表——旧式装配/测试台架）
    // 广播目标记为 null = 保持上游行为全量广播，绝不静默跳过。
    const filterDedup = (types) => types.filter((type) => {
      if (outboundKnown.size > 0 && !outboundKnown.has(type)) return false // 出站表可得时，别名展开出的入站名（如 'qq'）不进广播
      const alias = INTERACTIVE_ALIASES[String(type)]
      if (alias === undefined) return true // 无别名映射的渠道：保持上游双发行为
      return !cardedInteractive.has(alias) // 仅 qq 官方 bot：卡片已送达则跳过广播
    })
    let broadcastTargetTypes = null
    if (Array.isArray(channelTypes)) broadcastTargetTypes = filterDedup(channelTypes)
    else if (outboundKnown.size > 0) broadcastTargetTypes = filterDedup([...outboundKnown])
    if (broadcastTargetTypes !== null && broadcastTargetTypes.length === 0) return pushedTo
    // 全渠道通知（含单向渠道；无按钮渠道靠编号回复降级）
    // 按钮渠道提示可点；无按钮渠道提示编号回复——单向广播渠道（bark 等）同样
    // 依赖「回复 1 批准 / 2 拒绝」兜底，因此按钮场景也保留该提示（v0.2.0 文案契约）。
    const channelNotes = []
    if (buttonChannels.length > 0) channelNotes.push(`${buttonChannels.join('、')} 已发可点按钮`)
    if (textChannels.length > 0) channelNotes.push(`${textChannels.join('、')} 已发审批通知`)
    await notifier.notifyAll({
      title,
      content: channelNotes.length > 0
        ? `${content}\n\n（${channelNotes.join('；')}；无按钮渠道可回复 1 批准 / 2 拒绝）`
        : `${content}\n\n（本渠道无按钮：回复 1 批准 / 2 拒绝）`,
      level: 'timeSensitive',
    }, broadcastTargetTypes !== null ? { channelTypes: broadcastTargetTypes } : {}).catch(() => {})
    return pushedTo
  }

  async function markRemoteResolved(pushedTo, text) {
    for (const target of pushedTo ?? []) {
      const inbound = interactiveByChannel.get(target.channel)
      if (inbound === undefined) continue
      await inbound.editTarget(target, text)
    }
  }

  // 编号回复降级（无按钮渠道）：白名单用户回复 1/2 核销最近一条待决审批。
  // v0.6.3 返回 true = 消息已被审批消费——bus 据此停止扇出，同一消息不再进对话路由
  // （原实现「1」既批准审批又被当作用户消息 inject 进 agent 会话，消息污染）。
  function handleNumberedReply(envelope) {
    if (approvalConfig.numberedReply === false) return false
    const choice = String(envelope.text ?? '').trim()
    if (choice !== '1' && choice !== '2') return false
    const pending = ledger.latestPendingFor(envelope.channel, envelope.userId)
    if (pending === null) return false
    const decision = choice === '1' ? OUTCOME_ALLOWED : OUTCOME_REJECTED
    const verdict = bus.decideTrusted({
      approvalKey: pending.key,
      decision,
      via: `${envelope.channel}:reply`,
      userId: envelope.userId,
    })
    if (verdict.ok) {
      warn(`编号回复裁决 ${pending.key} → ${decision}（user ${envelope.userId}）`)
      return true
    }
    // v0.8.3 E-2：已决竞态（首达采纳/超时已 settle，账本暂未翻终态）——消费 + 回执，
    // 不把裸 '1'/'2' 漏进对话路由（对齐 questions/router.mjs:316-318 既有姿态）。
    const inbound = interactiveByChannel.get(envelope.channel)
    if (inbound !== undefined) {
      void inbound.sendText(envelope.chatId, '该审批已被处理（首达采纳，此次回复无效）').catch(() => {})
    }
    warn(`编号回复落空 ${pending.key}（已决竞态，user ${envelope.userId}）`)
    return true
  }

  // v0.8.4 按钮裁决（QQ INTERACTION_CREATE 显式 key）：envelope.approvalAction 由
  // qq-gw 从 button_data「ap:<decision>:<approvalKey>:<token>」（契约协议，与
  // telegram/飞书同构）解析注入。与编号回复的本质区别：key+token 是卡片发送时写进
  // 按钮的精确值，不做「最近待决」隐式匹配——多行并存、僵尸行、并行竞速都不会再
  // 劫持目标（2026-08-23 事故根治）。安全链路：
  //   WS 事件 → bus.accept 身份门（绑定/白名单）→ 此处 pushedTo 用户级校验（群内
  //   防代点）→ bus.decide 的 HMAC token 验签 + allowChats 会话级校验 → 首达采纳。
  function handleApprovalAction(envelope) {
    let action = envelope?.approvalAction
    // v0.8.4 文本形态兜底：指令按钮/旧客户端会把按钮 data 当文本消息发出（2026-08-23
    // 实测：action.type=2 的点击以「ap:<decision>:<key>:<token>」文本到达）。能完整
    // 解析为契约负载的文本按同一裁决路径处理；安全不变——仍过 token 验签 + 接收人 +
    // allowChats。普通聊天几乎不可能以 ap: 开头且四段结构合法，误伤可忽略。
    if ((action === null || action === undefined) && typeof envelope?.text === 'string' && envelope.text.startsWith('ap:')) {
      const parsed = parseApprovalAction(envelope.text.trim())
      if (parsed !== null) {
        action = { decision: parsed.decision, approvalKey: parsed.approvalKey, token: parsed.token }
        warn(`文本形态按钮负载已受理（${envelope.channel} user ${envelope.userId}）`)
      }
    }
    if (action === null || typeof action !== 'object') return false
    const key = String(action.approvalKey ?? '')
    const decision = action.decision === OUTCOME_ALLOWED ? OUTCOME_ALLOWED
      : action.decision === OUTCOME_REJECTED ? OUTCOME_REJECTED : null
    if (key === '' || decision === null) return false
    const receipt = (text) => {
      const inbound = interactiveByChannel.get(envelope.channel)
      if (inbound === undefined) return
      void inbound.sendText(envelope.chatId, text).catch(() => {})
    }
    const row = ledger.get(key)
    if (row === undefined || row.status !== 'pending') {
      warn(`按钮裁决落空 ${key}（状态 ${row?.status ?? '无此行'}，user ${envelope.userId}）`)
      receipt('该审批已被处理或已失效，此次点击无效')
      return true
    }
    // 用户级校验：卡片送达记录里有明确接收人时，仅接收人可裁决（群场景防他人代点；
    // 单聊天然匹配）。pushedTo 为空（增量落账窗口）时跳过——allowChats 仍在兜底。
    const targets = Array.isArray(row.pushedTo) ? row.pushedTo.filter((t) => t?.channel === envelope.channel) : []
    if (targets.length > 0 && !targets.some((t) => String(t.userId) === String(envelope.userId))) {
      warn(`按钮裁决拒绝 ${key}：点击者 ${envelope.userId} 非接收人`)
      receipt('仅审批接收人可点击裁决')
      return true
    }
    const verdict = bus.decide({
      approvalKey: key,
      decision,
      token: typeof action.token === 'string' ? action.token : undefined,
      via: `${envelope.channel}:button`,
      userId: envelope.userId,
      chatId: envelope.chatId,
    })
    if (verdict.ok) {
      warn(`按钮裁决 ${key} → ${decision}（user ${envelope.userId}）`)
      return true
    }
    warn(`按钮裁决落空 ${key}（${verdict.reason ?? 'unknown'}，user ${envelope.userId}）`)
    receipt('该审批已被处理或已失效，此次点击无效')
    return true
  }

  const disposeApprovalAction = bus.onMessage(handleApprovalAction)
  const disposeMessage = bus.onMessage(handleNumberedReply)

  const handler = async (request, next) => {
    const key = `ap:${request?.callId ?? request?.toolName ?? 'unknown'}:${(counter += 1)}`
    try {
      const token = vault.mint(key)
      // 分流一次解析、全程复用（v0.6.4：pushApproval 落账与升级链共用同一份结果，
      // 原二处各自 resolve 在 agent 绑定轮转瞬间可能不一致）。
      const resolved = resolveApprovalChannels(request)
      // v0.6.5（审查 R4-1-P3-5）：空集回落全局广播——agent 显式绑定空集或绑定渠道
      // 全被全局池剔除时，原实现零卡零广播，审批 120s 无感知超时（安全侧自洽但用户
      // 完全不知道为何「卡死」）。intendedChannels 同步记 null，与实际广播语义一致。
      const channelTypes = Array.isArray(resolved) && resolved.length > 0 ? resolved : null
      if (channelTypes === null && resolved !== null) {
        warn('审批分流解析为空集，回落全局广播（检查该 agent 的路由绑定与全局渠道池）')
      }
      ledger.add(key, {
        mode,
        toolName: request?.toolName ?? '(unknown)',
        agentId: request?.agent?.id ?? request?.agent?.session?.id ?? null,
        pushedTo: [],
        // v0.6.4（审查 R1-P2-1）：意图渠道入账——null = 全局广播（= 全部交互渠道），
        // 数组 = 分流结果。编号回复 intended 兜底据此判定「广播教了回复 1 但卡片没送达」。
        intendedChannels: channelTypes,
      })
      // v0.6.3 waiter 预注册（审查 R2 P1-1）：原实现先 await pushApproval（逐通道逐目标
      // 发卡 + 广播，限速门下数秒级）再 bus.wait——窗口内用户点按钮/回复 1/2 会命中
      // already-resolved 被静默丢弃，此后永远无人能裁决 → 超时回落桌面。先注册 waiter
      // 再推卡，早到的裁决由 waiter 承接（超时计时从推卡开始，含推送耗时，语义可接受）。
      // v0.8.3 SEC-1：wait 同时登记允许会话范围（allowChats），bus.decide 据此校验按钮来源。
      const targetsByChannel = planApprovalTargets(channelTypes)
      const allowChats = new Map()
      for (const [channel, kept] of targetsByChannel) {
        if (kept.length === 0) continue
        allowChats.set(channel, new Set(kept.map((target) => String(target.chatId))))
      }
      const waitOptions = {
        agentId: request?.agent?.id ?? request?.agent?.session?.id ?? null,
        onAbandon: () => { try { ledger.terminate(key) } catch { } },
        allowChats,
      }
      const decisionPromise = mode === 'answer' ? bus.wait(key, timeoutMs, waitOptions) : null
      const pushedTo = await pushApproval(key, token, request, channelTypes, targetsByChannel)
      const row = ledger.get(key)
      if (row !== undefined && row.status === 'pending') {
        store.set(key, { ...row, pushedTo })
      }
      if (ledger.get(key)?.decision === 'terminated') {
        await markRemoteResolved(pushedTo, '⏹ 已终止：agent 会话已结束，审批取消')
        return next()
      }

      if (mode !== 'answer') {
        return next() // observe：只旁观，桌面照常决定
      }

      // —— parallel 并行分支：立即放行 next()，与远程 wait 竞速、先答先算 ——
      // 桌面先行：abandon 撤销 waiter（迟到回复已决拒收）+ terminate 防悬挂 pending；
      // 远程先行：直接返回裁决；远程窗口先关：改交还文案，继续等桌面。安全红线不变。
      if (approvalConfig.parallel === true) {
        const parallelStartedAt = Date.now()
        escalation.start(key, (_key, stage) => {
          notifier.notifyAll({
            title: `${request?.toolName ?? '操作'} 仍在等待批准`,
            content: `${stage.note ?? '仍在等待批准'}（已等待 ${Math.round((Date.now() - parallelStartedAt) / 1000)}s）。\n回复 1 批准 / 2 拒绝${cardChannelNames !== '' ? `，或点击 ${cardChannelNames} 卡片按钮` : ''}。`,
            level: stage.level ?? 'timeSensitive',
          }, channelTypes !== null ? { channelTypes } : {}).catch(() => {})
        })
        const desktopAsk = Promise.resolve().then(() => next())
        desktopAsk.catch(() => {}) // 下游结果在竞速中消费；提前挂 catch 防未处理拒绝
        const outcome = await new Promise((resolveRace) => {
          let done = false
          const finish = (value) => { if (!done) { done = true; resolveRace(value) } }
          decisionPromise.then((decision) => {
            if (done) return
            if (decision !== null) return finish({ kind: 'remote', decision })
            // 远程窗口关闭（超时或会话终止）：停升级链、改卡片文案，继续等桌面
            escalation.stop(key)
            if (ledger.get(key)?.decision === 'terminated') {
              void markRemoteResolved(pushedTo, '⏹ 已终止：agent 会话已结束，审批取消').catch(() => {})
            } else {
              ledger.resolve(key, 'timeout')
              void markRemoteResolved(pushedTo, '⏱ 手机端等待超时：请到桌面/Web 处理（手机按钮已失效）').catch(() => {})
            }
          })
          desktopAsk.then(
            (result) => finish({ kind: 'desktop', result }),
            (error) => {
              // 下游应答器抛错：按无裁决处理（undefined 透传），不吞日志
              warn(`桌面/下游应答器异常: ${error instanceof Error ? error.message : String(error)}`)
              finish({ kind: 'desktop', result: undefined })
            },
          )
        })
        escalation.stop(key)
        if (outcome.kind === 'remote') {
          ledger.resolve(key, outcome.decision.decision)
          await markRemoteResolved(pushedTo, outcome.decision.decision === OUTCOME_ALLOWED ? '✅ 已远程批准（本次）' : '❌ 已远程拒绝')
          warn(`${key} 并行裁决：${outcome.decision.decision}（via ${outcome.decision.via}；桌面询问已先行发出，迟到操作按已决忽略）`)
          return outcome.decision.decision
        }
        // 桌面/下游先行：撤销远程 waiter（迟到回复→already-resolved），账本翻终态防悬挂 pending
        try { bus.abandon?.(key, 'desktop-first') } catch { /* waiter 不存在亦无妨 */ }
        try { ledger.terminate(key) } catch { /* 账本失败不致命 */ }
        warn(`${key} 桌面/下游先行裁决，远程等待已撤销`)
        await markRemoteResolved(pushedTo, '🖥️ 已在桌面处理（手机按钮已失效）')
        return outcome.result
      }

      // 升级链与 wait 并行：每到一个 stage 再推一轮更高 level 提醒
      const startedAt = Date.now()
      escalation.start(key, (_key, stage) => {
        notifier.notifyAll({
          title: `${request?.toolName ?? '操作'} 仍在等待批准`,
          content: `${stage.note ?? '仍在等待批准'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）。\n回复 1 批准 / 2 拒绝${cardChannelNames !== '' ? `，或点击 ${cardChannelNames} 卡片按钮` : ''}。`,
          level: stage.level ?? 'timeSensitive',
        }, channelTypes !== null ? { channelTypes } : {}).catch(() => {})
      })

      const decision = await decisionPromise
      escalation.stop(key)
      if (ledger.get(key)?.decision === 'terminated') {
        await markRemoteResolved(pushedTo, '⏹ 已终止：agent 会话已结束，审批取消')
        return next()
      }
      if (decision === null) {
        ledger.resolve(key, 'timeout')
        await markRemoteResolved(pushedTo, '⏱ 超时未响应：已交还桌面处理（按钮失效）')
        return next() // 静默永不批准
      }
      ledger.resolve(key, decision.decision)
      await markRemoteResolved(pushedTo, decision.decision === OUTCOME_ALLOWED ? '✅ 已远程批准（本次）' : '❌ 已远程拒绝')
      warn(`${key} 裁决：${decision.decision}（via ${decision.via}）`)
      return decision.decision
    } catch (error) {
      // A listener never throws：任何异常交还桌面
      warn(`处理器异常，交还桌面: ${error instanceof Error ? error.message : String(error)}`)
      try { escalation.stop(key) } catch { /* 升级链清理不致命 */ }
      try { ledger.resolve(key, 'error') } catch { /* 账本失败不致命 */ }
      return next()
    }
  }

  const disposeApproval = ctx.on('approval/request', handler)
  return () => {
    disposeApproval?.()
    disposeApprovalAction?.()
    disposeMessage?.()
    escalation.dispose()
  }
}
