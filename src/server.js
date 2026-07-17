#!/usr/bin/env node
import http from 'http'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import Busboy from 'busboy'

const require = createRequire(import.meta.url)
const ws = require('ws')
const { setupWSConnection, docs } = require('y-websocket/bin/utils')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 1234
const HOST = process.env.HOST || '0.0.0.0'
const IMAGES_DIR = join(__dirname, '..', 'images')

const yjsWss = new ws.Server({ noServer: true })
const broadcastWss = new ws.Server({ noServer: true })
const broadcastRooms = new Map()

function logRooms() {
  const rooms = [...docs.keys()].map(name => {
    const doc = docs.get(name)
    return `${name} (${doc?.conns?.size || 0})`
  })
  console.log(`[${new Date().toISOString()}] Active rooms: ${rooms.length ? rooms.join(', ') : '(none)'}`)
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/rooms') {
    const result = [...docs.keys()].map(name => ({
      room: name,
      clients: docs.get(name)?.conns?.size || 0,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(result))
    return
  }
  if (req.method === 'POST' && req.url === '/upload') {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } })
    let room, fileBuffer, filename
    busboy.on('field', (name, val) => { if (name === 'room') room = val })
    busboy.on('file', (fieldname, file, info) => {
      filename = info.filename
      const chunks = []
      file.on('data', (chunk) => chunks.push(chunk))
      file.on('end', () => { fileBuffer = Buffer.concat(chunks) })
    })
    busboy.on('finish', () => {
      if (!room || !fileBuffer) { res.writeHead(400); res.end('Missing room or file'); return }
      const ext = extname(filename || 'image.webp') || '.webp'
      const id = randomUUID()
      const roomDir = join(IMAGES_DIR, room)
      if (!existsSync(roomDir)) mkdirSync(roomDir, { recursive: true })
      createWriteStream(join(roomDir, `${id}${ext}`)).end(fileBuffer)
      const url = `/images/${room}/${id}${ext}`
      const protocol = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
      const host = req.headers.host || `${HOST}:${PORT}`
      const fullUrl = `${protocol}://${host}${url}`
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url, fullUrl }))
    })
    req.pipe(busboy)
    return
  }
  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    const safe = req.url.slice('/images/'.length).replace(/\.\./g, '')
    const filePath = join(IMAGES_DIR, safe)
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }
    const ext = extname(filePath).toLowerCase()
    const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000' })
    res.end(readFileSync(filePath))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('collab-overlay relay OK')
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)

  if (url.pathname.startsWith('/broadcast/')) {
    const room = url.pathname.slice('/broadcast/'.length) || '(unknown)'
    broadcastWss.handleUpgrade(request, socket, head, (bws) => {
      if (!broadcastRooms.has(room)) broadcastRooms.set(room, new Set())
      broadcastRooms.get(room).add(bws)
      bws.on('message', (data) => {
        const s = broadcastRooms.get(room)
        if (s) for (const c of s) { if (c !== bws && c.readyState === 1) c.send(data) }
      })
      bws.on('close', () => { 
        const s = broadcastRooms.get(room); 
        if (s) {
          s.delete(bws)
          if (s.size === 0) broadcastRooms.delete(room)
        }
      })
    })
    return
  }

  yjsWss.handleUpgrade(request, socket, head, (yws) => {
    const room = url.pathname.slice(1) || '(unknown)'
    const client = socket.remoteAddress || request.socket?.remoteAddress || 'unknown'

    setupWSConnection(yws, request, { docName: room })

    const doc = docs.get(room)
    const count = doc?.conns?.size || 0
    console.log(`[${new Date().toISOString()}] Client connected → "${room}" from ${client} (${count} total)`)
    logRooms()

    yws.on('close', () => {
      const remaining = doc?.conns?.size || 0
      console.log(`[${new Date().toISOString()}] Client disconnected → "${room}" from ${client} (${remaining} remaining)`)

      if (remaining === 0) {
        setTimeout(() => {
          const stillEmpty = (docs.get(room)?.conns?.size || 0) === 0
          if (stillEmpty && docs.has(room)) {
            docs.delete(room)
            console.log(`[${new Date().toISOString()}] Room "${room}" freed (0 clients remaining)`)
          }
        }, 10_000) // wait 10s before actually freeing, in case of a quick reconnect
      }

      logRooms()
    })
  })
})

server.listen(PORT, HOST, () => console.log(`Relay listening on ${HOST}:${PORT}`))
