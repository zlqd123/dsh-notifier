// 真实 HTTP 端到端：用插件 resolve + signHmac 签一个请求，POST 到运行中的网关，
// 验证 Node 签名被 Python 网关验签接受（金标准）。需先手动起网关（_e2e_config.yaml, :18100）。
// 运行：node tests/test_hmac_e2e.mjs

import { resolve, signHeaders } from '../src/adapters/qq-bot.mjs'
import { readFileSync } from 'node:fs'

const GW = 'http://127.0.0.1:18100'
// 真实密钥只从本地 keys.conf 读取（运行时），测试代码/仓库里绝不写任何真实 secret。
// 默认路径可用 NOTI_KEYS_FILE 覆盖；dsh 对应行必须是 kind=hmac。
const KEYS_FILE = process.env.NOTI_KEYS_FILE || 'D:/tool/deepseek/workspace2/noti-gateway/keys.conf'
const SECRET = (() => {
  const lines = readFileSync(KEYS_FILE, 'utf8').split('\n')
  for (const line of lines) {
    const s = line.trim()
    if (s.startsWith('#') || !s) continue
    const [id, secret, ...rest] = s.split(/\s+/)
    if (id === 'dsh' && rest.includes('kind=hmac')) return secret
  }
  throw new Error(`keys.conf 里找不到 dsh 的 hmac 行: ${KEYS_FILE}`)
})()

let failed = 0
function check(cond, name) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}

async function sendSigned({ secret, keyId, source, body, nonce, ts }) {
  const path = `/n/${encodeURIComponent(source)}`
  const url = `${GW}${path}`
  const h = signHeaders(secret, keyId, { method: 'POST', path, body, ts, nonce })
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-source': source, ...h },
    body,
  })
  return r.status
}

console.log('\n[真实 HTTP e2e] Node 插件签名 → Python 网关验签')
const body = JSON.stringify({ title: 'e2e', body: 'from-plugin', level: 'info' })
const now = Math.floor(Date.now() / 1000)

// 1. 合法签名 -> 202
let s = await sendSigned({ secret: SECRET, keyId: 'dsh', source: 'dsh', body, nonce: 'e2e-n1', ts: now })
check(s === 202, `合法 HMAC 签名 -> 202 (实际 ${s})`)

// 2. 同 nonce 重放 -> 401
s = await sendSigned({ secret: SECRET, keyId: 'dsh', source: 'dsh', body, nonce: 'e2e-n1', ts: now })
check(s === 401, `同 nonce 重放 -> 401 (实际 ${s})`)

// 3. 错误密钥 -> 401
s = await sendSigned({ secret: 'wrong-secret-000', keyId: 'dsh', source: 'dsh', body, nonce: 'e2e-n2', ts: now })
check(s === 401, `错误密钥 -> 401 (实际 ${s})`)

// 4. 换体（签名 body 与实际 body 不同）-> 401
{
  const path = '/n/dsh'
  const signed = signHeaders(SECRET, 'dsh', { method: 'POST', path, body: '{"x":1}', ts: String(now), nonce: 'e2e-n3' })
  const r = await fetch(`${GW}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-source': 'dsh', ...signed },
    body,
  })
  check(r.status === 401, `换体 -> 401 (实际 ${r.status})`)
}

// 5. 旧 token 通道已删（不带签名一律 401）
{
  const r = await fetch(`${GW}/n/ci`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer e2e-old-token', 'x-source': 'ci' },
    body,
  })
  check(r.status === 401, `无签名旧 token 调用 -> 401 (实际 ${r.status})`)
}

// 6. 无凭据 -> 401
{
  const r = await fetch(`${GW}/n/dsh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  })
  check(r.status === 401, `无凭据 -> 401 (实际 ${r.status})`)
}

// 7. resolve 归一化：填 gatewaySecret 即签名，缺省 keyId 回退 source
{
  const r = resolve({ gatewayUrl: GW, gatewaySecret: SECRET, gatewaySource: 'dsh' })
  check(r.gatewaySecret === SECRET && r.gatewayKeyId === 'dsh', 'resolve 保留 secret、keyId 回退 source')
  const r2 = resolve({ gatewayUrl: GW, gatewayToken: 'tok' })
  check(r2.gatewaySecret === '' && r2.gatewayKeyId === '', '无 secret 时回退 token 通道')
}

console.log('\n' + '='.repeat(54))
if (failed > 0) {
  console.log(`FAILED (${failed})`)
  process.exit(1)
}
console.log('ALL TESTS PASSED')
