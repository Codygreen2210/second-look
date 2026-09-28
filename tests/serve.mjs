// Tiny static server for the fixtures. Unknown paths return 404 on purpose.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures')
export function serve(port = 0) {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]))
      if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) { rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); rsp.end(fs.readFileSync(f)) }
      else if (req.url === '/x') { rsp.writeHead(200); rsp.end('ok') }
      else { rsp.writeHead(404); rsp.end('not found') }
    }).listen(port, '127.0.0.1', () => res(s))
  })
}
