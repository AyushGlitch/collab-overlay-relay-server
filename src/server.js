#!/usr/bin/env node
import { WebSocket, WebSocketServer } from 'ws'
import http from 'http'
import { setupWSConnection } from '@y/websocket-server/utils'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import Busboy from 'busboy'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 1234
const HOST = process.env.HOST || '0.0.0.0'
const IMAGES_DIR = join(__dirname, '..', 'images')

// activeRooms maps room name → Set of Yjs-sync WebSockets
const activeRooms = new Map()
// broadcastRooms maps room name → Set of broadcast WebSockets
const broadcastRooms = new Map()

function logActiveRooms() {
  const rooms = [...activeRooms.keys()]
  console.log(`[${new Date().toISOString()}] Active rooms (${rooms.length}): ${rooms.length ? rooms.join(', ') : '(none)'}`)
}

const yjsWss = new WebSocketServer({ noServer: true })
const broadcastWss = new WebSocketServer({ noServer: true })

const server = http.createServer((req, res) => {
  // GET /rooms
  if (req.method === 'GET' && req.url === '/rooms') {
    const rooms = [...activeRooms.entries()].map(([room, clients]) => ({
      room,
      clients: clients.size,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(rooms))
    return
  }

  // POST /upload
  if (req.method === 'POST' && req.url === '/upload') {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } })
    let room, fileBuffer, filename

    busboy.on('field', (name, val) => {
      if (name === 'room') room = val
    })

    busboy.on('file', (fieldname, file, info) => {
      filename = info.filename
      const chunks = []
      file.on('data', (chunk) => chunks.push(chunk))
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks)
      })
    })

    busboy.on('finish', () => {
      if (!room || !fileBuffer) {
        res.writeHead(400)
        res.end('Missing room or file')
        return
      }
      const ext = extname(filename || 'image.webp') || '.webp'
      const id = randomUUID()
      const roomDir = join(IMAGES_DIR, room)
      if (!existsSync(roomDir)) mkdirSync(roomDir, { recursive: true })
      const destPath = join(roomDir, `${id}${ext}`)
      createWriteStream(destPath).end(fileBuffer)
      const url = `/images/${room}/${id}${ext}`
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url }))
    })

    req.pipe(busboy)
    return
  }

  // GET /images/:room/:file
  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    const path = req.url.slice('/images/'.length)
    const safe = path.replace(/\.\./g, '')
    const filePath = join(IMAGES_DIR, safe)
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const ext = extname(filePath).toLowerCase()
    const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000' })
    res.end(readFileSync(filePath))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('collab-overlay relay OK')
})

// All connection logic is inside the upgrade handler callbacks below.
// The 'connection' event does NOT fire when handleUpgrade receives a callback.

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const client = socket.remoteAddress || request.socket?.remoteAddress || 'unknown'

  // /broadcast/:room — image relay only
  if (url.pathname.startsWith('/broadcast/')) {
    const room = url.pathname.slice('/broadcast/'.length) || '(unknown)'

    broadcastWss.handleUpgrade(request, socket, head, (ws) => {
      if (!broadcastRooms.has(room)) {
        broadcastRooms.set(room, new Set())
      }
      broadcastRooms.get(room).add(ws)

      console.log(`[${new Date().toISOString()}] Broadcast client connected → room "${room}" from ${client}`)

      ws.on('message', (data) => {
        // Relay binary to all OTHER broadcast clients in the same room
        const roomSet = broadcastRooms.get(room)
        if (roomSet) {
          for (const c of roomSet) {
            if (c !== ws && c.readyState === WebSocket.OPEN) {
              c.send(data)
            }
          }
        }
      })

      ws.on('close', () => {
        const roomSet = broadcastRooms.get(room)
        if (roomSet) {
          roomSet.delete(ws)
          if (roomSet.size === 0) {
            broadcastRooms.delete(room)
          }
        }
        console.log(`[${new Date().toISOString()}] Broadcast client disconnected → room "${room}" from ${client}`)
      })
    })
    return
  }

  // Everything else → Yjs sync
  const room = url.pathname.slice(1) || '(unknown)'

  yjsWss.handleUpgrade(request, socket, head, (ws) => {
    setupWSConnection(ws, request)

    if (!activeRooms.has(room)) {
      activeRooms.set(room, new Set())
    }
    activeRooms.get(room).add(ws)

    console.log(`[${new Date().toISOString()}] Client connected → room "${room}" from ${client}`)
    logActiveRooms()

    ws.on('close', () => {
      const roomSet = activeRooms.get(room)
      if (roomSet) {
        roomSet.delete(ws)
        if (roomSet.size === 0) {
          activeRooms.delete(room)
        }
      }
      console.log(`[${new Date().toISOString()}] Client disconnected → room "${room}" from ${client}`)
      logActiveRooms()
    })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Relay server listening on ${HOST}:${PORT}`)
})
