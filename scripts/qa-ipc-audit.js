// QA wiring audit: every electronAPI.<fn> in preload.js must map to an
// ipcMain.handle('<channel>') in main.js, and every ipcMain.handle channel
// should be exposed by preload (or be a known send-style channel).
// Run: node scripts/qa-ipc-audit.js
'use strict';
const fs = require('fs');

const preload = fs.readFileSync('preload.js', 'utf8');
const main = fs.readFileSync('main.js', 'utf8');

// Channels preload invokes (ipcRenderer.invoke('name'))
const preloadInvoke = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1]);
// Channels preload listens on (ipcRenderer.on('name'))
const preloadListen = [...preload.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map(m => m[1]);
// Handlers main.js registers
const mainHandle = [...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map(m => m[1]);
// Broadcasts main.js sends
const mainSend = [...main.matchAll(/\.send\(\s*"([^"]+)"/g)].map(m => m[1])
  .concat([...main.matchAll(/broadcastToAllWindows\(\s*"([^"]+)"/g)].map(m => m[1]));

const missingHandler = preloadInvoke.filter(c => !mainHandle.includes(c));
const unusedHandler = mainHandle.filter(c => !preloadInvoke.includes(c));
const listenMissingSend = preloadListen.filter(c => !mainSend.includes(c));

let fail = 0;
if (missingHandler.length) {
  fail = 1;
  console.log('BROKEN: preload invokes with no ipcMain.handle:');
  missingHandler.forEach(c => console.log('  -', c));
}
if (listenMissingSend.length) {
  console.log('INFO: preload listens but main never broadcasts these (may be send-only or legacy):');
  listenMissingSend.forEach(c => console.log('  -', c));
}
if (unusedHandler.length) {
  console.log('INFO: main handles with no preload invoke (may be used via api.send or removed):');
  unusedHandler.forEach(c => console.log('  -', c));
}
console.log(`SUMMARY: preload.invoke=${preloadInvoke.length} main.handle=${mainHandle.length} missing=${missingHandler.length}`);
process.exit(fail);
