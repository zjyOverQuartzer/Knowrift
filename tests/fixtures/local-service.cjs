const http = require('node:http');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let server;
input.once('line', line => {
  const config = JSON.parse(line), mode = process.argv[2], service = process.argv[3] || 'java';
  if (mode === 'crash') process.exit(2);
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/internal/shutdown') { res.end('{}'); server.close(() => process.exit(0)); return; }
    res.end(JSON.stringify({ ready: true, service, instanceId: config.instanceId, protocolVersion: mode === 'badhealth' ? 2 : 1 }));
  });
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', service, port: server.address().port, instanceId: config.instanceId, protocolVersion: mode === 'badprotocol' ? 2 : 1 })));
});
input.on('close', () => { if (server) server.close(() => process.exit(0)); else process.exit(0); });
