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

  function reset(count = 2) {
    context.writeData({ orders: Object.fromEntries(['a', 'b'].map(id => [id, {
      id, plan: 'single', status: 'pending', sessionId: `cs_${id}`, resultUrl: ''
    }])), inventory: Array.from({ length: count }, (_, i) => ({
      id: `stock-${i}`, url: `https://vinfax.co/reports/index/TEST${i}`, status: 'available'
    })), bundles: {} });
  }
  function payment(id, status = 'paid') {
    return { id: `cs_${id}`, payment_status: status, metadata: { order_id: id } };
  }
  reset();
  for (let i = 0; i < 20; i++) {
    await context.fulfillPaidOrderOnce(request, 'a', 'cs_a', payment('a', 'unpaid'));
  }
  assert.equal(context.readData().inventory.filter(x => x.status === 'available').length, 2);
  assert.equal(context.readData().orders.a.status, 'pending');
  const pendingPage = context.orderHtml(context.readData().orders.a);
  assert.match(pendingPage, /checkPayment/);
  for (const html of [page, pendingPage]) {
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    assert.doesNotMatch(html, /localStorage|document.cookie|my-reports/i);
  }

  const originalRetrieve = context.retrieveStripeCheckoutSession;
  context.retrieveStripeCheckoutSession = async () => { throw new Error('temporary network failure'); };
  await assert.rejects(context.fulfillPaidOrderOnce(request, 'a', 'cs_a'), /temporary network/);
  assert.equal(context.readData().orders.a.status, 'pending');
  assert.equal(context.readData().orders.a.processingAt, '');
  context.retrieveStripeCheckoutSession = originalRetrieve;
  await assert.rejects(context.fulfillPaidOrderOnce(request, 'a', 'cs_b', payment('b')), /does not belong/);
  assert.equal(context.readData().orders.a.status, 'pending');
  const retried = await context.fulfillPaidOrderOnce(request, 'a', 'cs_a', payment('a'));
  assert.equal(retried.status, 'fulfilled');

  for (let i = 0; i < 20; i++) {
    reset();
    await Promise.all(['a', 'b'].map(id => context.fulfillPaidOrderOnce(request, id, `cs_${id}`, payment(id))));
    const concurrent = context.readData();
    assert.equal(concurrent.orders.a.status, 'fulfilled');
    assert.equal(concurrent.orders.b.status, 'fulfilled');
    assert.notEqual(concurrent.orders.a.resultUrl, concurrent.orders.b.resultUrl);
    assert.equal(concurrent.inventory.filter(x => x.status === 'assigned').length, 2);
  }

  reset();
  context.retrieveStripeCheckoutSession = async () => {
    const otherWrite = context.readData();
    otherWrite.inventory.push({ id: 'new-stock', url: 'https://vinfax.co/reports/index/NEW', status: 'available' });
    context.writeData(otherWrite);
    return payment('a');
  };
  await context.fulfillPaidOrderOnce(request, 'a', 'cs_a');
  assert.equal(context.readData().inventory.length, 3);
  context.retrieveStripeCheckoutSession = originalRetrieve;

  reset(0);
  assert.equal((await context.fulfillPaidOrderOnce(request, 'a', 'cs_a', payment('a'))).status, 'manual');
  assert.equal(context.readData().inventory.length, 0);

  console.log('PASS: direct delivery, duplicate callbacks, 20 unpaid attempts, timeout retry, session isolation, concurrent buyers, empty stock and page scripts');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
