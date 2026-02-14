# Relay — Self-Hosted Video Calls

Private video/audio calling optimized for **restrictive networks** (UAE, etc.).  
All media tunneled through **TURN-over-TLS** — indistinguishable from HTTPS to deep packet inspection.

## Features

- 🔒 Password-protected common room
- 📱 Mobile + desktop responsive
- 💬 In-call text chat (WebRTC DataChannel)
- 🛡️ DPI-resistant: forced TURN relay over TLS
- 🐳 One-command Docker deployment

## Requirements

- Ubuntu VPS with Docker + Docker Compose
- [Caddy](https://caddyserver.com/) (or any reverse proxy with auto-SSL)
- **Two subdomains** pointed at your VPS:
  - `call.yourdomain.com` — web app
  - `turn.yourdomain.com` — TURN server

## Quick Start

### 1. Clone & Configure

```bash
git clone <your-repo-url> relay-call
cd relay-call
cp .env.example .env
```

Edit `.env`:

```env
ROOM_PASSWORD=your-secret-password
TURN_SECRET=$(openssl rand -hex 32)
TURN_DOMAIN=turn.yourdomain.com
TURN_PORT=5349
VPS_PUBLIC_IP=<your-vps-ip>
```

### 2. Set Up Caddy

Add to your Caddyfile (see `Caddyfile.example`):

```
call.yourdomain.com {
    reverse_proxy localhost:3000
}

turn.yourdomain.com {
    respond "OK" 200
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

### 3. Provision TLS Certs for TURN

Wait a moment for Caddy to provision certs, then:

```bash
chmod +x copy-certs.sh
sudo ./copy-certs.sh
```

**Auto-renewal** (add to crontab):

```bash
sudo crontab -e
# Add:
0 3 * * * /path/to/relay-call/copy-certs.sh && cd /path/to/relay-call && docker compose restart coturn
```

### 4. Open Firewall Ports

```bash
sudo ufw allow 5349/tcp   # TURNS
sudo ufw allow 49152:49200/udp  # Media relay
```

### 5. Deploy

```bash
docker compose up -d --build
```

### 6. Use It

Open `https://call.yourdomain.com`, enter the room password, and call!

---

## Architecture

```
Browser A ──WSS :443──▶ Caddy ──▶ Node.js Signaling (:3000)
Browser A ──TURNS :5349──▶ coturn (host network) ──relay──▶ Browser B
```

- **No direct peer-to-peer** — all media forced through TURN relay (`iceTransportPolicy: 'relay'`)
- TURN uses **TLS encryption** — DPI sees only opaque HTTPS-like traffic
- Credentials are **time-limited** (HMAC-SHA1, 24h TTL)

## Fallback: Port 443 for TURN

If port 5349 is blocked (rare, mainly corporate firewalls), you can multiplex TURN and HTTPS on port 443 using `sslh`:

```bash
sudo apt install sslh
```

Configure `/etc/default/sslh`:

```
DAEMON_OPTS="--user sslh --listen 0.0.0.0:443 \
  --tls 127.0.0.1:8443 \
  --anyprot 127.0.0.1:5349 \
  --pidfile /var/run/sslh.pid"
```

Then reconfigure Caddy to listen on `:8443` and update `TURN_PORT=443` in `.env`.

## Troubleshooting

| Issue | Fix |
|---|---|
| "Wrong password" | Check `ROOM_PASSWORD` in `.env` matches what you enter |
| No video/audio between peers | Check firewall: TCP 5349 + UDP 49152-49200 open |
| TURN connection fails | Verify certs exist in `./certs/` and coturn logs: `docker compose logs coturn` |
| Blank video on mobile | Grant camera permissions in browser settings |

## License

MIT
