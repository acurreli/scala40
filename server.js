// Minimal web server for the prototype: serves the single game page.
const http = require('http');
const fs = require('fs');
const path = require('path');
const page = fs.readFileSync(path.join(__dirname, 'dist', 'scala40.html'));
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(port, '0.0.0.0', () => console.log('Scala 40 listening on ' + port));
