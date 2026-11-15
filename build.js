// Inlines the rules engine into the page so it is one self-contained HTML file.
const fs = require('fs');
const engine = fs.readFileSync(__dirname + '/src/engine.js', 'utf8');
const page = fs.readFileSync(__dirname + '/src/index.html', 'utf8');
fs.mkdirSync(__dirname + '/dist', { recursive: true });
fs.writeFileSync(__dirname + '/dist/scala40.html', page.replace('/*ENGINE*/', () => engine));
console.log('Built dist/scala40.html');
