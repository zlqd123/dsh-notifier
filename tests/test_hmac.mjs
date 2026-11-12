// 跨语言验签对拍：Node 签出的签名必须与 Python 网关（noti_gateway/auth.py）算法逐字节一致。
// 黄金向量由网关侧 Python 计算得到（tests/test_auth.py 同源算法），此处断言 Node 复现同一结果。
// 运行：node tests/test_hmac.mjs

import { signHeaders } from '../src/adapters/qq-bot.mjs'

const SECRET = 'test-dsh-secret-do-not-use-000000000000000000000000000000'
const KEY_ID = 'dsh'
const METHOD = 'POST'
const PATH = '/n/dsh'
const TS = '1700000000'
const NONCE = 'abc123def456'
const BODY = '{"title":"t","body":"b"}'

// Python 网关侧黄金期望（sha256(body) 与 v1=HMAC(...) 的 hex）
const EXPECT_BODY_HEX = 'b87d9318eb11adbb63bb25464b6d5b65c5f20abba5b015d070a049f09ba9f1c0'
const EXPECT_SIG = 'v1=3db2ea9b918f933471922aaf1c520cdba7a632233ec9144976e628d46c66092b'

let failed = 0
function check(cond, name) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}

const h = signHeaders(SECRET, KEY_ID, { method: METHOD, path: PATH, body: BODY, ts: TS, nonce: NONCE })

console.log('\n[跨语言对拍] Node 签名 vs Python 网关黄金向量')
check(h['x-noti-content-sha256'] === EXPECT_BODY_HEX, `body sha256 一致 (实际 ${h['x-noti-content-sha256']})`)
check(h['x-noti-signature'] === EXPECT_SIG, `HMAC 签名一致 (实际 ${h['x-noti-signature']})`)
check(h['x-noti-timestamp'] === TS, 'timestamp 透传')
check(h['x-noti-nonce'] === NONCE, 'nonce 透传')
check(h['x-noti-key-id'] === KEY_ID, 'key-id 透传')

console.log('\n' + '='.repeat(54))
if (failed > 0) {
  console.log(`FAILED (${failed})`)
  process.exit(1)
}
console.log('ALL TESTS PASSED')
