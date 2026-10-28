// dsh-notifier-gate adapter: qq-bot（QQ 官方机器人，一律经 noti-gateway 投递）
// 出站唯一路径 = 统一通知网关（noti-gateway）：POST {gatewayUrl}/n/{source}，
// 汇入统一配额池（落盘+重试+死信+多工具共享）。
// 直连 QQ 官方 API（换 access_token → /v2/.../messages）的整条路径已移除：
// 不再有"网关失败静默回退直连"的第二条链路——网关失败即本条失败，行为可预期。
// 入站（WS 网关 + 编号回复）仍由 inbound/qq-gw.mjs 负责，与出站无关。

import { postJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'qq-bot'

/** 校验并归一化配置。
 *  **一律走网关**：本副本只支持 noti-gateway 投递，不再有直连 QQ 官方 API 的路径。
 *  gatewayUrl + gatewayToken 是唯一必需项；appId/appSecret/userId 等直连凭据
 *  仅为兼容旧配置而保留在返回对象里（入站网关仍需 appId/appSecret），出站不再使用。 */
export function resolve(cfg = {}) {
  const gatewayUrl = str(cfg.gatewayUrl).replace(/\/+$/, '')
  const gatewayToken = str(cfg.gatewayToken)
  const gatewaySource = str(cfg.gatewaySource) || 'dsh'
  const appId = str(cfg.appId)
  const appSecret = str(cfg.appSecret)
  const targetType = str(cfg.targetType) === 'user' ? 'user' : 'group'
  const targetId = str(targetType === 'user' ? cfg.userId : cfg.groupId)
  const missing = []
  // 仅网关模式：直连凭据不再参与出站校验（它们对入站网关仍然必要，由 inbound 侧校验）
  if (gatewayUrl === '') missing.push('gatewayUrl（noti-gateway 地址，如 http://host:10086）')
  if (gatewayToken === '') missing.push('gatewayToken（noti-gateway 的 auth.token）')
  if (missing.length > 0) {
    throw new NotifyError(`qq-bot 未配置：${missing.join('、')} 未填写（本插件出站一律走 noti-gateway）`, ERROR_CODES.NOT_CONFIGURED)
  }
  return {
    gatewayUrl,
    gatewayToken,
    gatewaySource,
    // 直连凭据仅保留给「兼容旧配置读取」与入站，不再驱动出站投递
    appId,
    appSecret,
    targetType,
    targetId,
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 经统一网关（noti-gateway）投递纯推送：汇入统一配额池（落盘+重试+死信）。
 *  成功返回 true；失败打 stderr 日志并返回 false，由调用方回退直连。 */
async function sendViaGateway(resolved, msg) {
  const text = msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content
  const lines = text.split('\n')
  const title = (lines[0] ?? '').trim().slice(0, 100) || '(无标题)'
  const body = lines.slice(1).join('\n').trim()
  try {
    await postJson(`${resolved.gatewayUrl}/n/${encodeURIComponent(resolved.gatewaySource)}`, {
      title,
      body,
    }, {
      headers: { authorization: `Bearer ${resolved.gatewayToken}`, 'x-source': resolved.gatewaySource },
      timeoutMs: resolved.timeoutMs,
      channel: 'qq-bot',
    })
    return true // postJson 非 2xx/网络异常会抛 NotifyError，能走到这里即投递成功（202 入队/200 同步）
  } catch (error) {
    try {
      console.error(`[dsh-notifier-gate:qq-bot] 网关投递失败: ${error instanceof Error ? error.message : String(error)}`)
    } catch { /* stderr 不可用不致命 */ }
    throw error instanceof Error ? error : new NotifyError('qq-bot 网关投递失败', ERROR_CODES.NETWORK_ERROR)
  }
}

/** 发送主动消息——**一律经统一网关**（noti-gateway）：汇入统一配额池（落盘+重试+死信）。
 *  直连 QQ 官方 API 的路径已整体移除：网关失败即本条失败（不再静默回退直连，
 *  避免"看起来发出去了、其实是另一条链路"的不可预期）。 */
export async function send(resolved, msg) {
  await sendViaGateway(resolved, msg)
}
