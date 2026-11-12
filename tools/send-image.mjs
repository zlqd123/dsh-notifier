#!/usr/bin/env node
// dsh-notifier-gate 工具：经统一通知网关（noti-gateway）发送图片（富媒体 msg_type 由网关落 QQ）。
//
// 插件不直连 QQ 官方 API——图片同样走网关转发：
//   小件（≤8MB）内联 {b64,...}，大件先走网关分片收件 /u/* 拿 ref；
//   >10MB 由网关侧自动走 QQ 分片协议。实现见 tools/send-file.mjs（本文件是 kind=image 的薄封装）。
//
// 用法（凭据只走环境变量，绝不写进代码）：
//   GATEWAY_URL=<网关地址> GATEWAY_SECRET=<hmac密钥> [GATEWAY_KEY_ID=<key_id>] \
//     [GATEWAY_SOURCE=<source>] node tools/send-image.mjs <图片路径> [附言]
// 可选：--chunk 强制走分片收件（调试用）。

import { runSend } from './send-file.mjs'

runSend('image').catch((e) => {
  console.error(`[send-image] ${e?.stack || String(e)}`)
  process.exit(1)
})
