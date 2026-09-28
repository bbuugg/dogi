/**
 * RDP 本地桥（RDCleanPath 协议）端到端验证。
 *
 * 隔离 Electron 实例（独立 userData）+ CDP 驱动真主进程 + 进程内假 RDP 服务器：
 * 1. 假 RDP 服务器：net 监听 → 读客户端 X.224 连接请求并回确认 → 同一连接 STARTTLS
 *    升级为 TLS 服务端 → 明文回显；
 * 2. 手工构造 DER 编码的 RDCleanPath 请求（与 ironrdp-wasm 客户端同构），经
 *    rdp:open 返回的 wsUrl 直连本地桥，断言：
 *    - 应答同构：version 3390 / X.224 确认原样回传 / 服务器证书链 / server_addr；
 *    - 透传：WS→TLS→回声字节一致（含中文与 4KB 随机块）；
 *    - 安全基线：URL 随机 token 之外的路径连不上；destination 与桥固定目标不符、
 *      脏数据首包 —— 都回错误 PDU 且不触碰目标服务器；
 * 3. rdp:open 幂等 / 目标 host:port 全部取自主机配置（非法端口兜底 3389）/ 未知主机
 *    与 ssh 类型主机被拒；rdp:credentials 返回解密凭据（端口与桥同口径）；rdp:close 后
 *    端口关闭；rdp:wasm 返回有效 wasm 字节。
 * 4. 证书兼容降级：第二台假服务器用 keyUsage 只有 keyEncipherment（缺 digitalSignature）
 *    的证书 —— BoringSSL 默认握手会被 KEY_USAGE_BIT_INCORRECT 掐断，桥必须自动降级
 *    TLS 1.2 静态 RSA 套件重试并完成握手（对端收到两次连接 + 主机日志留痕）。
 *
 * 跑：node scripts/verify-rdp-bridge.mjs（项目根目录执行，需先 npm run build ）
 * ⚠️ 两份自签证书都是「一次性测试固件」（长有效期），仅用于 127.0.0.1 回环验证。
 * ⚠️ 桥对目标 TLS 不做校验（rejectUnauthorized: false 属 RDCleanPath 设计），
 *    证书链回传由 WASM 客户端自己判定 —— 这里只断言链路完整。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomBytes, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const CDP_PORT = 9339
const RDP_PORT = 29389
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-rdp-bridge-cdp')

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 测试固件：假 RDP 服务器自签证书（仅 127.0.0.1 回环，测试专用） ----------
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCN0eEUyKsokEYW
h2UfCJZt5iu7Z8thkoJ1HU0P00GkjNs/If3GqNoDrc/B9eb66VUjLdv/XYPccuyW
ilI/AuoKgKfVPoXmt7gsIFVWvX5kBhTAGO4r1L1fqN1/mjmNRQRtsFOfMel8Q4sf
afy1OWU7rl8a/FcFc1mZqK8T2OnVc/0zy+ZtyM46QSwtndoBl2Blk7iQWP7S0tXV
pDqciOWBLBOARU+Bud9NqIqggSfpF52RS+yo1O3xlmm/P590xuZTjIe2f69HD3PC
QBNIN7UjGGeS71gwaxKQfpZY9t+xMaYb9ppaBbWfj8PHL8XmRP8Sx9qnLWyWtEa8
wUETiV6tAgMBAAECggEAAZIvoiFO9BYVEK7TSfK4Z+NC3MKbmCsdUtrOPbyjX4VH
8H0Z6Jd6QswsHwPwWRs4nDkn1L5edZS4VjqWCqinmxItycj1hsbGPYbmKx3SRp1i
oXYlPUsQBf1C5uT4ej4nfGeVpY/R/FRrOB/ecst9+ZlG6G+fLypF9dPOjLO8c2bf
UHUpfOkhGJtgS165WIaGSoo2K6CsPzNOUKuW8rDyX4BuGgQFok/xaqK416rCuQVv
VWdrksDc2xz8IQcLxsvXtSnr4LyECQJH3liL29v5sjpv/Z6ynUbOXzSd78T5iO7p
gwOkwYMExLKoK6AMQ4Unub4PcLKOQfCgNDfwAW9TQQKBgQC/aLuvs5vX2jdyP6Pi
Xqk54lYjSm45a9VJZLEFwK9V4YDkytqxYjBl6aLc+B78H6aNqHGhKXve2GUTxTYp
GtM+HGP/BnHmxhAbDzwo8aBoByoRDBxFj8wMKlOLVWkwCsZov9D4gVlcaoAb/X2P
qwh2Aj/hat8k+4F+fNUYpU5ItQKBgQC9rUaJNsjRFzt65pCikVhaUxt7PHOheuUJ
RqtoPeocgy0V3kbGNCNPk+3iacHyCNttaPCEj2ofU8iF7aI275iBEp3w1JZTmkZE
Bsq4H6Qm9GQI7kBNK8G0lnsJd5iCjCroDXVnnBpEJnQynpmRW+HTgL0ng4kuv48d
/ZShPzdRGQKBgQCq+fX1W73Q0WcH0dslgSMuxoPlID5XYoBx/9S068pzL20Ackdp
fej3j/xf3+9ljSwsi5N8v16bz7ZyM45Op1yctaWJD4u89Z07Xp+Bf1ymsAeelK/I
X0uIbmKUKqY8ONPEi9sxr/FPwP5Qgl2fcMqtBxNi2yEamuKwRvfe/QJxpQKBgQCi
1gozLFQ0pTRMK3rKBeuLB8QVBW3jmMTeNMxcnqLIvZjMKFosOICEBeR4twBo0E/I
2wl5VEHwCRaiW8MiVIlhbeEn6unvdgeSyR3p+kgLpU3oGNodJk6SwYl5NDI7CSig
tUUwoOQv06938Y63KuFxmRlKvfLcrlmojpW15LaRqQKBgEYqiB3YHe4Dy9Lmywcz
iIYbnQZAjmIj7bXIef85FPP+yNTVoDR8pMLdVQOcK2f8KXnfXd5t+cuqMnNOh+zi
dZ1Js+ss3JGuOAffu2Yyyf0IWgtcLwFYiz8MwyMlKmZHWfl6ToMDn+DLdDJ/qvXM
T8dzLGbMojKZcd+vrwM2fyq7
-----END PRIVATE KEY-----
`
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUOj9j0HhmLVPZV6BJ7qOdZ94D6McwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVZG9naS1yZHAtYnJpZGdlLXByb2JlMCAXDTI2MDkyODA0
MTY0MFoYDzIxMjYwOTA0MDQxNjQwWjAgMR4wHAYDVQQDDBVkb2dpLXJkcC1icmlk
Z2UtcHJvYmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCN0eEUyKso
kEYWh2UfCJZt5iu7Z8thkoJ1HU0P00GkjNs/If3GqNoDrc/B9eb66VUjLdv/XYPc
cuyWilI/AuoKgKfVPoXmt7gsIFVWvX5kBhTAGO4r1L1fqN1/mjmNRQRtsFOfMel8
Q4sfafy1OWU7rl8a/FcFc1mZqK8T2OnVc/0zy+ZtyM46QSwtndoBl2Blk7iQWP7S
0tXVpDqciOWBLBOARU+Bud9NqIqggSfpF52RS+yo1O3xlmm/P590xuZTjIe2f69H
D3PCQBNIN7UjGGeS71gwaxKQfpZY9t+xMaYb9ppaBbWfj8PHL8XmRP8Sx9qnLWyW
tEa8wUETiV6tAgMBAAGjUzBRMB0GA1UdDgQWBBSHyU7G45z1GK02YbHN/1k5vMAw
2TAfBgNVHSMEGDAWgBSHyU7G45z1GK02YbHN/1k5vMAw2TAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBxas5Es//kfpXTHFYj+XeYHdGk/NuEyVsk
/qGz2mhNA2lwa2+w2tjZOzw4yCAP98chFCI+erkrEKIKl9Y4haLd81QuT586ev25
sFjoVyqG8AGBjbA0vzudLLvFIch4TToxefHkrRgMZCsZR/xhKYjsejaFz9PSYaem
Aytdml+2fAVZ6n5jkwkHg75NsSqUfu+J4hSaItpHitL4qpU0ZAM3jGF8/M5W/pfq
uM5cC6ah+ldussHFCm9xDnjX5ALlk3di3JWcl0yF6oVKQ+pIH8AaAucZOqi47RP3
BtpfmH1ITcGvzmcAchiVVYXkbx23n2bjHhPH5cpuqxTLxVWzB1r5
-----END CERTIFICATE-----
`
const CERT_DER = new X509Certificate(TEST_CERT).raw

// 第二份固件：keyUsage 只有 keyEncipherment（缺 digitalSignature）—— 复刻真实世界
// 里被云镜像工具生成的问题证书；OpenSSL / SChannel / rustls 不查用途位都能连，
// BoringSSL 按 X.509 语义拒绝「无签名位却用于签名」的套件。
const BAD_KU_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC8anSyZ4xLRezz
GyVxlNIoj531T+nEUc8t6NcpmCvU9DK/n5F+Xx0TwZRZKEV6xj3fFbOa8bdtCD5y
6KUOV4lLt0azTYlOpSi7/hSpfru+7uYBDlct1l1/gizIQtnuHtdRezUqOqq9FlLD
oveXUD3GAPgjq1KAYN4Tx3OoGFl9mAlG+i6Mh2+YTgPrtflTfQlZU3PvTjC3+Jyk
jIa9Wjsflr4HQetWtjUzueK8+gdeyOGVUB6HXl64W4jfabzaQ5etaN/YsWoFL9oP
UYKmaMfmgiTtocleJQgzxo5vBAP2n5bXG/Cxoa1p8D8iJ+mrFgxQXD1JMcSnQhFI
l/4te3TbAgMBAAECggEACOyWyb6qfJI7o+JZKjpkLd75U1aipKrRFW8Iossorosk
sDRiEzwfnTpFc7zzytnmeIoyC7UNp572rHpsN9eSr08R/ok99Y5s2PDdkI9qBqQf
N6qyxinNOCAZTVmeI8TXTcOxLp9roNwGYDGUoa3/nUDvKoePmuqYFqIvsd3505Sj
me8f+YA9B2r6lI51wnsDtivEV8PZ6ryGXjUiRp2Qymr1wHZ+LbtFZAtDG33EsXET
XBN+VHWv1ZQI17vCjk4CcxQ1wqJjV4+O/8xsct5jd/3ImxaichEM4Xna2qui5GPI
5QAQmhH3gzYRrqDvcbhxK0LvkE/a/sCB9kpDSNL2eQKBgQDu9VUofgt9/RXX1IPx
zasFOWE5oByWGCNfr+zOBjL15eJjAYAElpVqgjxeD65Qj+hdh3TnDPLIJnU05g8Q
JCklwz56aOioP0rf3iKLlCewjsHXMGO93jrSo2hWQubOW/tMN71aEUf0NRFyP/hU
rGR/aNjVB4G28Xy7fjXynU6TvwKBgQDJ2l4wOJmpvPC74rHOaWVEN5glJMdCt2uC
ryaffaEHVi/UHEUt7EutCFx2WOa3pvPW8+Yt7K/6ecrSOq09vtgtOid30CdFXV/4
F3tQKXg34znYNbs887ypdPH7EEfkbDWn3pUdy3kDtY9cnobeBP+Mw4wUxnWaFxdf
LnUDEhV15QKBgDZ/x6tTjAVxCmFOO8WTVbT8UDtXVA27dZ3mPskCSu8gPhC8j9j8
CxnemCwPwX7oQ2PJeBUWM+0IMGUfL0JMLQJK1F4QvTdaMBZ80D4rTR4MgRM2Gxl7
rMjLsgkyeveHrPnGIK6BEHsW+2KmSlntc4JHhGSZsLDrxLnyYBV0YS57AoGAaERJ
VQVXsssrWxJNoH7m1WcWS1GFMFxIx7er7sTZMk395MY5ofAmYxonkOZ5PzKZUFaq
dtyFRpA1CYVPyc5UIoCgtI4sSvNhyGhwxUa2l7/jOGEA+Ao7URlcicCuMjsHOFCM
nFhniVf21vP4XKUeUFsOeAjP5Km64+q+fLiRp1UCgYADGgqUQ3Uepe9HWWxphI7a
ckpGyvMmBtg7EqkpISnM/wifvpJWELUfgYjZQ9SKKmBee39nVNj2AHz3YwPscRaT
W0WAv72/VzWQ0vk3C5QJSjEIZ41CkCVapfzZJShB2FFyJQfeW43sqEy/dGPY4NbW
aFPpC/m7nKP6oxHhWP3U6g==
-----END PRIVATE KEY-----
`
const BAD_KU_CERT = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUaiOHvvi5Fh50wEYB7DFV41gJsEowDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLYmFkLWt1LXRlc3QwHhcNMjYwOTI4MDU0MjM4WhcNMzYw
OTI1MDU0MjM4WjAWMRQwEgYDVQQDDAtiYWQta3UtdGVzdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBALxqdLJnjEtF7PMbJXGU0iiPnfVP6cRRzy3o1ymY
K9T0Mr+fkX5fHRPBlFkoRXrGPd8Vs5rxt20IPnLopQ5XiUu3RrNNiU6lKLv+FKl+
u77u5gEOVy3WXX+CLMhC2e4e11F7NSo6qr0WUsOi95dQPcYA+COrUoBg3hPHc6gY
WX2YCUb6LoyHb5hOA+u1+VN9CVlTc+9OMLf4nKSMhr1aOx+WvgdB61a2NTO54rz6
B17I4ZVQHodeXrhbiN9pvNpDl61o39ixagUv2g9RgqZox+aCJO2hyV4lCDPGjm8E
A/afltcb8LGhrWnwPyIn6asWDFBcPUkxxKdCEUiX/i17dNsCAwEAAaNxMG8wHQYD
VR0OBBYEFHn0lYXDE7bmTl2VGvOEleksvY65MB8GA1UdIwQYMBaAFHn0lYXDE7bm
Tl2VGvOEleksvY65MA8GA1UdEwEB/wQFMAMBAf8wCwYDVR0PBAQDAgUgMA8GA1Ud
EQQIMAaHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBACxQR46n6wY7e0f/97VnzLMW
uKANu2CFmFWgfPP3qB6Zi0VRUsTVQC/lqNszfVow/iigjMHfjP9DRuHBajugWoN2
dCOXGX3Hxz/8/gNCIL08SW/CuJAgBX3PQXGVGaug3S2gm761meHbNgSuGqvi900o
eV66fBwtHcp6hOmIEnBXo6CFUlWQ1jhgt9CFoSUWarSEzkwUmxChmQpn43TZK4lY
EV/6resg4u/lIcakEnnDgYDbBL/kpmCSMH6yEebCLpPqanUDB7lSEoc7g71A6POB
8X2d3/HFPEe4jzoYQAdCsFnZtVd7D+6gxNeKKF7Otox3HUIFiDyHRwVePM+r2uw=
-----END CERTIFICATE-----
`
const BAD_KU_CERT_DER = new X509Certificate(BAD_KU_CERT).raw

/** X.224 连接请求 / 确认（TPKT + X.224 + RDP 协商头，各 19 字节）；内容对桥是不透明的 */
const X224_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex')
const X224_CONFIRM = Buffer.from('030000130ed000000000000200080000000000', 'hex')
assert.equal(X224_REQUEST.length, 19)
assert.equal(X224_CONFIRM.length, 19)

// ---------- 假 RDP 服务器：X.224 确认 + STARTTLS + 明文回显 ----------
let fakeConnections = 0
let tlsClosed = 0
const x224Frames = []

const tlsServer = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (tlsSocket) => {
  tlsSocket.on('data', (d) => tlsSocket.write(d))
  tlsSocket.on('close', () => {
    tlsClosed++
  })
  tlsSocket.on('error', () => {})
})
tlsServer.on('tlsClientError', () => {})

const rdpServer = net.createServer((socket) => {
  fakeConnections++
  socket.on('error', () => {})
  let buf = Buffer.alloc(0)
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length < 4) return
    const frameLength = buf.readUInt16BE(2)
    if (buf.length < frameLength) return
    socket.removeListener('data', onData)
    x224Frames.push(Buffer.from(buf.subarray(0, frameLength)))
    if (buf.length > frameLength) socket.unshift(buf.subarray(frameLength))
    socket.write(X224_CONFIRM)
    // STARTTLS：同一条连接升级为 TLS 服务端（把裸 socket 交给 tls.Server 完成握手）
    socket.pause()
    tlsServer.emit('connection', socket)
  }
  socket.on('data', onData)
})
await new Promise((r) => rdpServer.listen(RDP_PORT, '127.0.0.1', r))
console.log(`假 RDP 服务器已监听 127.0.0.1:${RDP_PORT}`)

// 第二台假服务器（坏 keyUsage 证书）：专测桥的兼容降级路径 —— 客户端默认握手
// （TLS 1.3）会在校验证书用途位时被 KEY_USAGE_BIT_INCORRECT 掐断，降级重试走
// TLS 1.2 静态 RSA 套件时才能成功（服务端 1.2 列表里必须保留这些套件）。
const RDP_BAD_KU_PORT = 29390
let badKuConnections = 0
const badKuTlsServer = tls.createServer(
  {
    key: BAD_KU_KEY,
    cert: BAD_KU_CERT,
    ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA384:AES256-SHA:AES128-SHA'
  },
  (tlsSocket) => {
    tlsSocket.on('data', (d) => tlsSocket.write(d))
    tlsSocket.on('error', () => {})
  }
)
badKuTlsServer.on('tlsClientError', () => {})

const badKuRdpServer = net.createServer((socket) => {
  badKuConnections++
  socket.on('error', () => {})
  let buf = Buffer.alloc(0)
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length < 4) return
    const frameLength = buf.readUInt16BE(2)
    if (buf.length < frameLength) return
    socket.removeListener('data', onData)
    if (buf.length > frameLength) socket.unshift(buf.subarray(frameLength))
    socket.write(X224_CONFIRM)
    socket.pause()
    badKuTlsServer.emit('connection', socket)
  }
  socket.on('data', onData)
})
await new Promise((r) => badKuRdpServer.listen(RDP_BAD_KU_PORT, '127.0.0.1', r))
console.log(`坏证书假 RDP 服务器已监听 127.0.0.1:${RDP_BAD_KU_PORT}`)

// ---------- DER 编解码（与 bridge.ts 的编解码约定同构：桥按这些字段解析请求） ----------
function derEncodeLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let temp = length
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
function derTlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}
function derInt(value) {
  if (value === 0) return derTlv(0x02, Buffer.from([0]))
  const bytes = []
  let temp = value
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  if (bytes[0] & 0x80) bytes.unshift(0)
  return derTlv(0x02, Buffer.from(bytes))
}
const derUtf8 = (s) => derTlv(0x0c, Buffer.from(s, 'utf8'))
const derOctet = (b) => derTlv(0x04, b)
const derCtx = (n, content) => derTlv(0xa0 + n, content)

/** RDCleanPath 请求：SEQUENCE { [0] version、[2] destination、[6] x224_connection_pdu } */
function buildRequest(destination, x224) {
  return derTlv(
    0x30,
    Buffer.concat([derCtx(0, derInt(3390)), derCtx(2, derUtf8(destination)), derCtx(6, derOctet(x224))])
  )
}

function derDecodeLength(buf, offset) {
  const first = buf[offset]
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const numBytes = first & 0x7f
  let length = 0
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i]
  return { length, bytesRead: 1 + numBytes }
}
function derDecodeTlv(buf, offset) {
  const tag = buf[offset]
  const { length, bytesRead } = derDecodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  return {
    tag,
    value: buf.subarray(offset + headerLen, offset + headerLen + length),
    totalLength: headerLen + length
  }
}
function derChildren(buf) {
  const children = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = derDecodeTlv(buf, offset)
    if (tlv.totalLength <= 0) break
    children.push(tlv)
    offset += tlv.totalLength
  }
  return children
}
function derIntValue(buf) {
  let val = 0
  for (let i = 0; i < buf.length; i++) val = (val << 8) | buf[i]
  return val
}

/** 解析 RDCleanPath 应答 / 错误 PDU（字段按上下文 tag 取） */
function inspectPdu(buf) {
  const outer = derDecodeTlv(buf, 0)
  const fields = {}
  for (const child of derChildren(outer.value)) fields[child.tag & 0x1f] = child.value
  const pick = (n, fn) => (fields[n] !== undefined ? fn(fields[n]) : null)
  return {
    isSequence: outer.tag === 0x30,
    version: pick(0, (v) => derIntValue(derDecodeTlv(v, 0).value)),
    x224: pick(6, (v) => Buffer.from(derDecodeTlv(v, 0).value)),
    certs: pick(7, (v) => derChildren(derDecodeTlv(v, 0).value).map((t) => Buffer.from(t.value))),
    serverAddr: pick(9, (v) => derDecodeTlv(v, 0).value.toString('utf8')),
    error: pick(1, (v) =>
      derChildren(derDecodeTlv(v, 0).value).map((t) => derIntValue(derDecodeTlv(t.value, 0).value))
    )
  }
}

// ---------- WebSocket 客户端辅助 ----------
function wsOpen(url, timeoutMs = 6000, retries = 2) {
  return new Promise((resolve, reject) => {
    let settled = false
    const attempt = (left) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('WebSocket 连接超时'))
      }, timeoutMs)
      ws.onopen = () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolve(ws)
      }
      ws.onerror = () => {
        clearTimeout(timer)
        if (settled) return
        // Windows 回环 dial 偶发失败（与桥实现无关）：退避后重试若干次
        if (left > 0) {
          setTimeout(() => attempt(left - 1), 400)
          return
        }
        settled = true
        reject(new Error('WebSocket 连接失败'))
      }
    }
    attempt(retries)
  })
}
function wsNext(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 WebSocket 消息超时')), timeoutMs)
    ws.addEventListener(
      'message',
      (ev) => {
        clearTimeout(timer)
        resolve(Buffer.from(ev.data))
      },
      { once: true }
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('WebSocket 出错'))
      },
      { once: true }
    )
  })
}
/** 攒够 expectedLen 字节再返回（大块经 TLS 可能被拆成多条消息） */
async function wsCollect(ws, expectedLen, timeoutMs = 8000) {
  const chunks = []
  let total = 0
  while (total < expectedLen) {
    const next = await wsNext(ws, timeoutMs)
    chunks.push(next)
    total += next.length
  }
  return Buffer.concat(chunks)
}
async function expectWsFail(url, timeoutMs = 5000) {
  try {
    // 负路径不重试：拨号单次失败才说明「连不上」
    const ws = await wsOpen(url, timeoutMs, 0)
    ws.close()
    return false
  } catch {
    return true
  }
}

// ---------- 起隔离实例 ----------
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'rdp-bridge.log'), 'a')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new Error('没有等到可调试的页面')
}

const page = await pageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let msgId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result.value
}

const finish = async (code) => {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  rdpServer.close()
  tlsServer.close()
  badKuRdpServer.close()
  badKuTlsServer.close()
  await log.close()
  process.exit(code)
}

try {
  // 等 bootstrap 完成（整批初始数据已进 store，window.api 可用）
  {
    const deadline = Date.now() + 20000
    let ready = false
    while (Date.now() < deadline && !ready) {
      ready = await evaluate(`window.__store.getState().shells !== null`).catch(() => false)
      if (!ready) await sleep(300)
    }
    check('渲染端 bootstrap 已完成', ready)
  }

  // ---------- 0. 主机配置 + rdp:open 基础行为 ----------
  // 远程桌面是独立主机类型（kind = rdp）：RDP 端口就存在主机配置的 port 上
  const profileId = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'rdp', name: 'RDP 探针主机', host: '127.0.0.1', port: ${RDP_PORT},
        username: 'tester', authType: 'password', password: 'pw', domain: 'CORP'
      })
      return list.find((p) => p.name === 'RDP 探针主机').id
    })()
  `)
  check('rdp 类型主机配置已保存', !!profileId)

  const opened = await evaluate(
    `(async () => await window.api.rdp.open('probe-rdp', '${profileId}'))()`
  )
  check('rdp:open 返回 connId', opened.connId === 'probe-rdp')
  check(
    'wsUrl 为 127.0.0.1 随机端口 + 48 位随机 token 路径',
    /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/.test(opened.wsUrl)
  )

  const openedAgain = await evaluate(
    `(async () => await window.api.rdp.open('probe-rdp', '${profileId}'))()`
  )
  check('rdp:open 幂等（同一 connId 返回同一座桥）', openedAgain.wsUrl === opened.wsUrl)

  const badProfile = await evaluate(`
    (async () => {
      try {
        await window.api.rdp.open('probe-bad', 'nope-id')
        return 'resolved'
      } catch (e) {
        return String((e && e.message) || e)
      }
    })()
  `)
  check('未知主机配置被拒绝', badProfile.includes('主机配置不存在'))

  // 三种主机类型：只有 kind = rdp 的主机能开远程桌面（ssh 主机走终端 / SFTP / 隧道）
  const sshKindId = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'ssh', name: 'RDP 探针-ssh 主机', host: '127.0.0.1', port: 2222,
        username: 'tester', authType: 'password', password: 'pw'
      })
      return list.find((p) => p.name === 'RDP 探针-ssh 主机').id
    })()
  `)
  const badKind = await evaluate(`
    (async () => {
      try {
        await window.api.rdp.open('probe-bad-kind', '${sshKindId}')
        return 'resolved'
      } catch (e) {
        return String((e && e.message) || e)
      }
    })()
  `)
  check('ssh 类型主机开远程桌面被拒绝', badKind.includes('不是远程桌面类型'))

  // 凭据从主机配置解密后下发给渲染端（WASM 的 NLA / CredSSP 必须在渲染进程算票据）
  const creds = await evaluate(`(async () => await window.api.rdp.credentials('${profileId}'))()`)
  check(
    'rdp:credentials 返回配置里的凭据（用户名 / 密码 / 域 / 端口）',
    creds.username === 'tester' &&
      creds.password === 'pw' &&
      creds.domain === 'CORP' &&
      creds.port === RDP_PORT
  )
  const credsBadKind = await evaluate(`
    (async () => {
      try {
        await window.api.rdp.credentials('${sshKindId}')
        return 'resolved'
      } catch (e) {
        return String((e && e.message) || e)
      }
    })()
  `)
  check('rdp:credentials 对非 rdp 主机报错', credsBadKind.includes('不是远程桌面类型'))

  const wasmInfo = await evaluate(`
    (async () => {
      const bytes = await window.api.rdp.wasm()
      return {
        len: bytes.length,
        magic: bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
      }
    })()
  `)
  check('rdp:wasm 返回 wasm 字节（\\0asm 魔数）', wasmInfo.magic === true && wasmInfo.len > 100000)

  // 桥目标取自主机配置：rdp 主机的 port 就是 RDP 端口
  {
    const logs = await evaluate(`(async () => await window.api.logs.list())()`)
    check(
      '桥目标取自主机配置的端口（rdp 主机的 port 即 RDP 端口）',
      logs.some(
        (e) =>
          e.scope === 'rdp' &&
          e.message.includes('[probe-rdp] 本地桥已就绪') &&
          e.message.endsWith(`→ 127.0.0.1:${RDP_PORT}`)
      )
    )
  }

  // 非法端口（历史数据 / 手改）→ 3389 兜底；rdp:credentials 与桥同口径
  const fallbackId = await evaluate(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'rdp', name: 'RDP 探针-端口兜底', host: '127.0.0.1', port: 0,
        username: 'tester', authType: 'password', password: 'pw'
      })
      return list.find((p) => p.name === 'RDP 探针-端口兜底').id
    })()
  `)
  const openedFallback = await evaluate(
    `(async () => await window.api.rdp.open('probe-rdp-fallback', '${fallbackId}'))()`
  )
  check('非法端口的主机也能开桥（不报错）', /^ws:\/\//.test(openedFallback.wsUrl))
  {
    const logs = await evaluate(`(async () => await window.api.logs.list())()`)
    check(
      '非法端口兜底为 3389',
      logs.some(
        (e) =>
          e.scope === 'rdp' &&
          e.message.includes('[probe-rdp-fallback] 本地桥已就绪') &&
          e.message.endsWith('→ 127.0.0.1:3389')
      )
    )
  }
  {
    const fallbackCreds = await evaluate(
      `(async () => await window.api.rdp.credentials('${fallbackId}'))()`
    )
    check('rdp:credentials 的端口兜底口径与桥一致（3389）', fallbackCreds.port === 3389)
  }
  await evaluate(`(async () => await window.api.rdp.close('probe-rdp-fallback'))()`)

  // ---------- 1. RDCleanPath 握手：应答同构 ----------
  const ws = await wsOpen(opened.wsUrl)
  ws.send(buildRequest(`127.0.0.1:${RDP_PORT}`, X224_REQUEST))
  const respBuf = await wsNext(ws)
  const resp = inspectPdu(respBuf)
  check('应答是 SEQUENCE', resp.isSequence === true)
  check('应答 version = 3390', resp.version === 3390)
  check('应答回传 X.224 确认（与假服务器一致）', !!resp.x224 && resp.x224.equals(X224_CONFIRM))
  check(
    '应答携带服务器证书链（含假服务器证书）',
    resp.certs.length >= 1 && resp.certs[0].equals(CERT_DER)
  )
  check('应答 server_addr 为固定目标', resp.serverAddr === `127.0.0.1:${RDP_PORT}`)
  check(
    '假服务器收到 X.224 请求（原样透传）',
    x224Frames.length === 1 && x224Frames[0].equals(X224_REQUEST)
  )

  // ---------- 2. 透传：WS → TLS → 回声 ----------
  {
    const ascii = Buffer.from('ping-rdp-bridge\r\n')
    ws.send(ascii)
    check('ASCII 回声一致', (await wsCollect(ws, ascii.length)).equals(ascii))
  }
  {
    const chinese = Buffer.from('透传测试：中文、符号 ✓', 'utf8')
    ws.send(chinese)
    check('中文回声字节一致', (await wsCollect(ws, chinese.length)).equals(chinese))
  }
  {
    const blob = randomBytes(4096)
    ws.send(blob)
    check('4KB 随机块回声字节一致', (await wsCollect(ws, blob.length)).equals(blob))
  }
  ws.close()
  {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && tlsClosed === 0) await sleep(200)
    check('WS 关闭后桥把目标 TLS 连接一并收尾', tlsClosed === 1)
  }

  // ---------- 3. 错误路径与安全基线 ----------
  {
    const wrongToken = opened.wsUrl.replace(/\/[0-9a-f]{48}$/, '/' + 'a'.repeat(48))
    check('错误 token 无法连接本地桥', (await expectWsFail(wrongToken)) === true)
  }
  {
    const wsBad = await wsOpen(opened.wsUrl)
    wsBad.send(Buffer.from([0x01, 0x02, 0x03, 0x04]))
    const errResp = inspectPdu(await wsNext(wsBad))
    check(
      '脏数据首包 → 错误 PDU（error=1 / 502）',
      !!errResp.error && errResp.error[0] === 1 && errResp.error[1] === 502
    )
  }
  {
    const wsMismatch = await wsOpen(opened.wsUrl)
    wsMismatch.send(buildRequest(`127.0.0.1:${RDP_PORT + 1}`, X224_REQUEST))
    const errResp = inspectPdu(await wsNext(wsMismatch))
    check(
      'destination 与固定目标不符 → 错误 PDU',
      !!errResp.error && errResp.error[0] === 1
    )
  }
  check('错误路径都没有触碰目标服务器', fakeConnections === 1 && x224Frames.length === 1)

  // ---------- 4. rdp:close ----------
  await evaluate(`(async () => await window.api.rdp.close('probe-rdp'))()`)
  await sleep(300)
  check('rdp:close 后端口不再接受连接', (await expectWsFail(opened.wsUrl, 4000)) === true)
  check(
    'rdp:close 幂等（重复调用不报错）',
    (await evaluate(`(async () => { await window.api.rdp.close('probe-rdp'); return true })()`)) === true
  )

  // ---------- 4.5 证书兼容降级：keyUsage 缺 digitalSignature 的服务器 ----------
  {
    const profileId2 = await evaluate(`
      (async () => {
        const list = await window.api.ssh.save({
          id: '', kind: 'rdp', name: 'RDP 探针-坏证书', host: '127.0.0.1', port: ${RDP_BAD_KU_PORT},
          username: 'tester', authType: 'password', password: 'pw'
        })
        return list.find((p) => p.name === 'RDP 探针-坏证书').id
      })()
    `)
    const opened2 = await evaluate(
      `(async () => await window.api.rdp.open('probe-rdp-badku', '${profileId2}'))()`
    )
    const ws2 = await wsOpen(opened2.wsUrl)
    ws2.send(buildRequest(`127.0.0.1:${RDP_BAD_KU_PORT}`, X224_REQUEST))
    const resp2 = inspectPdu(await wsNext(ws2))
    check(
      '坏证书服务器：默认握手被拒后自动降级，应答仍为成功 PDU',
      resp2.error === null && resp2.version === 3390
    )
    check('坏证书服务器：应答回传 X.224 确认', !!resp2.x224 && resp2.x224.equals(X224_CONFIRM))
    check(
      '坏证书服务器：证书链即该服务器证书（降级握手的对象正确）',
      resp2.certs.length >= 1 && resp2.certs[0].equals(BAD_KU_CERT_DER)
    )
    check(
      '坏证书服务器：server_addr 为固定目标',
      resp2.serverAddr === `127.0.0.1:${RDP_BAD_KU_PORT}`
    )
    {
      const msg = Buffer.from('bad-ku-fallback-ok')
      ws2.send(msg)
      check('坏证书服务器：降级后透传回声一致', (await wsCollect(ws2, msg.length)).equals(msg))
    }
    check(
      '坏证书服务器共收到 2 次连接（默认握手被拒一次 + 降级重试一次）',
      badKuConnections === 2
    )
    ws2.close()
    {
      const logs = await evaluate(`(async () => await window.api.logs.list())()`)
      check(
        '日志：keyUsage 缺位告警 + 降级成功留痕',
        logs.some(
          (e) =>
            e.scope === 'rdp' &&
            e.message.includes(`keyUsage 缺少 digitalSignature（127.0.0.1:${RDP_BAD_KU_PORT}）`)
        ) &&
          logs.some(
            (e) =>
              e.scope === 'rdp' &&
              e.message.includes(`已用 TLS 1.2 静态 RSA 套件完成握手（127.0.0.1:${RDP_BAD_KU_PORT}`)
          )
      )
      check(
        '日志：坏证书主机没有「本地桥握手失败」',
        !logs.some(
          (e) => e.scope === 'rdp' && e.message.includes('[probe-rdp-badku] 本地桥握手失败')
        )
      )
    }
    await evaluate(`(async () => await window.api.rdp.close('probe-rdp-badku'))()`)
  }

  // ---------- 5. 日志 ----------
  {
    const logs = await evaluate(`(async () => await window.api.logs.list())()`)
    check(
      '日志：RDCleanPath 握手完成',
      logs.some((e) => e.scope === 'rdp' && e.message.includes('[probe-rdp] RDCleanPath 握手完成'))
    )
    const failLogs = logs.filter(
      (e) => e.scope === 'rdp' && e.message.includes('[probe-rdp] 本地桥握手失败')
    )
    check('日志：两条握手失败（脏数据 / 目标不匹配）', failLogs.length === 2)
    check(
      '日志：本地桥已关闭',
      logs.some((e) => e.message === '[probe-rdp] 本地桥已关闭')
    )
  }

  console.log('ALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
