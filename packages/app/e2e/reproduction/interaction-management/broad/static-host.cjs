const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname, '../../../../../../docs/ui-redesign/interaction-audit-v3-20261029/management-broad-production')
const suites = new Set(['system-overview-scope','agent-extension-scope','skill-lifecycle-scope','experience-candidate-scope','provider-scope','personal-workspace-scope','control-scope','tenant-platform-scope','artifact-evidence-scope','runtime-insight'])
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json' }
http.createServer((request, response) => {
  if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405); return response.end() }
  let url
  try { url = new URL(request.url, 'http://127.0.0.1:4481') } catch { response.writeHead(400); return response.end() }
  if (url.pathname === '/__ready') { response.writeHead(200); return response.end('isolated static fixtures') }
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { response.writeHead(400); return response.end() }
  if (pathname === '/') {
    const suite = request.headers['x-management-suite']
    if (!suites.has(suite)) { response.writeHead(400); return response.end('fixture identity required') }
    pathname = '/' + suite + '/index.html'
  }
  const file = path.resolve(root, '.' + pathname)
  if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end() }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end() }
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-store' })
  if (request.method === 'HEAD') return response.end()
  fs.createReadStream(file).pipe(response)
}).listen(4481, '127.0.0.1', () => console.log('Isolated management production fixtures:127.0.0.1:4481'))
