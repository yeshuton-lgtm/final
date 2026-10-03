const fs = require('fs');
const vm = require('vm');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-'));
const context = {
  require,
  console,
  Buffer,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  process: { env: { DATA_DIR: directory } },
  __dirname: root
};

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const server = http.createServer')[0], context);

const orderId = '1234567890abcdef';
const cleanUrl = 'https://vinfax.co/reports/index/TEST123';
context.writeData({
  orders: {
    [orderId]: {
      id: orderId,
      plan: 'single',
      status: 'pending',
      sessionId: 'cs_test_123',
      resultUrl: ''
    }
  },
  inventory: [
    {
      id: 'stock-1',
      url: `Open this URL: ${cleanUrl}`,
      status: 'available'
    },
    {
      id: 'stock-2',
      url: 'https://vinfax.co/reports/index/SECOND456',
      status: 'available'
    }
  ],
  bundles: {}
});

const request = { headers: { host: 'localhost', 'x-forwarded-proto': 'https' } };
const session = {
  id: 'cs_test_123',
  payment_status: 'paid',
  metadata: { order_id: orderId },
  customer_details: { email: 'buyer@example.com' }
};

(async () => {
  const [first, second] = await Promise.all([
    context.fulfillPaidOrderOnce(request, orderId, session.id, session),
    context.fulfillPaidOrderOnce(request, orderId, session.id, session)
  ]);

  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'fulfilled');

  const data = context.readData();
  assert.equal(data.orders[orderId].resultUrl, cleanUrl);
  assert.equal(data.orders[orderId].status, 'fulfilled');
  assert.equal(data.inventory.filter(item => item.status === 'assigned').length, 1);
  assert.equal(data.inventory.filter(item => item.status === 'available').length, 1);
  assert.equal(data.inventory[0].url, cleanUrl);

  const page = context.orderHtml(data.orders[orderId]);
  assert.match(page, /Open Report/);
  assert.match(page, new RegExp(cleanUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page, /My Reports|Copy order link|report_orders/);

  console.log('PASS: paid order delivers one clean link and concurrent fulfillment deducts one inventory item');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
