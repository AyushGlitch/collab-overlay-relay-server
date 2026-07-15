#!/usr/bin/env node
import { WebSocketServer } from 'ws'
import http from 'http'
import { setupWSConnection } from '@y/websocket-server/utils'

const PORT = process.env.PORT || 1234
const HOST = process.env.HOST || '0.0.0.0'

const activeRooms = new Map()

function logActiveRooms() {
  const rooms = [...activeRooms.keys()]
  console.log(`[${new Date().toISOString()}] Active rooms (${rooms.length}): ${rooms.length ? rooms.join(', ') : '(none)'}`)
}

const wss = new WebSocketServer({ noServer: true })

const server = http.createServer((req, res) => {
  if (req.url === '/rooms') {
    const rooms = [...activeRooms.entries()].map(([room, clients]) => ({
      room,
      clients: clients.size,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(rooms))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('collab-overlay relay OK')
})

wss.on('connection', setupWSConnection)

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const room = url.pathname.slice(1) || '(unknown)'
  const client = socket.remoteAddress || request.socket?.remoteAddress || 'unknown'

  wss.handleUpgrade(request, socket, head, (ws) => {
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

    wss.emit('connection', ws, request)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Relay server listening on ${HOST}:${PORT}`)
})
