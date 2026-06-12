/* BarkOggle multiplayer server
   - serves the game from /public
   - random matchmaking (queue per mode+type) -> avatars only, no video
   - private friend rooms via short code -> camera allowed between friends
   - relays each player's score to the opponent
   - report logging + owner/admin live view  (NO video recording)
*/
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// set ADMIN_KEY in Render env vars; default only for local testing
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));
// owner view of reports: https://YOURAPP/admin/reports?key=YOURKEY
app.get('/admin/reports', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('forbidden');
  res.json(reports);
});

// ---------- Stripe payments + Supabase entitlement grants ----------
// Set these as environment variables on Render (NOT in code):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || '';
const SB_URL = process.env.SUPABASE_URL || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
let sbAdmin = null;
if (SB_URL && SB_SERVICE) {
  try { const { createClient } = require('@supabase/supabase-js'); sbAdmin = createClient(SB_URL, SB_SERVICE); }
  catch (e) { console.error('Supabase admin init failed:', e.message); }
}
const PRICES = {
  noads:     { price: 'price_1Tg0TyDBko9QTMUr9j3Pc45j', col: 'paid_noads' },
  vip:       { price: 'price_1Tg0U5DBko9QTMUr1fERB94N', col: 'paid_vip' },
  supporter: { price: 'price_1Tg0UDDBko9QTMUrIuzY2DOB', col: 'paid_supporter' },
  'skin:galaxy':  { price: 'price_1Tg1AJDBko9QTMUrUoVodKa4', skin: 'galaxy' },
  'skin:rainbow': { price: 'price_1Tg1AODBko9QTMUrSNkTv0vP', skin: 'rainbow' },
  'skin:inferno': { price: 'price_1Tg1AUDBko9QTMUr18LSLcQm', skin: 'inferno' },
  'skin:frost':   { price: 'price_1Tg1AaDBko9QTMUrgkZvnVao', skin: 'frost' },
  'skin:shadow':  { price: 'price_1Tg1AgDBko9QTMUrxsFh16Se', skin: 'shadow' },
  'skin:toxic':   { price: 'price_1Tg1AmDBko9QTMUrj8a1ipPr', skin: 'toxic' },
};

// Stripe webhook needs the RAW body for signature verification (before any json parser)
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WH) return res.status(503).send('stripe off');
  let evt;
  try { evt = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WH); }
  catch (e) { console.error('webhook sig fail:', e.message); return res.status(400).send('bad signature'); }
  if (evt.type === 'checkout.session.completed') {
    const s = evt.data.object;
    const did = s.metadata && s.metadata.device_id;
    const item = s.metadata && s.metadata.item;
    if (did && item && PRICES[item] && sbAdmin) {
      const entry = PRICES[item];
      try {
        if (entry.skin) {
          const { data: row } = await sbAdmin.from('profiles').select('paid_skins').eq('device_id', did).maybeSingle();
          const list = (row && row.paid_skins) || [];
          if (!list.includes(entry.skin)) list.push(entry.skin);
          await sbAdmin.from('profiles').upsert({ device_id: did, paid_skins: list, updated_at: new Date().toISOString() }, { onConflict: 'device_id' });
        } else {
          const patch = { device_id: did, updated_at: new Date().toISOString() };
          patch[entry.col] = true;
          if (item === 'vip' || item === 'supporter') { patch.paid_vip = true; patch.paid_noads = true; }
          await sbAdmin.from('profiles').upsert(patch, { onConflict: 'device_id' });
        }
        console.log('granted', item, 'to', did);
      } catch (e) { console.error('grant failed:', e.message); }
    }
  }
  res.json({ received: true });
});

// Create a Stripe Checkout session for one item
app.post('/create-checkout-session', express.json(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'stripe_off' });
  const item = req.body && req.body.item;
  const did = req.body && req.body.device_id;
  if (!PRICES[item] || !did) return res.status(400).json({ error: 'bad_request' });
  const base = PUBLIC_URL || req.headers.origin || ('https://' + req.headers.host);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRICES[item].price, quantity: 1 }],
      metadata: { device_id: did, item },
      success_url: base + '/?paid=' + item,
      cancel_url: base + '/?cancel=1',
    });
    res.json({ url: session.url });
  } catch (e) { console.error('checkout failed:', e.message); res.status(500).json({ error: 'checkout_failed' }); }
});

const queues = {};   // "mode|type" -> [socket]
const rooms = {};     // roomId -> {a,b}
const codes = {};     // CODE -> hostSocketId
let nextRoom = 1;
const reports = [];   // in-memory ring buffer

// ---------- Friends / presence ----------
// online[deviceId] = { sid, nick, coat, elo } for currently connected players
const online = {};
function onlineInfo(devId){ const o = online[devId]; if(!o) return null; const s = io.sockets.sockets.get(o.sid); if(!s||!s.connected){ delete online[devId]; return null; } return o; }
function pushFriends(devId){ // tell a player the live status of friends they asked about
  const o = online[devId]; if(!o) return; const s = io.sockets.sockets.get(o.sid); if(!s) return;
  const list = (s.data.friends||[]).map(f=>{ const fo = onlineInfo(f.id); return { id:f.id, nick: fo?fo.nick:f.nick, coat: fo?fo.coat:f.coat, elo: fo?fo.elo:(f.elo||1000), online: !!fo }; });
  s.emit('friendStatus', list);
}
function notifyFriendsOfMe(devId){ // when I come online/offline, refresh anyone who has me as friend
  for(const did in online){ const s = io.sockets.sockets.get(online[did].sid); if(s && (s.data.friends||[]).some(f=>f.id===devId)) pushFriends(did); }
}

function broadcastCount() { io.emit('players', io.engine.clientsCount); }
function genCode() { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (codes[c]); return c; }
function cleanupQueue(s) { for (const k in queues) { queues[k] = queues[k].filter(x => x && x.id !== s.id && x.connected); if (!queues[k].length) delete queues[k]; } }
function cleanupCodes(s) { for (const c in codes) { if (codes[c] === s.id) delete codes[c]; } }
function pair(a, b, friends) {
  const room = 'r' + (nextRoom++);
  rooms[room] = { a: a.id, b: b.id };
  a.data.room = room; b.data.room = room;
  a.join(room); b.join(room);
  const mode = a.data.mode || 'cam';
  a.emit('matched', { room, friends, mode, initiator: true, oppNick: b.data.nick, oppCoat: b.data.coat, oppId: b.data.devId || '', oppElo: b.data.elo || 1000 });
  b.emit('matched', { room, friends, mode, initiator: false, oppNick: a.data.nick, oppCoat: a.data.coat, oppId: a.data.devId || '', oppElo: a.data.elo || 1000 });
}
function leaveRoom(s) {
  const room = s.data && s.data.room;
  if (room && rooms[room]) { s.to(room).emit('oppLeft'); delete rooms[room]; }
  if (s.data) s.data.room = null;
}
function ident(s, d) { s.data.nick = String((d && d.nick) || 'Dog').slice(0, 14); s.data.coat = (d && d.coat) || 'gray'; s.data.mode = (d && d.mode) || 'cam';
  if (d && d.devId) { s.data.devId = String(d.devId).slice(0,64); s.data.elo = (d && d.elo) || 1000;
    online[s.data.devId] = { sid: s.id, nick: s.data.nick, coat: s.data.coat, elo: s.data.elo };
  }
  if (d && Array.isArray(d.friends)) s.data.friends = d.friends.slice(0,100); }

io.on('connection', socket => {
  broadcastCount();

  // random match (strangers) -> avatars only
  socket.on('queue', d => {
    ident(socket, d);
    const key = socket.data.mode + '|' + ((d && d.type) || 'casual');
    cleanupQueue(socket);
    const q = queues[key] || (queues[key] = []);
    let p = null;
    while (q.length) { const c = q.shift(); if (c && c.connected && c.id !== socket.id) { p = c; break; } }
    if (p) pair(p, socket, false); else q.push(socket);
  });

  // private friend room
  socket.on('createRoom', d => {
    ident(socket, d);
    cleanupCodes(socket);
    const code = genCode();
    codes[code] = socket.id;
    socket.data.code = code;
    socket.emit('roomCode', { code });
  });
  socket.on('joinRoom', d => {
    ident(socket, d);
    const code = String((d && d.code) || '').toUpperCase().trim();
    const hostId = codes[code];
    const host = hostId && io.sockets.sockets.get(hostId);
    if (host && host.connected && host.id !== socket.id) {
      delete codes[code]; delete host.data.code;
      pair(host, socket, true);
    } else {
      socket.emit('joinFail');
    }
  });

  socket.on('score', d => { if (d && d.room) socket.to(d.room).emit('oppScore', d.n); });

  // WebRTC signaling relay (friend rooms only, used for camera/voice)
  socket.on('signal', d => { if (d && d.room) socket.to(d.room).emit('signal', d.data); });

  // safe report: metadata only, no media
  socket.on('report', d => {
    d = d || {};
    const r = {
      t: new Date().toISOString(),
      by: socket.data.nick || '?',
      reported: String(d.reportedNick || '?').slice(0, 14),
      reason: d.reason || 0,
      mode: d.mode || '',
      room: d.room || ''
    };
    reports.push(r);
    if (reports.length > 500) reports.shift();
    console.log('[REPORT]', JSON.stringify(r));
    try { fs.appendFileSync(path.join(__dirname, 'reports.log'), JSON.stringify(r) + '\n'); } catch (e) {}
    io.to('admins').emit('report', r);
  });

  // owner live feed of reports
  socket.on('adminAuth', d => {
    if (d && d.key === ADMIN_KEY) { socket.join('admins'); socket.emit('adminOk', { reports }); }
    else socket.emit('adminFail');
  });

  // ---------- presence + friends ----------
  socket.on('hello', d => { ident(socket, d); if (socket.data.devId) { notifyFriendsOfMe(socket.data.devId); pushFriends(socket.data.devId); } });
  socket.on('refreshFriends', d => { if (d && Array.isArray(d.friends)) socket.data.friends = d.friends.slice(0,100); if (socket.data.devId) pushFriends(socket.data.devId); });

  // send a friend request to a player by their code (their device shares a short friend-code = first 5 of devId hash, but we use the live room code OR an explicit add-by-id)
  socket.on('friendReq', d => {
    d = d || {}; const targetId = String(d.toId||''); const to = onlineInfo(targetId);
    if (!to) { socket.emit('friendReqResult', { ok:false, reason:'offline' }); return; }
    const ts = io.sockets.sockets.get(to.sid); if (!ts) { socket.emit('friendReqResult', { ok:false, reason:'offline' }); return; }
    ts.emit('friendReq', { fromId: socket.data.devId, fromNick: socket.data.nick, fromCoat: socket.data.coat, fromElo: socket.data.elo||1000 });
    socket.emit('friendReqResult', { ok:true });
  });
  // accept -> both add each other (client persists); server just relays acceptance
  socket.on('friendAccept', d => {
    d = d || {}; const otherId = String(d.toId||''); const oo = onlineInfo(otherId); if(!oo) return;
    const os = io.sockets.sockets.get(oo.sid); if(!os) return;
    os.emit('friendAdded', { id: socket.data.devId, nick: socket.data.nick, coat: socket.data.coat, elo: socket.data.elo||1000 });
    socket.emit('friendAdded', { id: otherId, nick: oo.nick, coat: oo.coat, elo: oo.elo||1000 });
  });

  // challenge a friend directly -> opens a private room, sends invite to friend
  socket.on('challenge', d => {
    d = d || {}; const targetId = String(d.toId||''); const to = onlineInfo(targetId);
    if (!to) { socket.emit('challengeResult', { ok:false, reason:'offline' }); return; }
    const ts = io.sockets.sockets.get(to.sid); if (!ts || !ts.connected) { socket.emit('challengeResult', { ok:false, reason:'offline' }); return; }
    socket.data.mode = (d.mode && String(d.mode)) || socket.data.mode || 'cam';
    const code = genCode(); codes[code] = socket.id; socket.data.code = code;
    ts.emit('challengeIn', { fromId: socket.data.devId, fromNick: socket.data.nick, fromCoat: socket.data.coat, mode: socket.data.mode, code });
    socket.emit('challengeResult', { ok:true, code });
  });
  socket.on('challengeDecline', d => {
    d = d || {}; const otherId = String(d.toId||''); const oo = onlineInfo(otherId); if(!oo) return;
    const os = io.sockets.sockets.get(oo.sid); if(os) os.emit('challengeDeclined', { byNick: socket.data.nick });
  });

  socket.on('friendReqByCode', d => {
    d = d || {}; const code = String(d.code||'').toUpperCase().trim(); if (code.length < 4) return;
    // friend-code = last 5 chars of devId (alphanumeric, uppercased)
    let targetId = null;
    for (const did in online) { const sc = did.replace(/[^a-zA-Z0-9]/g,'').slice(-5).toUpperCase(); if (sc === code && did !== socket.data.devId) { targetId = did; break; } }
    if (!targetId) { socket.emit('friendReqResult', { ok:false, reason:'offline' }); return; }
    const to = onlineInfo(targetId); const ts = to && io.sockets.sockets.get(to.sid);
    if (!ts) { socket.emit('friendReqResult', { ok:false, reason:'offline' }); return; }
    ts.emit('friendReq', { fromId: socket.data.devId, fromNick: socket.data.nick, fromCoat: socket.data.coat, fromElo: socket.data.elo||1000 });
    socket.emit('friendReqResult', { ok:true });
  });
  socket.on('leave', () => { leaveRoom(socket); cleanupQueue(socket); cleanupCodes(socket); });
  socket.on('disconnect', () => { const dev = socket.data.devId; leaveRoom(socket); cleanupQueue(socket); cleanupCodes(socket); if (dev && online[dev] && online[dev].sid === socket.id) { delete online[dev]; notifyFriendsOfMe(dev); } broadcastCount(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('BarkOggle server running on port ' + PORT));
