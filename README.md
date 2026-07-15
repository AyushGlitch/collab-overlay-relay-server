# Collab Overlay Relay Server

WebSocket relay for [Collab Overlay](https://github.com/yourusername/collab-overlay) — a collaborative rich‑text editor overlay.

## Quick Start

```bash
git clone https://github.com/yourusername/collab-overlay-relay-server.git
cd collab-overlay-relay-server
npm install
npm start
```

Runs on `ws://0.0.0.0:1234` by default.

## Deploy on a Cloud VM

```bash
ssh user@your-vm-ip

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Clone & install
git clone https://github.com/yourusername/collab-overlay-relay-server.git
cd collab-overlay-relay-server
npm install

# Open firewall
sudo ufw allow 1234/tcp && sudo ufw reload

# Verify Open Ports
nc -vz <your-vm-ip> 1234

# Start with PM2 (auto-restart)
sudo npm install -g pm2
pm2 start src/server.js --name collab-relay
pm2 save
pm2 startup
```

## API

### `GET /rooms`

Returns active rooms and client counts.

```json
[
    { "room": "847392", "clients": 2 },
    { "room": "129834", "clients": 1 }
]
```

### `WS /<room-name>`

Yjs WebSocket connection for collaborative editing.
