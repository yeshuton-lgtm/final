const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ require, console, Buffer, URL, URLSearchParams,
  setTimeout, clearTimeout, process: { env: {} }, __dirname: root });
vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('const server = http.createServer')[0], context);
const html = context.landingHtml();
assert.match(html, /<title>\$5 Carfax Report \| Cheaper Carfax Report<\/title>/);
for (const tag of ['og:title', 'twitter:title']) {
  assert.ok(html.includes(`${tag}" content="$5 Carfax Report | Cheaper Carfax Report"`));
}
assert.match(html, /<h1>Carfax Report <span>\$5 Each<\/span><\/h1>/);
assert.match(html, /Full reports on this website are not free/);
assert.match(html, /rel="canonical" href="https:\/\/cheapercarfaxreport.com\/"/);
assert.doesNotMatch(html, /name="robots" content="noindex/);
assert.match(html, /href="\/checkout\/single"/);
assert.equal((html.match(/<h1>/g) || []).length, 1);
console.log('PASS: price title, matching social titles/H1, canonical, truthful free-report FAQ, checkout link');
