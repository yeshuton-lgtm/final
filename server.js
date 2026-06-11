const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bundles.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const starterReports = [
  'https://carfax.codes/RSRK1NH9DP',
  'https://carfax.codes/HUP7OCNYL6',
  'https://carfax.codes/UK6TUOORZI',
  'https://carfax.codes/UWDHXKWROC',
  'https://carfax.codes/L0JOK0VVJ4'
];

function blankReport(url, index) {
  return {
    id: index + 1,
    url,
    used: false,
    vehicle: '',
    searchKey: '',
    searchDisplay: '',
    openedAt: ''
  };
}

function ensureData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const demoToken = 'demo5';
    const now = new Date().toISOString();
    const data = {
      bundles: {
        [demoToken]: {
          token: demoToken,
          customerName: 'Demo Customer',
          accountKey: '',
          createdAt: now,
          reports: starterReports.map(blankReport)
        }
      }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

function migrateData(data) {
  data.bundles = data.bundles || {};
  Object.values(data.bundles).forEach((bundle) => {
    bundle.accountKey = normalizeAccount(bundle.accountKey || '');
    bundle.reports = Array.isArray(bundle.reports) ? bundle.reports : [];
    bundle.reports.forEach((report, index) => {
      report.id = report.id || index + 1;
      report.used = Boolean(report.used);
      report.vehicle = String(report.vehicle || '');
      report.searchDisplay = String(report.searchDisplay || extractVinFromText(report.vehicle) || '');
      report.searchKey = normalizeSearchKey(report.searchKey || report.searchDisplay || extractVinFromText(report.vehicle) || '');
      report.openedAt = String(report.openedAt || '');
    });
  });
  return data;
}

function readData() {
  ensureData();
  return migrateData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
}

function writeData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(migrateData(data), null, 2));
}

function normalizeAccount(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('@')) return raw.replace(/\s+/g, '');
  return raw.replace(/[^a-z0-9]/g, '');
}

function normalizeSearchKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractVinFromText(value) {
  const match = String(value || '').toUpperCase().match(/[A-HJ-NPR-Z0-9]{17}/);
  return match ? match[0] : '';
}

function maskAccount(value) {
  if (!value) return '';
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    return `${name.slice(0, 2)}***@${domain || ''}`;
  }
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function isAdmin(req, url) {
  if (!ADMIN_PASSWORD) return true;
  return url.searchParams.get('password') === ADMIN_PASSWORD || req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getAccountBundles(data, bundle) {
  if (!bundle.accountKey) return [bundle];
  return Object.values(data.bundles).filter((item) => item.accountKey === bundle.accountKey);
}

function publicReport(bundle, report) {
  return {
    bundleToken: bundle.token,
    bundleName: bundle.customerName,
    id: report.id,
    used: report.used,
    vehicle: report.vehicle,
    searchDisplay: report.searchDisplay,
    searchKey: report.searchKey,
    openedAt: report.openedAt
  };
}

function accountSummary(data, bundle) {
  const bundles = getAccountBundles(data, bundle);
  const reports = bundles.flatMap((item) => item.reports.map((report) => ({ bundle: item, report })));
  const used = reports.filter((item) => item.report.used).length;
  return {
    accountKey: bundle.accountKey,
    accountLabel: maskAccount(bundle.accountKey),
    bundleCount: bundles.length,
    total: reports.length,
    used,
    remaining: reports.length - used,
    history: reports
      .filter((item) => item.report.used)
      .sort((a, b) => String(b.report.openedAt).localeCompare(String(a.report.openedAt)))
      .map((item) => publicReport(item.bundle, item.report))
  };
}

function publicBundle(data, bundle) {
  const used = bundle.reports.filter((report) => report.used).length;
  return {
    token: bundle.token,
    customerName: bundle.customerName,
    accountKey: bundle.accountKey,
    accountLabel: maskAccount(bundle.accountKey),
    total: bundle.reports.length,
    used,
    remaining: bundle.reports.length - used,
    account: accountSummary(data, bundle),
    reports: bundle.reports.map((report) => publicReport(bundle, report))
  };
}

function findExistingSearch(data, bundle, rawSearchKey) {
  const searchKey = normalizeSearchKey(rawSearchKey);
  if (!searchKey) return null;
  const bundles = getAccountBundles(data, bundle);
  for (const item of bundles) {
    for (const report of item.reports) {
      if (report.used && report.searchKey === searchKey) {
        return { bundle: item, report };
      }
    }
  }
  return null;
}

function pageHtml(token) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vehicle Report Bundle</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --ink:#182230; --muted:#667085; --line:#d8dee8; --accent:#1d5fda; --accent-dark:#174bb0; --ok:#087443; --warn:#a15c00; --danger:#b42318; --navy:#111827; --gold:#c08a28; font-family: Arial, Helvetica, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #eef2f6 0, #f7f8fa 320px, #f6f7f9 100%); color: var(--ink); }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 22px 0 42px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 54px; margin-bottom: 18px; }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; color: var(--navy); }
    .brand-mark { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; background: var(--navy); color: #fff; font-size: 15px; }
    .secure { color: var(--muted); font-size: 13px; }
    header.hero { background: var(--navy); color: #fff; border-radius: 8px; padding: 22px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: end; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
    .subhead, .muted, .time, .footer { color: var(--muted); }
    .hero .subhead { color: #cbd5e1; max-width: 760px; }
    .subhead { margin: 8px 0 0; font-size: 15px; line-height: 1.45; }
    .hero-badge { border: 1px solid rgba(255,255,255,.22); border-radius: 8px; padding: 12px 14px; min-width: 190px; background: rgba(255,255,255,.06); }
    .hero-badge strong { display: block; font-size: 22px; }
    .hero-badge span { color: #cbd5e1; font-size: 13px; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat, .panel, .table-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .stat { padding: 16px; }
    .stat strong { display: block; font-size: 30px; line-height: 1; margin-bottom: 8px; }
    .panel { padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
    .field label { display: block; color: #344054; font-size: 12px; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; }
    input { width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; padding: 8px 10px; }
    button { min-height: 40px; border: 1px solid transparent; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; font: 700 14px/1 Arial, Helvetica, sans-serif; padding: 10px 12px; white-space: nowrap; }
    button:hover { background: var(--accent-dark); }
    button.secondary { background: #fff; border-color: var(--line); color: var(--ink); }
    button.secondary:hover { background: #f7f8fa; }
    button:disabled { background: #d7dce5; color: #7d8796; cursor: not-allowed; }
    .notice { display: none; border-radius: 8px; margin-top: 12px; padding: 12px; font-size: 14px; line-height: 1.45; }
    .notice.show { display: block; }
    .notice.ok { background: #edf8f2; color: var(--ok); }
    .notice.warn { background: #fff7e6; color: var(--warn); }
    .notice.error { background: #fff1f0; color: var(--danger); }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .table-wrap { overflow-x: auto; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; min-width: 920px; }
    th, td { border-bottom: 1px solid var(--line); padding: 12px; text-align: left; vertical-align: middle; font-size: 14px; }
    th { background: #f9fafc; color: #344054; font-size: 12px; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    .slot { width: 64px; font-weight: 700; color: #344054; }
    .status { display: inline-flex; align-items: center; min-height: 26px; border-radius: 999px; padding: 5px 9px; font-size: 12px; font-weight: 700; }
    .available { background: #edf8f2; color: var(--ok); }
    .used { background: #eef4ff; color: #174ea6; }
    .vehicle-input, .search-input { width: min(260px, 100%); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .footer { margin-top: 14px; font-size: 13px; line-height: 1.45; }
    @media (max-width: 760px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 18px; }
      .topbar, .toolbar { align-items: stretch; flex-direction: column; }
      header.hero { grid-template-columns: 1fr; padding: 18px; }
      .stats, .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand"><span class="brand-mark">VR</span><span>Vehicle Reports Portal</span></div>
      <div class="secure">Secure customer access</div>
    </div>
    <header class="hero">
      <div>
        <h1>Vehicle Report Bundle</h1>
        <p class="subhead">Manage report credits, check VIN/plate history, and reopen previous reports from one customer portal.</p>
      </div>
      <div class="hero-badge">
        <strong id="heroRemaining">0</strong>
        <span>reports available</span>
      </div>
    </header>

    <section class="stats">
      <div class="stat"><strong id="totalCount">0</strong><span>Total reports in this bundle</span></div>
      <div class="stat"><strong id="usedCount">0</strong><span>Used in this bundle</span></div>
      <div class="stat"><strong id="remainingCount">0</strong><span>Remaining in this bundle</span></div>
    </section>

    <section class="panel">
      <h2>Account</h2>
      <div class="grid">
        <div class="field">
          <label for="accountInput">Customer phone or account ID</label>
          <input id="accountInput" autocomplete="tel" placeholder="Example: 5551234567" />
        </div>
        <button id="connectAccountButton" type="button">Connect Account</button>
      </div>
      <p class="muted" id="accountSummary">No account connected yet. Connect the same phone/account ID on future bundles to combine history.</p>
    </section>

    <section class="panel">
      <h2>Check Before Using A Report</h2>
      <div class="grid">
        <div class="field">
          <label for="searchInput">VIN or Plate</label>
          <input id="searchInput" autocomplete="off" placeholder="Enter VIN or plate before opening a new report" />
        </div>
        <button id="checkSearchButton" type="button">Check History</button>
      </div>
      <div id="searchNotice" class="notice"></div>
      <div class="actions" id="searchActions" style="margin-top:10px"></div>
    </section>

    <section class="panel toolbar">
      <p class="muted" style="margin:0">If the VIN/plate is new, use the next available report and the search will be saved to this account.</p>
      <button id="useNextButton" type="button">Use next available report</button>
    </section>

    <section class="table-wrap">
      <table>
        <thead><tr><th>Slot</th><th>Status</th><th>VIN / Plate</th><th>Vehicle note</th><th>Opened</th><th>Actions</th></tr></thead>
        <tbody id="reportRows"></tbody>
      </table>
    </section>

    <section class="panel">
      <h2>Account History</h2>
      <p class="muted" id="historySummary">Connect an account to view combined history across bundles.</p>
      <div class="table-wrap" style="margin:0">
        <table>
          <thead><tr><th>VIN / Plate</th><th>Vehicle note</th><th>Bundle</th><th>Opened</th><th>Actions</th></tr></thead>
          <tbody id="historyRows"></tbody>
        </table>
      </div>
    </section>

    <p class="footer">Tip: always enter the VIN or plate before using a new report. If it was checked before, opening the previous report will not use another credit.</p>
  </main>

  <script>
    const TOKEN = ${JSON.stringify(token)};
    let bundle = null;
    let lastCheckedSearch = '';

    async function api(path, options = {}) {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    function formatDate(value) {
      if (!value) return 'Not opened yet';
      return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    }

    function showNotice(type, text) {
      const notice = document.getElementById('searchNotice');
      notice.className = 'notice show ' + type;
      notice.textContent = text;
    }

    function clearSearchActions() {
      document.getElementById('searchActions').innerHTML = '';
    }

    function addSearchAction(label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className || '';
      button.textContent = label;
      button.addEventListener('click', handler);
      document.getElementById('searchActions').appendChild(button);
    }

    async function loadBundle() {
      bundle = await api('/api/bundle/' + TOKEN);
      render();
    }

    async function connectAccount() {
      const accountKey = document.getElementById('accountInput').value.trim();
      if (!accountKey) {
        showNotice('error', 'Enter a phone number or account ID first.');
        return;
      }
      bundle = await api('/api/bundle/' + TOKEN + '/account', {
        method: 'POST',
        body: JSON.stringify({ accountKey })
      });
      render();
      showNotice('ok', 'Account connected. Future bundles using the same account ID will share history.');
    }

    async function checkSearch() {
      const searchValue = document.getElementById('searchInput').value.trim();
      clearSearchActions();
      if (!searchValue) {
        showNotice('error', 'Enter a VIN or plate first.');
        return;
      }
      lastCheckedSearch = searchValue;
      const result = await api('/api/bundle/' + TOKEN + '/check', {
        method: 'POST',
        body: JSON.stringify({ searchKey: searchValue })
      });
      if (result.duplicate) {
        const vehicle = result.report.vehicle ? ' - ' + result.report.vehicle : '';
        showNotice('warn', 'Already checked: ' + (result.report.searchDisplay || searchValue) + vehicle + '. Opening it will not use another report.');
        addSearchAction('Open Previous Report', '', () => reopenSearch(searchValue));
      } else {
        showNotice('ok', 'No previous record found. You can use the next available report for this VIN/plate.');
        addSearchAction('Use Next Report For This VIN/Plate', '', () => openNextReport(searchValue));
      }
    }

    async function openReport(index, searchValue = '') {
      const reportWindow = window.open('about:blank', '_blank');
      try {
        const result = await api('/api/bundle/' + TOKEN + '/open/' + index, {
          method: 'POST',
          body: JSON.stringify({ searchKey: searchValue || lastCheckedSearch })
        });
        bundle = result.bundle;
        render();
        if (result.duplicate) {
          if (reportWindow) reportWindow.close();
          showNotice('warn', 'This VIN/plate was already checked. Open the previous report instead.');
          clearSearchActions();
          addSearchAction('Open Previous Report', '', () => reopenSearch(searchValue || lastCheckedSearch));
          return;
        }
        if (reportWindow) {
          reportWindow.location.href = result.url;
        } else {
          location.href = result.url;
        }
      } catch (error) {
        if (reportWindow) reportWindow.close();
        alert(error.message || 'Unable to open this report. Please try again.');
      }
    }

    async function openNextReport(searchValue = '') {
      const nextIndex = bundle.reports.findIndex((report) => !report.used);
      if (nextIndex === -1) {
        alert('All reports have already been used.');
        return;
      }
      await openReport(nextIndex, searchValue || document.getElementById('searchInput').value.trim());
    }

    async function reopenSearch(searchValue) {
      const reportWindow = window.open('about:blank', '_blank');
      try {
        const result = await api('/api/bundle/' + TOKEN + '/reopen-search', {
          method: 'POST',
          body: JSON.stringify({ searchKey: searchValue })
        });
        if (reportWindow) {
          reportWindow.location.href = result.url;
        } else {
          location.href = result.url;
        }
      } catch (error) {
        if (reportWindow) reportWindow.close();
        alert(error.message || 'Unable to open previous report.');
      }
    }

    async function updateVehicle(index, value) {
      await api('/api/bundle/' + TOKEN + '/vehicle/' + index, {
        method: 'POST',
        body: JSON.stringify({ vehicle: value })
      });
    }

    async function updateReportSearch(index, value) {
      bundle = await api('/api/bundle/' + TOKEN + '/search/' + index, {
        method: 'POST',
        body: JSON.stringify({ searchKey: value })
      });
      render();
    }

    function render() {
      if (!bundle) return;
      document.getElementById('totalCount').textContent = bundle.total;
      document.getElementById('usedCount').textContent = bundle.used;
      document.getElementById('remainingCount').textContent = bundle.remaining;
      document.getElementById('heroRemaining').textContent = bundle.account.accountKey ? bundle.account.remaining : bundle.remaining;
      document.getElementById('useNextButton').disabled = bundle.remaining === 0;
      document.getElementById('accountInput').value = bundle.accountKey || '';

      const account = bundle.account;
      document.getElementById('accountSummary').textContent = account.accountKey
        ? 'Connected account: ' + account.accountLabel + ' | Combined bundles: ' + account.bundleCount + ' | Total: ' + account.total + ' | Used: ' + account.used + ' | Remaining: ' + account.remaining
        : 'No account connected yet. Connect the same phone/account ID on future bundles to combine history.';

      renderBundleRows();
      renderHistoryRows();
    }

    function renderBundleRows() {
      const rows = document.getElementById('reportRows');
      rows.innerHTML = '';
      bundle.reports.forEach((report, index) => {
        const row = document.createElement('tr');
        const slot = document.createElement('td');
        slot.className = 'slot';
        slot.textContent = '#' + report.id;

        const status = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'status ' + (report.used ? 'used' : 'available');
        badge.textContent = report.used ? 'Used' : 'Available';
        status.appendChild(badge);

        const search = document.createElement('td');
        const searchInput = document.createElement('input');
        searchInput.className = 'search-input';
        searchInput.value = report.searchDisplay || '';
        searchInput.placeholder = 'VIN or plate';
        searchInput.addEventListener('change', (event) => updateReportSearch(index, event.target.value));
        search.appendChild(searchInput);

        const vehicle = document.createElement('td');
        const vehicleInput = document.createElement('input');
        vehicleInput.className = 'vehicle-input';
        vehicleInput.value = report.vehicle || '';
        vehicleInput.placeholder = 'Example: 2006 BMW 3 Series';
        vehicleInput.addEventListener('change', (event) => updateVehicle(index, event.target.value));
        vehicle.appendChild(vehicleInput);

        const opened = document.createElement('td');
        opened.className = 'time';
        opened.textContent = formatDate(report.openedAt);

        const actions = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = report.used ? 'secondary' : '';
        button.textContent = report.used ? 'Open Again' : 'Use Report';
        button.addEventListener('click', () => openReport(index, searchInput.value));
        wrap.appendChild(button);
        actions.appendChild(wrap);

        row.append(slot, status, search, vehicle, opened, actions);
        rows.appendChild(row);
      });
    }

    function renderHistoryRows() {
      const summary = document.getElementById('historySummary');
      const rows = document.getElementById('historyRows');
      rows.innerHTML = '';
      if (!bundle.account.accountKey) {
        summary.textContent = 'Connect an account to view combined history across bundles.';
        return;
      }
      summary.textContent = bundle.account.history.length + ' used reports saved under this account.';
      bundle.account.history.forEach((report) => {
        const row = document.createElement('tr');
        const search = document.createElement('td');
        search.textContent = report.searchDisplay || report.searchKey || 'Not saved';
        const vehicle = document.createElement('td');
        vehicle.textContent = report.vehicle || '';
        const bundleCell = document.createElement('td');
        bundleCell.textContent = report.bundleName || report.bundleToken;
        const opened = document.createElement('td');
        opened.className = 'time';
        opened.textContent = formatDate(report.openedAt);
        const actions = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Open Again';
        button.disabled = !report.searchKey;
        button.addEventListener('click', () => reopenSearch(report.searchDisplay || report.searchKey));
        actions.appendChild(button);
        row.append(search, vehicle, bundleCell, opened, actions);
        rows.appendChild(row);
      });
    }

    document.getElementById('connectAccountButton').addEventListener('click', connectAccount);
    document.getElementById('checkSearchButton').addEventListener('click', checkSearch);
    document.getElementById('useNextButton').addEventListener('click', () => openNextReport());
    loadBundle();
  </script>
</body>
</html>`;
}

function adminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create Bundle</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; background: #f4f6f8; color: #18212f; }
    .shell { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0; }
    label { display: block; font-weight: 700; margin: 16px 0 8px; }
    input, textarea { width: 100%; border: 1px solid #d9dee7; border-radius: 6px; padding: 10px; font: inherit; }
    textarea { min-height: 220px; }
    button { margin-top: 16px; border: 0; border-radius: 6px; background: #1463ff; color: #fff; padding: 11px 14px; font-weight: 700; cursor: pointer; }
    .box { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .muted { color: #667085; }
  </style>
</head>
<body>
  <main class="shell">
    <h1>Create Bundle Or Add Credits</h1>
    <p class="muted">Paste one report link per line. Use the same customer phone/account ID to add credits to an existing customer account and combine history across all of their bundles.</p>
    <div class="box">
      <label>Customer name</label>
      <input id="name" value="Customer" />
      <label>Customer phone or account ID</label>
      <input id="accountKey" placeholder="Example: 5551234567" />
      <label>Report links</label>
      <textarea id="links">https://carfax.codes/RSRK1NH9DP
https://carfax.codes/HUP7OCNYL6
https://carfax.codes/UK6TUOORZI
https://carfax.codes/UWDHXKWROC
https://carfax.codes/L0JOK0VVJ4</textarea>
      <button id="create">Create bundle / Add credits</button>
      <p id="result"></p>
    </div>
  </main>
  <script>
    document.getElementById('create').addEventListener('click', async () => {
      const customerName = document.getElementById('name').value.trim();
      const accountKey = document.getElementById('accountKey').value.trim();
      const links = document.getElementById('links').value.split('\\n').map((item) => item.trim()).filter(Boolean);
      const password = new URLSearchParams(location.search).get('password') || '';
      const response = await fetch('/api/bundle?password=' + encodeURIComponent(password), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerName, accountKey, links })
      });
      const data = await response.json();
      const url = location.origin + '/r/' + data.token;
      document.getElementById('result').innerHTML = response.ok ? 'Customer link: <a href="' + url + '">' + url + '</a><br><span class="muted">Send this link to the customer. If this account ID was used before, their history and balance will be combined.</span>' : data.error;
    });
  </script>
</body>
</html>`;
}

async function handleApi(req, res, pathname) {
  const data = readData();

  if (req.method === 'POST' && pathname === '/api/bundle') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const body = await readBody(req);
    const links = Array.isArray(body.links) ? body.links.filter(Boolean) : [];
    if (!links.length) return sendJson(res, 400, { error: 'At least one report link is required.' });

    const requestedToken = String(body.token || '').trim();
    const token = /^[a-zA-Z0-9_-]{4,64}$/.test(requestedToken) ? requestedToken : crypto.randomBytes(5).toString('hex');
    data.bundles[token] = {
      token,
      customerName: body.customerName || 'Customer',
      accountKey: normalizeAccount(body.accountKey || ''),
      createdAt: new Date().toISOString(),
      reports: links.map(blankReport)
    };
    writeData(data);
    return sendJson(res, 201, { token, bundle: publicBundle(data, data.bundles[token]) });
  }

  if (req.method === 'POST' && pathname === '/api/import-bundle') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const body = await readBody(req);
    const reports = Array.isArray(body.reports) ? body.reports.filter((report) => report && report.url) : [];
    if (!reports.length) return sendJson(res, 400, { error: 'At least one imported report is required.' });

    const requestedToken = String(body.token || '').trim();
    const token = /^[a-zA-Z0-9_-]{4,64}$/.test(requestedToken) ? requestedToken : crypto.randomBytes(5).toString('hex');
    data.bundles[token] = {
      token,
      customerName: body.customerName || 'Imported Customer History',
      accountKey: normalizeAccount(body.accountKey || ''),
      createdAt: new Date().toISOString(),
      reports: reports.map((item, index) => {
        const vehicle = String(item.vehicle || '').slice(0, 120);
        const searchDisplay = String(item.searchDisplay || item.searchKey || extractVinFromText(vehicle)).trim().slice(0, 40);
        return {
          id: index + 1,
          url: String(item.url),
          used: Boolean(item.used),
          vehicle,
          searchDisplay,
          searchKey: normalizeSearchKey(searchDisplay),
          openedAt: item.openedAt ? String(item.openedAt) : ''
        };
      })
    };
    writeData(data);
    return sendJson(res, 201, { token, bundle: publicBundle(data, data.bundles[token]) });
  }

  const bundleMatch = pathname.match(/^\/api\/bundle\/([^/]+)$/);
  if (req.method === 'GET' && bundleMatch) {
    const bundle = data.bundles[bundleMatch[1]];
    if (!bundle) return notFound(res);
    return sendJson(res, 200, publicBundle(data, bundle));
  }

  const accountMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/account$/);
  if (req.method === 'POST' && accountMatch) {
    const bundle = data.bundles[accountMatch[1]];
    if (!bundle) return notFound(res);
    const body = await readBody(req);
    const accountKey = normalizeAccount(body.accountKey || '');
    if (!accountKey) return sendJson(res, 400, { error: 'Account ID is required.' });
    bundle.accountKey = accountKey;
    writeData(data);
    return sendJson(res, 200, publicBundle(data, bundle));
  }

  const checkMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/check$/);
  if (req.method === 'POST' && checkMatch) {
    const bundle = data.bundles[checkMatch[1]];
    if (!bundle) return notFound(res);
    const body = await readBody(req);
    const existing = findExistingSearch(data, bundle, body.searchKey || '');
    if (!existing) return sendJson(res, 200, { duplicate: false, bundle: publicBundle(data, bundle) });
    return sendJson(res, 200, {
      duplicate: true,
      report: publicReport(existing.bundle, existing.report),
      bundle: publicBundle(data, bundle)
    });
  }

  const openMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/open\/(\d+)$/);
  if (req.method === 'POST' && openMatch) {
    const bundle = data.bundles[openMatch[1]];
    const index = Number(openMatch[2]);
    if (!bundle || !bundle.reports[index]) return notFound(res);
    const body = await readBody(req);
    const searchDisplay = String(body.searchKey || '').trim();
    const searchKey = normalizeSearchKey(searchDisplay);
    const existing = searchKey ? findExistingSearch(data, bundle, searchKey) : null;
    if (existing && existing.report !== bundle.reports[index]) {
      return sendJson(res, 200, {
        duplicate: true,
        report: publicReport(existing.bundle, existing.report),
        bundle: publicBundle(data, bundle)
      });
    }

    const report = bundle.reports[index];
    report.used = true;
    if (!report.openedAt) report.openedAt = new Date().toISOString();
    if (searchDisplay) {
      report.searchDisplay = searchDisplay;
      report.searchKey = searchKey;
    }
    writeData(data);
    return sendJson(res, 200, { duplicate: false, url: report.url, bundle: publicBundle(data, bundle) });
  }

  const reopenMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/reopen-search$/);
  if (req.method === 'POST' && reopenMatch) {
    const bundle = data.bundles[reopenMatch[1]];
    if (!bundle) return notFound(res);
    const body = await readBody(req);
    const existing = findExistingSearch(data, bundle, body.searchKey || '');
    if (!existing) return sendJson(res, 404, { error: 'No previous report found for this VIN/plate.' });
    return sendJson(res, 200, { url: existing.report.url, report: publicReport(existing.bundle, existing.report) });
  }

  const vehicleMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/vehicle\/(\d+)$/);
  if (req.method === 'POST' && vehicleMatch) {
    const bundle = data.bundles[vehicleMatch[1]];
    const index = Number(vehicleMatch[2]);
    if (!bundle || !bundle.reports[index]) return notFound(res);
    const body = await readBody(req);
    bundle.reports[index].vehicle = String(body.vehicle || '').slice(0, 120);
    writeData(data);
    return sendJson(res, 200, { ok: true });
  }

  const searchMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/search\/(\d+)$/);
  if (req.method === 'POST' && searchMatch) {
    const bundle = data.bundles[searchMatch[1]];
    const index = Number(searchMatch[2]);
    if (!bundle || !bundle.reports[index]) return notFound(res);
    const body = await readBody(req);
    const searchDisplay = String(body.searchKey || '').trim();
    bundle.reports[index].searchDisplay = searchDisplay.slice(0, 40);
    bundle.reports[index].searchKey = normalizeSearchKey(searchDisplay);
    writeData(data);
    return sendJson(res, 200, publicBundle(data, bundle));
  }

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/') {
      res.writeHead(302, { location: '/r/demo5' });
      return res.end();
    }

    if (pathname === '/admin') {
      if (!isAdmin(req, url)) {
        return sendHtml(res, '<!doctype html><meta charset="utf-8"><title>Admin Login</title><body style="font-family:Arial;padding:32px"><h1>Admin Login</h1><form><input name="password" type="password" placeholder="Password" style="padding:10px"><button style="padding:10px;margin-left:8px">Open</button></form></body>');
      }
      return sendHtml(res, adminHtml());
    }

    const pageMatch = pathname.match(/^\/r\/([^/]+)$/);
    if (req.method === 'GET' && pageMatch) {
      const data = readData();
      if (!data.bundles[pageMatch[1]]) return notFound(res);
      return sendHtml(res, pageHtml(pageMatch[1]));
    }

    if (pathname.startsWith('/api/')) {
      return handleApi(req, res, pathname);
    }

    return notFound(res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Server error' });
  }
});

ensureData();
server.listen(PORT, HOST, () => {
  console.log(`Report bundle server running at http://${HOST}:${PORT}/r/demo5`);
  console.log(`Admin page: http://${HOST}:${PORT}/admin`);
});
