// Moteur! signalisation intercom
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      const room = (url.searchParams.get('room') || '').slice(0, 60);
      if (!room) return new Response('room manquant', { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
    }
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (url.pathname === '/turn') {
      // Relais secondaire (ex. ExpressTURN) : identifiants gardés en secrets du Worker, jamais dans le dépôt.
      const out = [];
      if (env.RELAY_URLS && env.RELAY_USER && env.RELAY_PASS) {
        out.push({ urls: env.RELAY_URLS.split(',').map(s => s.trim()).filter(Boolean), username: env.RELAY_USER, credential: env.RELAY_PASS });
      }
      if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
        try {
          const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + env.TURN_KEY_ID + '/credentials/generate-ice-servers', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.TURN_API_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ ttl: 86400 })
          });
          const j = await r.json(); const s = j.iceServers; if (Array.isArray(s)) out.push(...s); else if (s) out.push(s);
        } catch (e) {}
      }
      return new Response(JSON.stringify({ iceServers: out }), { headers: cors });
    }
    return new Response('Moteur! signal OK', { headers: cors });
  }
};

export class Room {
  constructor(state, env) { this.clients = new Map(); this.timers = new Map(); }
  async fetch(req) {
    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').slice(0, 24);
    const name = (url.searchParams.get('name') || '?').slice(0, 20);
    if (!id) return new Response('id manquant', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const old = this.clients.get(id);
    const me = { id, name, ws: server, chans: old ? old.chans : new Set() };
    if (old) { try { old.ws.close(1000, 'replaced'); } catch (e) {} }
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.clients.set(id, me);
    server.addEventListener('message', ev => this.onMsg(me, ev.data));
    const gone = () => {
      if (this.clients.get(id) !== me) return;
      this.timers.set(id, setTimeout(() => this.drop(id), 8000));
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  onMsg(me, raw) {
    if (typeof raw !== 'string' || raw.length > 20000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'ping') return this.send(me, { t: 'pong' });
    const ch = String(m.ch || '').slice(0, 40);
    if (m.t === 'join' && ch) {
      const fresh = !me.chans.has(ch);
      me.chans.add(ch);
      const list = [];
      for (const c of this.clients.values()) if (c !== me && c.chans.has(ch)) list.push({ id: c.id, name: c.name });
      this.send(me, { t: 'peers', ch, list });
      if (fresh) this.toChan(ch, me, { t: 'joined', ch, id: me.id, name: me.name });
    } else if (m.t === 'leave' && ch) {
      if (me.chans.delete(ch)) this.toChan(ch, me, { t: 'left', ch, id: me.id });
    } else if (m.t === 'sig') {
      const to = this.clients.get(String(m.to || ''));
      if (to && to.chans.has(ch) && me.chans.has(ch)) this.send(to, { t: 'sig', from: me.id, ch, data: m.data });
    }
  }
  send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) {} }
  toChan(ch, except, o) { for (const c of this.clients.values()) if (c !== except && c.chans.has(ch)) this.send(c, o); }
  drop(id) {
    const c = this.clients.get(id); if (!c) return;
    this.clients.delete(id); this.timers.delete(id);
    for (const ch of c.chans) this.toChan(ch, c, { t: 'left', ch, id });
  }
}
