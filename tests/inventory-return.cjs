const fs = require('fs');
const vm = require('vm');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-return-'));
const context = { require, console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
  process: { env: { DATA_DIR: directory, ADMIN_PASSWORD: 'test' } }, __dirname: root };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const server = http.createServer')[0], context);
vm.runInContext('readBody = async req => req.body; fetchText = async () => testPage;', context);
const id = '1234567890abcdef';
const url = 'https://vinfax.co/reports/index/TEST123';
context.writeData({ orders: { [id]: { id, status: 'fulfilled', resultUrl: url, resultType: 'single' } },
  inventory: [{ id: 'stock', url, status: 'assigned', assignedBundle: 'single-sale' }], bundles: {} });
async function call(password) {
  let status, body;
  await context.handleApi({ method: 'POST', url: '/api/inventory/return-replaced-single?password=' + password,
    headers: { host: 'localhost' }, body: { confirm: 'return-replaced-single', orderId: id, url } },
  { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } }, '/api/inventory/return-replaced-single');
  return { status, body };
}
(async () => {
  context.testPage = 'Used report';
  assert.equal((await call('wrong')).status, 401);
  assert.equal((await call('test')).status, 409);
  context.testPage = `<input x-model="data.vin"> hash: '', vin: ''`;
  assert.equal((await call('test')).body.returned, 1);
  const data = context.readData();
  assert.equal(data.orders[id].resultUrl, '');
  assert.equal(data.orders[id].status, 'fulfilled');
  assert.equal(data.inventory[0].status, 'available');
  assert.equal(data.inventoryReturns.length, 1);
  assert.equal((await call('test')).status, 409);
  console.log('PASS: authorization, used-page rejection, return with order withdrawal, audit, replay protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
