// Port-free HTTP mocks for driving the REAL Express app in-process: invoke the
// app as a (req, res) function — no sockets, so this runs anywhere restricted
// sandboxes, minimal CI). Shared by scripts/smoke.mjs and
// scripts/entrypoint-check.mjs.
//
// Two subtleties, learned the hard way:
// 1. Express re-prototypes req/res, shadowing class methods — so every method
//    middleware needs (stream reading, header access, teardown) must be an OWN
//    property bound here.
// 2. Mock response helpers must NEVER be named `json`/`send`/etc.: own
//    properties shadow Express's real methods and would swallow responses.
import { Readable } from 'node:stream';

const jar = new Map(); // cookie jar: name -> value

export function clearCookies() {
  jar.clear();
}

export function mockReq({ method, url, body, headers = {} }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({
    read() {
      if (payload) this.push(payload);
      this.push(null);
    },
  });
  for (const m of ['on', 'once', 'removeListener', 'emit', 'read', 'resume', 'pause', 'unshift']) {
    req[m] = req[m].bind(req);
  }
  // Express re-prototypes req under http.IncomingMessage, whose _destroy calls
  // socket.destroy(). The mock owns a trivial teardown instead.
  req._destroy = (err, cb) => cb(err);
  const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return Object.assign(req, {
    method,
    url,
    readable: true,
    complete: false,
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...(cookies ? { cookie: cookies } : {}),
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
  });
}

export function mockResFactory(onFinish) {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    finished: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    getHeaderNames() {
      return Object.keys(this.headers);
    },
    hasHeader(name) {
      return name.toLowerCase() in this.headers;
    },
    removeHeader(name) {
      delete this.headers[name.toLowerCase()];
    },
    write(chunk) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk, encoding, callback) {
      const done = [chunk, encoding, callback].find((a) => typeof a === 'function');
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) this.chunks.push(Buffer.from(chunk));
      this.finished = true;
      this.writableEnded = true;
      if (done) done();
      onFinish();
      return this;
    },
    bodyText() {
      return Buffer.concat(this.chunks).toString('utf8');
    },
    // NOTE: parsedBody, never `json` — see header comment.
    parsedBody() {
      try {
        return JSON.parse(this.bodyText());
      } catch {
        return null;
      }
    },
  };
  return res;
}

function collectCookies(res) {
  const setCookie = res.getHeader('set-cookie');
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

export function call(app, opts) {
  return new Promise((resolve, reject) => {
    const res = mockResFactory(() => {
      collectCookies(res);
      resolve(res);
    });
    try {
      app(mockReq(opts), res, (err) => reject(err ?? new Error('unhandled request (fell through Express stack)')));
    } catch (err) {
      reject(err);
    }
  });
}
