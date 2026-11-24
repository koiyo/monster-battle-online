// モンスターバトル オンライン版サーバー
// - 静的ファイル（public/）の配信と WebSocket による状態同期を1プロセスで担当
// - 状態はすべてサーバーのメモリ上（ルーム単位）。再起動するとルームは消える。
// （カードバトル オンライン版のサーバー基盤を流用）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fp = path.join(PUBLIC, path.normalize(file));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { game, seats: [ {playerId, ws} x2 ], lastActivity }
// 複数ルーム同時並行対応。各ルームの状態は完全に独立。
const MAX_ROOMS = 50;              // 暴走防止の上限（通常利用では到達しない）
const ROOM_TTL_MS = 30 * 60 * 1000; // 30分間操作がなく両者切断中のルームは掃除する
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = room.seats.some(s => s && s.ws);
    if (!anyoneConnected && now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function stateFor(room, seatIndex) {
  const state = game.viewFor(room.game, seatIndex);
  const foeSeat = room.seats[1 - seatIndex];
  state.foeConnected = !!(foeSeat && foeSeat.ws);
  state.foeJoined = !!foeSeat;
  return state;
}

function broadcast(room) {
  room.seats.forEach((seat, i) => {
    if (seat && seat.ws) send(seat.ws, { type: 'state', state: stateFor(room, i) });
  });
}

function attach(ws, room, seatIndex, code) {
  room.lastActivity = Date.now();
  room.seats[seatIndex].ws = ws;
  ws._roomCode = code;
  ws._seat = seatIndex;
  send(ws, {
    type: 'joined', code, seat: seatIndex,
    playerId: room.seats[seatIndex].playerId,
    state: stateFor(room, seatIndex),
  });
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    if (raw.length > 256 * 1024) return; // 異常に大きいメッセージは無視（カード編集データの持ち込みを許すため上限は256KB）
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'ルーム数が上限に達しています。しばらくしてからお試しください' });
      const code = makeCode();
      // 持ち込みカードセット＋デッキはサーバー側で検証し、不正なら標準へフォールバック
      const loadout = game.resolveLoadout(msg.loadout);
      const room = {
        game: game.newGame(msg.name || 'プレイヤー1', loadout),
        seats: [{ playerId: crypto.randomUUID(), ws: null }, null],
        lastActivity: Date.now(),
      };
      rooms.set(code, room);
      attach(ws, room, 0, code);
      if (loadout.fallback) send(ws, { type: 'notice', message: '送られたカード／デッキが使えなかったため、標準デッキで対戦します' });
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'ルームが見つかりません' });
      if (room.seats[1] && room.seats[1].ws) return send(ws, { type: 'error', message: 'ルームは満員です' });
      let joinLoadout = null;
      if (!room.seats[1]) {
        room.seats[1] = { playerId: crypto.randomUUID(), ws: null };
        joinLoadout = game.resolveLoadout(msg.loadout);
        game.startGame(room.game, msg.name || 'プレイヤー2', joinLoadout);
      }
      attach(ws, room, 1, code);
      if (joinLoadout && joinLoadout.fallback) send(ws, { type: 'notice', message: '送られたカード／デッキが使えなかったため、標準デッキで対戦します' });
      return;
    }

    if (msg.type === 'reconnect') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'ルームが見つかりません（サーバー再起動で消えた可能性があります）' });
      const idx = room.seats.findIndex(s => s && s.playerId === msg.playerId);
      if (idx < 0) return send(ws, { type: 'error', message: 'プレイヤー情報が見つかりません' });
      attach(ws, room, idx, code);
      return;
    }

    // 以下は入室済みプレイヤーの操作
    const room = rooms.get(ws._roomCode);
    if (!room || ws._seat == null) return;
    room.lastActivity = Date.now();
    const pi = ws._seat;
    let result = null;
    if (msg.type === 'play') result = game.playCard(room.game, pi, msg.handIndex, msg.target || null);
    else if (msg.type === 'attack') result = game.attack(room.game, pi, msg.attackerUid, msg.target);
    else if (msg.type === 'end') result = game.endTurn(room.game, pi);
    else if (msg.type === 'surrender') result = game.surrender(room.game, pi);
    else if (msg.type === 'restart') {
      if (room.game.phase === 'over') { game.restart(room.game); result = { ok: true }; }
      else result = { error: '対戦中は再戦できません' };
    }
    if (result && result.error) send(ws, { type: 'error', message: result.error });
    broadcast(room);
  });

  ws.on('close', () => {
    const room = rooms.get(ws._roomCode);
    if (room && room.seats[ws._seat] && room.seats[ws._seat].ws === ws) {
      room.seats[ws._seat].ws = null; // 席は保持し、再接続で復帰できるようにする
      broadcast(room);
    }
  });
});

server.listen(PORT, () => console.log(`モンスターバトル オンライン版サーバー起動: http://localhost:${PORT}`));
