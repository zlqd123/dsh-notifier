// 热更新证明：向 keys.conf 追加新密钥后，运行中的网关无需重启即接受该密钥签名。
import { signHeaders } from '../src/adapters/qq-bot.mjs'

const GW = 'http://127.0.0.1:18100'
const NEW_SECRET = 'ff00aa11bb22cc33dd44ee55ff66aa7788990011223344556677889900aabbcc'

const body = JSON.stringify({ title: 'hot-reload', body: 'new-key', level: 'info' })
const path = '/n/hot'
const h = signHeaders(NEW_SECRET, 'hot', { method: 'POST', path, body, ts: String(Math.floor(Date.now() / 1000)), nonce: 'hot-' + Date.now() })
const r = await fetch(`${GW}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-source': 'hot', ...h },
  body,
})
console.log(`热更新密钥签名 -> ${r.status} (期望 202，证明改文件免重启即生效)`)
process.exit(r.status === 202 ? 0 : 1)
