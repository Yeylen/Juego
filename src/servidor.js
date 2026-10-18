import { DurableObject } from 'cloudflare:workers';

const CODIGO_SALA = /^[A-HJ-NP-Z2-9]{8,12}$/;
const CORSO = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, servicio: 'VECTOR / 12', salas: 'WebSocket' }), { headers: CORSO });
    }
    if (url.pathname === '/ws') {
      const codigo = String(url.searchParams.get('room') || '').toUpperCase();
      if (!CODIGO_SALA.test(codigo)) return new Response('Código de sala incorrecto', { status: 400 });
      if (request.method !== 'GET') return new Response('Método no permitido', { status: 405 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Se requiere WebSocket', { status: 426 });
      const origin = request.headers.get('Origin');
      // Solo se permiten clientes que proceden del propio sitio del juego.
      if (origin) {
        try { if (new URL(origin).host !== url.host) return new Response('Origen no permitido', { status: 403 }); }
        catch (_) { return new Response('Origen incorrecto', { status: 403 }); }
      }
      return env.SALAS.getByName(codigo).fetch(request);
    }
    // Archivos HTML, imágenes y otros recursos estáticos: mismo dominio que el servidor.
    return env.ASSETS.fetch(request);
  }
};

export class SalaOnline extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Se usa la API WebSocket con hibernación: no se retienen conexiones en memoria.
  }

  avisoPresencia(excepto = null) {
    const sockets = this.ctx.getWebSockets().filter(ws => ws !== excepto && ws.readyState === 1);
    const data = JSON.stringify({ t: 'presence', count: sockets.length });
    for (const ws of sockets) { try { ws.send(data); } catch (_) {} }
  }

  async fetch(request) {
    const existentes = this.ctx.getWebSockets().filter(ws => ws.readyState === 1);
    if (existentes.length >= 2) return new Response('Sala completa: máximo dos jugadores', { status: 409 });
    const nombre = String(new URL(request.url).searchParams.get('name') || 'Piloto').trim().slice(0, 16).replace(/[<>\u0000-\u001f]/g, '') || 'Piloto';
    const pair = new WebSocketPair();
    const [cliente, servidor] = Object.values(pair);
    this.ctx.acceptWebSocket(servidor);
    const id = crypto.randomUUID();
    servidor.serializeAttachment({ id, name: nombre, last: 0 });
    const total = existentes.length + 1;
    servidor.send(JSON.stringify({ t: 'welcome', id, slot: total, count: total }));
    this.avisoPresencia();
    return new Response(null, { status: 101, webSocket: cliente });
  }

  async webSocketMessage(ws, mensaje) {
    if (typeof mensaje !== 'string' || mensaje.length > 1000) return;
    let data;
    try { data = JSON.parse(mensaje); } catch (_) { return; }
    if (data?.t !== 'state' || !data.state || typeof data.state !== 'object') return;
    const info = ws.deserializeAttachment();
    if (!info?.id) return;
    const ahora = Date.now();
    if (ahora - (info.last || 0) < 75) return; // máximo aprox. 13 estados por segundo
    const campos = ['x', 'z', 'yaw', 'u', 'steer', 'roll', 'pitch'];
    const estado = {};
    for (const campo of campos) {
      const valor = data.state[campo];
      if (typeof valor !== 'number' || !Number.isFinite(valor)) return;
      estado[campo] = valor;
    }
    if (Math.abs(estado.x) > 10000 || Math.abs(estado.z) > 10000 || Math.abs(estado.u) > 250 ||
        Math.abs(estado.steer) > 2 || Math.abs(estado.roll) > 2 || Math.abs(estado.pitch) > 2 || Math.abs(estado.yaw) > 100000) return;
    info.last = ahora;
    ws.serializeAttachment(info);
    const salida = JSON.stringify({ t: 'state', id: info.id, name: info.name, state: estado });
    for (const otro of this.ctx.getWebSockets()) {
      if (otro !== ws && otro.readyState === 1) { try { otro.send(salida); } catch (_) {} }
    }
  }

  async webSocketClose(ws, codigo, motivo) {
    try { ws.close(codigo, motivo); } catch (_) {}
    this.avisoPresencia(ws);
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'Error de conexión'); } catch (_) {}
    this.avisoPresencia(ws);
  }
}
