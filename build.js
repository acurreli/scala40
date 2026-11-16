// Inlines the rules engine and the page script so the game is one self-contained HTML file.
const fs = require('fs');
const read = (f) => fs.readFileSync(__dirname + '/' + f, 'utf8');
const html = read('src/index.html')
  .replace('/*ENGINE*/', () => read('src/engine.js'))
  .replace('/*CLIENT*/', () => read('src/client.js'));
fs.mkdirSync(__dirname + '/dist', { recursive: true });
fs.writeFileSync(__dirname + '/dist/scala40.html', html);
fs.copyFileSync(__dirname + '/src/admin.html', __dirname + '/dist/admin.html');
console.log('Built dist/scala40.html');
