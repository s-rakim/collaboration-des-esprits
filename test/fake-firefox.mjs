/**
 * A stand-in for Firefox's remote control port.
 *
 * Firefox is not on every machine these tests run on, so this answers the
 * handful of WebDriver BiDi commands the room sends, over a real WebSocket,
 * the way Firefox does. What is proven against it is that the room speaks the
 * protocol as written — not that Firefox behaves, which only Firefox can show.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const frame = (text) => {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length])
    : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
  return Buffer.concat([head, data]);
};

export function fakeFirefox({ pages = {} } = {}) {
  const seen = [];
  const state = { url: 'about:blank', contexts: ['ctx-1'] };
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });

  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let at = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); at = 10; }
        if (buffer.length < at + 4 + len) return;
        const mask = buffer.subarray(at, at + 4);
        const body = Buffer.from(buffer.subarray(at + 4, at + 4 + len));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(at + 4 + len);
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;

        const msg = JSON.parse(body.toString('utf8'));
        seen.push(msg);
        const reply = (result) => socket.write(frame(JSON.stringify({ type: 'success', id: msg.id, result })));
        const refuse = (message) => socket.write(frame(JSON.stringify({ type: 'error', id: msg.id, error: 'unknown error', message })));

        switch (msg.method) {
          case 'session.new': reply({ sessionId: 's1', capabilities: {} }); break;
          case 'browsingContext.getTree': reply({ contexts: state.contexts.map((context) => ({ context, url: state.url })) }); break;
          case 'browsingContext.create': state.contexts.push('ctx-new'); reply({ context: 'ctx-new' }); break;
          case 'browsingContext.navigate':
            if (msg.params.url.includes('unreachable.example')) { refuse('NS_ERROR_UNKNOWN_HOST'); break; }
            state.url = msg.params.url;
            reply({ navigation: 'n1', url: state.url });
            break;
          case 'script.evaluate': {
            const page = pages[state.url] ?? { title: 'A page', text: `text of ${state.url}`, links: [] };
            reply({ type: 'success', realm: 'r1', result: { type: 'string', value: JSON.stringify({ url: state.url, ...page }) } });
            break;
          }
          case 'browsingContext.captureScreenshot': reply({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64') }); break;
          default: refuse(`unknown command ${msg.method}`);
        }
      }
    });
    socket.on('error', () => {});
  });

  return {
    seen,
    state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
