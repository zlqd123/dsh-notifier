#!/usr/bin/env node
// dsh-notifier-gate 工具：经统一通知网关（noti-gateway）发送任意文件/图片（富媒体）。
//
// 与纯文本一样，出站【一律经网关】转发，插件不直连 QQ 官方 API：
//   小件（≤8MB）：POST {gateway}/n/{source}  内联 {b64,mime,name}
//   大件（>8MB）：先走网关分片收件三步拿到 ref，再用 {ref} 引用通知：
//     POST {gateway}/u/init                  {name,mime,kind,size} -> {upload_id,chunk_size,chunks}
//     POST {gateway}/u/{upload_id}/part/{i}  原始字节（HMAC 对原始体签名）
//     POST {gateway}/u/{upload_id}/complete  -> {ref}
//   >10MB 的媒体由网关侧自动走 QQ 分片协议（upload_prepare/PUT/part_finish/merge）。
//
// 用法（凭据只走环境变量，绝不写进代码）：
//   GATEWAY_URL=<网关地址> GATEWAY_SECRET=<hmac密钥> [GATEWAY_KEY_ID=<key_id>] \
//     [GATEWAY_SOURCE=<source>] node tools/send-file.mjs <文件路径> [附言]
// 可选：--chunk 强制走分片收件（调试用）；--kind image|file 强制媒体类型。
// 图片快捷方式见 tools/send-image.mjs（同参数，kind 固定 image）。

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, createHmac, randomBytes } from 'node:crypto'

const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
const FILE_MIME = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip', '.json': 'application/json', '.log': 'text/plain' }
const INLINE_MAX = 8 * 1024 * 1024 // 内联上限（网关 MAX_BODY 16MB，base64 后 ~10.7MB）

function die(msg) {
  console.error(`[send-file] ${msg}`)
  process.exit(1)
}

/** HMAC v1 签名（与 src/adapters/qq-bot.mjs 的 signHeaders 同契约，对原始字节也成立）。 */
function sign(secret, keyId, method, path, body) {
  const bodyHex = createHash('sha256').update(body).digest('hex')
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  const canonical = [method.toUpperCase(), path, ts, nonce, bodyHex].join('\n')
  const sig = 'v1=' + createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
  return {
    'x-noti-signature': sig,
    'x-noti-timestamp': ts,
    'x-noti-nonce': nonce,
    'x-noti-content-sha256': bodyHex,
    ...(keyId ? { 'x-noti-key-id': keyId } : {}),
  }
}

async function toJson(r) {
  try { return await r.json() } catch { return null }
}

export async function runSend(forceKind) {
  const args = process.argv.slice(2).filter((a) => a !== '--chunk')
  const forceChunk = process.argv.includes('--chunk')
  const kindArgIdx = process.argv.findIndex((a) => a === '--kind')
  const kindArg = kindArgIdx >= 0 ? (process.argv[kindArgIdx + 1] || '') : ''
  const filePath = args.find((a) => !a.startsWith('-') && a !== kindArg)
  const note = args.filter((a) => !a.startsWith('-') && a !== filePath && a !== kindArg).join(' ').trim()

  if (!filePath) die('用法: node tools/send-file.mjs <文件路径> [附言]（环境变量见文件头注释）')
  const gateway = (process.env.GATEWAY_URL || '').trim().replace(/\/+$/, '')
  const secret = (process.env.GATEWAY_SECRET || '').trim()
  const source = (process.env.GATEWAY_SOURCE || 'dsh').trim()
  const keyId = (process.env.GATEWAY_KEY_ID || source).trim()
  if (!gateway) die('缺少环境变量 GATEWAY_URL（网关地址）')
  if (!secret) die('缺少环境变量 GATEWAY_SECRET（HMAC 密钥）')

  const bytes = await readFile(filePath)
  const name = basename(filePath)
  const ext = extname(name).toLowerCase()
  let kind = forceKind || kindArg || (IMAGE_MIME[ext] ? 'image' : 'file')
  if (kind !== 'image' && kind !== 'file') die(`--kind 只支持 image|file（收到 ${kind}）`)
  const mime = (kind === 'image' ? IMAGE_MIME[ext] : (IMAGE_MIME[ext] || FILE_MIME[ext])) || 'application/octet-stream'
  if (kind === 'image' && !IMAGE_MIME[ext]) die(`不是支持的图片类型 ${ext || '(无扩展名)'}，支持: ${Object.keys(IMAGE_MIME).join(' ')}`)

  const api = async (path, { method = 'POST', body = Buffer.alloc(0), json, headers = {}, timeoutMs = 30000, soft = false } = {}) => {
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json), 'utf8') : body
    const r = await fetch(`${gateway}${path}`, {
      method,
      headers: {
        ...sign(secret, keyId, method, path, payload),
        ...(json !== undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }),
        ...headers,
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const out = await toJson(r)
    if (!r.ok) {
      const msg = `${method} ${path} HTTP ${r.status}: ${JSON.stringify(out)?.slice(0, 200)}`
      if (soft) throw new Error(msg)
      die(msg)
    }
    return out
  }

  // 决定走内联还是分片收件
  let media
  let mode
  if (bytes.length <= INLINE_MAX && !forceChunk) {
    media = { b64: bytes.toString('base64'), mime, name }
    mode = 'inline'
  } else {
    const init = await api('/u/init', { json: { name, mime, kind, size: bytes.length } })
    const { upload_id: uploadId, chunk_size: chunkSize, chunks } = init
    for (let i = 0; i < chunks; i++) {
      const part = bytes.subarray(i * chunkSize, (i + 1) * chunkSize)
      let lastErr = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await api(`/u/${uploadId}/part/${i}`, { method: 'POST', body: part, timeoutMs: 300000, soft: true })
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          process.stderr.write(`[send-file] 分片 ${i + 1}/${chunks} 第 ${attempt} 次失败: ${e?.message || e}\n`)
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      if (lastErr) throw lastErr
      process.stderr.write(`[send-file] 分片 ${i + 1}/${chunks} ok\n`)
    }
    const done = await api(`/u/${uploadId}/complete`, { json: {} })
    media = { ref: done.ref }
    mode = `chunked(${chunks}片)`
  }

  const lines = note.split('\n')
  const title = (lines[0] ?? '').trim().slice(0, 100)
  const bodyText = lines.slice(1).join('\n').trim()
  const payload = { title, body: bodyText, [kind]: media }
  await api(`/n/${encodeURIComponent(source)}`, { json: payload })
  console.log(JSON.stringify({ ok: true, mode, kind, name, size: bytes.length, ref: media.ref ?? null }))
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  runSend().catch((e) => die(e?.stack || String(e)))
}
