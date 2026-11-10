// dsh relay forwarding proxy (minimal).
//
// Why this exists (verified 2026-11-10, see ../工作台直连执行书_2026-11-10.md §3):
// the relay (dsh.r2049.cn) only accepts browser WebSocket connections whose
// Origin is its own site (docs/server.md §18: "WebSocket 浏览器 Origin 只允许
// REMOTE_PUBLIC_URL"). A workbench page running on a Muse origin is closed with
// 4010 "origin not allowed" right after hello. Differential test, same genuine
// hello, only the Origin header varied:
//   no Origin            -> hello.ack
//   Origin: relay itself -> hello.ack
//   Origin: external     -> close 4010 "origin not allowed"
// A browser cannot suppress its Origin header, the relay's allowlist cannot be
// changed (third-party server), and the artifact platform cannot host a WS
// server. So this proxy stands in the middle as a dumb byte pipe:
//
//   phone page --WSS (any Origin)--> proxy --WSS (no Origin)--> relay -- ... --> PC
//
// What it does:
// - WS: accepts /ws/v1/connect from any Origin, opens an upstream WS to the
//   relay WITHOUT an Origin header (plain server-side client, exactly like the
//   Node min-test that passed). Never sets Origin to the relay's own URL:
//   no spoofing. Frames are forwarded byte-for-byte, never parsed.
// - REST: forwards /api/* to the relay (test parity + optional front door).
//   The workbench uses artifact-server actions for REST in production; only
//   the WS control channel goes through this proxy.
// - GET /health -> {"ok":true}, for keep-alive pings and Render health checks.
//
// What it does NOT do:
// - No authentication bypass: the relay still validates device tokens and
//   Noise identity keys itself. This proxy cannot grant access it does not have.
// - No logging of frames, headers, bodies, tokens or keys. Logs only lifecycle
//   events (connect/disconnect, close codes, REST method+path+status).
// - No Origin check on the inbound side: that is the point of the proxy.
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT ?? 8080)
const RELAY_HTTP = (process.env.RELAY_HTTP_URL ?? 'https://dsh.r2049.cn').replace(/\/$/, '')
const RELAY_WS = process.env.RELAY_WS_URL ?? 'wss://dsh.r2049.cn/ws/v1/connect'
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15_000)

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer',
])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const headers = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_HEADERS.has(name.toLowerCase())) continue
        if (value !== undefined) headers[name] = value
      }
      const upstream = await fetch(`${RELAY_HTTP}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      })
      res.end(payload)
      log(`REST ${req.method} ${url.pathname} -> ${upstream.status}`)
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'upstream_unreachable' }))
      log(`REST ${req.method} ${url.pathname} -> 502 upstream error`)
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not_found' }))
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws/v1/connect') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const clientOrigin = req.headers.origin ?? '(none)'
    log(`WS client connected (origin ${clientOrigin})`)
    // NOTE: no `origin` option here on purpose. The `ws` client sends no
    // Origin header by default, and the relay accepts Origin-less (non-browser)
    // clients. Setting Origin to the relay's own URL would be spoofing.
    const upstream = new WebSocket(RELAY_WS, { handshakeTimeout: UPSTREAM_TIMEOUT_MS })
    let closed = false
    // `ws` send() THROWS while the socket is still CONNECTING (it does not
    // buffer pre-open sends), so client frames that arrive before the upstream
    // socket is open must be queued and flushed on open. Without this queue
    // the first hello throws and kills the whole proxy process.
    const pendingUpstream = []
    const sendUpstream = (data, isBinary) => {
      try {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary })
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          pendingUpstream.push([data, isBinary])
        }
      } catch (error) {
        log(`WS send upstream failed: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    const sendClient = (data, isBinary) => {
      try {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      } catch (error) {
        log(`WS send client failed: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    const closeBoth = (code, reason) => {
      if (closed) return
      closed = true
      try { client.close(code, reason) } catch { /* ignore */ }
      try { upstream.close(code, reason) } catch { /* ignore */ }
    }
    const upstreamTimer = setTimeout(() => {
      log('WS upstream connect timeout')
      closeBoth(1011, 'upstream timeout')
    }, UPSTREAM_TIMEOUT_MS)
    upstream.on('open', () => {
      clearTimeout(upstreamTimer)
      log('WS upstream open (relay connected, no Origin sent)')
      for (const [data, isBinary] of pendingUpstream.splice(0)) sendUpstream(data, isBinary)
    })
    upstream.on('message', (data, isBinary) => {
      sendClient(data, isBinary)
    })
    client.on('message', (data, isBinary) => {
      sendUpstream(data, isBinary)
    })
    const onClose = (side, code) => {
      clearTimeout(upstreamTimer)
      log(`WS closed by ${side} (code ${code})`)
      closeBoth(code, '')
    }
    client.on('close', (code) => onClose('client', code))
    upstream.on('close', (code) => onClose('upstream', code))
    client.on('error', () => closeBoth(1011, 'client error'))
    upstream.on('error', (error) => {
      clearTimeout(upstreamTimer)
      log(`WS upstream error: ${String(error?.message ?? error).slice(0, 120)}`)
      closeBoth(1011, 'upstream error')
    })
  })
})

// Backstop: one bad connection must never kill the proxy process.
process.on('uncaughtException', (error) => {
  log(`uncaught exception (proxy keeps running): ${String(error?.message ?? error).slice(0, 200)}`)
})

server.listen(PORT, () => {
  log(`relay proxy listening on ${PORT} (upstream ${RELAY_WS})`)
})
