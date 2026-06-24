const http = require('http');
const https = require('https');
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
    openedAt: '',
    vinMismatch: false,
    vinMismatchMessage: ''
  };
}

function blankStockItem(url, now = new Date().toISOString()) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    url,
    status: 'available',
    addedAt: now,
    assignedAt: '',
    assignedBundle: ''
  };
}

function ensureData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const demoToken = 'demo5';
    const now = new Date().toISOString();
    const data = {
      inventory: [],
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
  data.inventory = Array.isArray(data.inventory) ? data.inventory : [];
  data.inventory.forEach((item) => {
    item.id = String(item.id || crypto.randomBytes(6).toString('hex'));
    item.url = String(item.url || '');
    item.status = item.status === 'assigned' ? 'assigned' : 'available';
    item.addedAt = String(item.addedAt || '');
    item.assignedAt = String(item.assignedAt || '');
    item.assignedBundle = String(item.assignedBundle || '');
  });
  data.bundles = data.bundles || {};
  Object.values(data.bundles).forEach((bundle) => {
    bundle.accountKey = normalizeAccount(bundle.accountKey || '');
    bundle.reports = Array.isArray(bundle.reports) ? bundle.reports : [];
    bundle.reports.forEach((report, index) => {
      report.id = report.id || index + 1;
      report.vehicle = String(report.vehicle || '');
      report.searchDisplay = String(report.searchDisplay || extractVinFromText(report.vehicle) || '');
      report.searchKey = normalizeSearchKey(report.searchKey || report.searchDisplay || extractVinFromText(report.vehicle) || '');
      report.used = Boolean(report.used && report.searchKey);
      report.openedAt = String(report.openedAt || '');
      report.vinMismatch = Boolean(report.vinMismatch);
      report.vinMismatchMessage = String(report.vinMismatchMessage || '');
      if (isServerSideAutoExtractionUnsupported(report.url) && (report.vinMismatch || isKnownVinfaxPlaceholder(report.vehicle))) {
        report.vehicle = '';
        report.vinMismatch = false;
        report.vinMismatchMessage = '';
      }
      if (!report.used) report.openedAt = '';
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

function isServerSideAutoExtractionUnsupported(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase();
    return hostname === 'vinfax.co' || hostname.endsWith('.vinfax.co');
  } catch (error) {
    return false;
  }
}

function isKnownVinfaxPlaceholder(value) {
  const text = String(value || '');
  return /19XFC2F54GE008801/i.test(text) || /Honda Civic Lx 2016/i.test(text);
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[lower] || match;
  });
}

function htmlToText(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h1|h2|h3|li|tr|td|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      timeout: 12000,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 VehicleReportBundle/1.0'
      }
    }, (response) => {
      const location = response.headers.location;
      if (location && response.statusCode >= 300 && response.statusCode < 400 && redirectsLeft > 0) {
        response.resume();
        resolve(fetchText(new URL(location, parsed).toString(), redirectsLeft - 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Report page returned ${response.statusCode}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy(new Error('Report page too large'));
      });
      response.on('end', () => resolve(body));
    });

    request.on('timeout', () => request.destroy(new Error('Report page timed out')));
    request.on('error', reject);
  });
}

function cleanVehicleLine(line) {
  return String(line || '')
    .replace(/your report is ready!?/gi, ' ')
    .replace(/carfax vehicle history report/gi, ' ')
    .replace(/\bVIN\b\s*:?\s*[A-HJ-NPR-Z0-9]{3,17}\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:-]+|[\s:-]+$/g, '')
    .trim();
}

function isVehicleCandidate(line) {
  const currentYear = new Date().getFullYear() + 1;
  const match = String(line || '').match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < 1981 || year > currentYear) return false;
  if (line.length < 12 || line.length > 90) return false;
  return !/(carfax|vehicle history|report|ready|download|email|built with|view|pdf|copyright|http|www\.)/i.test(line);
}

function extractWindowCodesValue(html, key) {
  const match = String(html || '').match(new RegExp(`${key}\\s*:\\s*(null|"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*')`, 'i'));
  if (!match || match[1] === 'null') return '';
  const raw = match[1].slice(1, -1);
  return raw
    .replace(/\\(["'\\/bfnrt])/g, (full, char) => {
      const map = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      return map[char] || char;
    })
    .replace(/\\u([0-9a-f]{4})/gi, (full, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .trim();
}

function extractReportDetails(html) {
  const appVehicle = extractWindowCodesValue(html, 'vehicle');
  const appVin = extractWindowCodesValue(html, 'vin').toUpperCase();
  if (appVehicle || appVin) {
    return {
      vehicle: cleanVehicleLine(appVehicle),
      vin: (appVin.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i) || [''])[0].toUpperCase()
    };
  }

  const text = htmlToText(html);
  const vin = (text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i) || [''])[0].toUpperCase();
  const compactText = cleanVehicleLine(text.replace(/\n/g, ' '));
  const lines = text.split('\n').map((line) => cleanVehicleLine(line)).filter(Boolean);

  let vehicle = '';
  const broadVehicleMatch = compactText.match(/\b((?:19[8-9]\d|20[0-3]\d)\s+[A-Za-z][A-Za-z0-9 .,'/&-]{8,80}?)(?=\s+(?:VIN\b|View CARFAX|Download|Email|Built with|OR\b|$))/i);
  if (broadVehicleMatch) vehicle = cleanVehicleLine(broadVehicleMatch[1]).slice(0, 90);

  for (let index = 0; index < lines.length; index += 1) {
    if (vehicle) break;
    const line = lines[index];
    if (!isVehicleCandidate(line)) continue;
    const next = lines[index + 1] || '';
    vehicle = next && !/^VIN\b/i.test(next) && !isVehicleCandidate(next) && /^[A-Za-z0-9][A-Za-z0-9 .,'/&-]{2,35}$/.test(next)
      ? `${line} ${next}`.slice(0, 90).trim()
      : line;
  }

  if (!vehicle) {
    const titleMatch = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      const title = cleanVehicleLine(decodeHtmlEntities(titleMatch[1]).replace(/\s*[-|].*$/, ''));
      if (isVehicleCandidate(title)) vehicle = title;
    }
  }

  return { vehicle, vin };
}

function formatVehicleNote(details) {
  const parts = [];
  if (details.vehicle) parts.push(details.vehicle);
  if (details.vin) parts.push(`VIN: ${details.vin}`);
  return parts.join('\n').slice(0, 160);
}

function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

async function decodeVehicleFromVin(vin) {
  const cleanVin = normalizeSearchKey(vin);
  if (!isVinSearchKey(cleanVin)) return '';
  try {
    const body = await fetchText(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${cleanVin}?format=json`);
    const data = JSON.parse(body);
    const details = data && data.Results && data.Results[0] ? data.Results[0] : {};
    const note = [
      details.ModelYear,
      titleCase(details.Make),
      titleCase(details.Model),
      titleCase(details.Trim)
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return note ? `${note}\nVIN: ${cleanVin}`.slice(0, 160) : '';
  } catch (error) {
    console.log(`VIN decode failed for ${cleanVin}: ${error.message}`);
    return '';
  }
}

async function fillVehicleFromReport(report) {
  if (!report.used || report.vehicle) return false;
  if (isServerSideAutoExtractionUnsupported(report.url)) {
    report.vinMismatch = false;
    report.vinMismatchMessage = '';
    const note = await decodeVehicleFromVin(report.searchKey);
    if (!note) return false;
    report.vehicle = note;
    return true;
  }
  try {
    const html = await fetchText(report.url);
    const details = extractReportDetails(html);
    const searchedVin = isVinSearchKey(report.searchKey) ? normalizeSearchKey(report.searchKey) : '';
    if (searchedVin && details.vin && searchedVin !== details.vin) {
      report.vinMismatch = true;
      report.vinMismatchMessage = `VIN mismatch: searched ${searchedVin}, report returned ${details.vin}`;
    } else if (details.vin) {
      report.vinMismatch = false;
      report.vinMismatchMessage = '';
    }
    const note = formatVehicleNote(details);
    if (!note) return false;
    report.vehicle = note;
    if (!report.searchKey) {
      const vin = extractVinFromText(note);
      if (vin) {
        report.searchDisplay = vin;
        report.searchKey = normalizeSearchKey(vin);
      }
    }
    return true;
  } catch (error) {
    console.log(`Vehicle note fetch failed for ${report.url}: ${error.message}`);
    return false;
  }
}

async function refreshMissingVehicles(data, bundle) {
  let changed = false;
  for (const report of bundle.reports) {
    if (report.used && !report.vehicle) {
      changed = await fillVehicleFromReport(report) || changed;
    }
  }
  return changed;
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
        error.statusCode = 400;
        error.publicMessage = 'Invalid JSON body.';
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
    openedAt: report.openedAt,
    vinMismatch: Boolean(report.vinMismatch),
    vinMismatchMessage: report.vinMismatchMessage || ''
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

function inventorySummary(data) {
  const available = data.inventory.filter((item) => item.status === 'available').length;
  const assigned = data.inventory.filter((item) => item.status === 'assigned').length;
  return {
    total: data.inventory.length,
    available,
    assigned
  };
}

function addInventoryLinks(data, rawLinks) {
  const existing = new Set(data.inventory.map((item) => item.url));
  const now = new Date().toISOString();
  const added = [];
  const skipped = [];
  rawLinks
    .map((link) => String(link || '').trim())
    .filter(Boolean)
    .forEach((url) => {
      if (existing.has(url)) {
        skipped.push(url);
        return;
      }
      const item = blankStockItem(url, now);
      data.inventory.push(item);
      existing.add(url);
      added.push(item);
    });
  return { added, skipped };
}

function assignInventory(data, count, token) {
  const available = data.inventory.filter((item) => item.status === 'available');
  if (available.length < count) {
    return null;
  }
  const now = new Date().toISOString();
  return available.slice(0, count).map((item) => {
    item.status = 'assigned';
    item.assignedAt = now;
    item.assignedBundle = token;
    return item.url;
  });
}

function assignSingleInventoryLink(data) {
  const item = data.inventory.find((stockItem) => stockItem.status === 'available');
  if (!item) return null;
  item.status = 'assigned';
  item.assignedAt = new Date().toISOString();
  item.assignedBundle = 'single-sale';
  return item.url;
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

function isVinSearchKey(searchKey) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizeSearchKey(searchKey));
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
    .brand-mark { display: inline-grid; place-items: center; width: 42px; height: 42px; border-radius: 10px; background: #fff; border: 1px solid var(--line); overflow: hidden; box-shadow: 0 8px 20px rgba(16,24,40,.08); }
    .brand-mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
    .search-grid { grid-template-columns: minmax(0, 1fr) 110px auto; }
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
    .mismatch { color: var(--danger); font-size: 12px; font-weight: 700; margin-top: 6px; }
    .footer { margin-top: 14px; font-size: 13px; line-height: 1.45; }
    @media (max-width: 760px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 18px; }
      .topbar, .toolbar { align-items: stretch; flex-direction: column; }
      header.hero { grid-template-columns: 1fr; padding: 18px; }
      .stats, .grid, .search-grid { grid-template-columns: 1fr; }
      .brand { font-size: 15px; }
      .secure { font-size: 12px; }
      .table-wrap { overflow-x: visible; border: 0; background: transparent; }
      table, thead, tbody, tr, th, td { display: block; width: 100%; }
      table { min-width: 0; border-collapse: separate; border-spacing: 0; }
      thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tr { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
      td { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 10px; align-items: center; border-bottom: 1px solid var(--line); padding: 11px 12px; overflow-wrap: anywhere; }
      td::before { content: attr(data-label); color: #344054; font-size: 11px; font-weight: 800; text-transform: uppercase; }
      tr:last-child td { border-bottom: 1px solid var(--line); }
      td:last-child { border-bottom: 0; }
      .slot { width: 100%; }
      .vehicle-input, .search-input { width: 100%; min-width: 0; }
      .actions { justify-content: stretch; }
      .actions button { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand"><span class="brand-mark"><img src="https://vehiclereportnow.online/assets/favicon.png" alt="Vehicle Report Now" /></span><span>Vehicle Report Now</span></div>
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
      <div class="grid search-grid">
        <div class="field">
          <label for="searchInput">VIN or Plate</label>
          <input id="searchInput" autocomplete="off" placeholder="Enter VIN or plate before opening a new report" />
        </div>
        <div class="field">
          <label for="plateStateInput">State</label>
          <input id="plateStateInput" autocomplete="off" maxlength="2" placeholder="CA" />
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

    function normalizeClientSearch(value) {
      return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function looksLikeVin(value) {
      return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizeClientSearch(value));
    }

    function getSearchValue() {
      const rawSearch = document.getElementById('searchInput').value.trim();
      const state = document.getElementById('plateStateInput').value.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      if (!rawSearch || looksLikeVin(rawSearch) || !state) return rawSearch;
      return rawSearch + ' ' + state;
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
      refreshMissingVehicles();
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
      const searchValue = getSearchValue();
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
        showNotice('warn', 'Already checked VIN: ' + (result.report.searchDisplay || searchValue) + vehicle + '. Opening it will not use another report.');
        addSearchAction('Open Previous Report', '', () => reopenSearch(searchValue));
      } else if (result.possibleMatch) {
        showNotice('warn', 'A previous plate record exists for ' + (result.report.searchDisplay || searchValue) + '. Plates can belong to different vehicles, so use the old report only if you are sure it is the same vehicle.');
        addSearchAction('Open Previous Report', 'secondary', () => reopenSearch(searchValue));
        addSearchAction('Run New Report Anyway', '', () => openNextReport(searchValue));
      } else {
        showNotice('ok', 'No previous record found. You can use the next available report for this VIN/plate.');
        addSearchAction('Use Next Report For This VIN/Plate', '', () => openNextReport(searchValue));
      }
    }

    async function openReport(index, searchValue = '') {
      try {
        const result = await api('/api/bundle/' + TOKEN + '/open/' + index, {
          method: 'POST',
          body: JSON.stringify({ searchKey: searchValue || lastCheckedSearch })
        });
        bundle = result.bundle;
        render();
        if (result.duplicate) {
          showNotice('warn', 'This VIN was already checked. Open the previous report instead.');
          clearSearchActions();
          addSearchAction('Open Previous Report', '', () => reopenSearch(searchValue || lastCheckedSearch));
          if (result.report && result.report.searchKey) {
            await reopenSearch(result.report.searchDisplay || result.report.searchKey);
          }
          return;
        }
        location.href = result.url;
      } catch (error) {
        alert(error.message || 'Unable to open this report. Please try again.');
      }
    }

    async function openNextReport(searchValue = '') {
      const nextIndex = bundle.reports.findIndex((report) => !report.searchKey);
      if (nextIndex === -1) {
        alert('All reports have already been used.');
        return;
      }
      await openReport(nextIndex, searchValue || getSearchValue());
    }

    async function reopenSearch(searchValue) {
      try {
        const result = await api('/api/bundle/' + TOKEN + '/reopen-search', {
          method: 'POST',
          body: JSON.stringify({ searchKey: searchValue })
        });
        location.href = result.url;
      } catch (error) {
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
      refreshMissingVehicles();
    }

    async function refreshMissingVehicles() {
      if (!bundle || !bundle.reports.some((report) => report.used && !report.vehicle)) return;
      try {
        const updated = await api('/api/bundle/' + TOKEN + '/refresh-vehicles', { method: 'POST' });
        bundle = updated;
        render();
      } catch (error) {
        console.log('Vehicle refresh skipped:', error.message);
      }
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
        slot.dataset.label = 'Slot';
        slot.textContent = '#' + report.id;

        const status = document.createElement('td');
        status.dataset.label = 'Status';
        const badge = document.createElement('span');
        badge.className = 'status ' + (report.used ? 'used' : 'available');
        badge.textContent = report.used ? 'Used' : 'Available';
        status.appendChild(badge);

        const search = document.createElement('td');
        search.dataset.label = 'VIN / Plate';
        const searchInput = document.createElement('input');
        searchInput.className = 'search-input';
        searchInput.value = report.searchDisplay || '';
        searchInput.placeholder = 'VIN or plate';
        searchInput.addEventListener('change', (event) => updateReportSearch(index, event.target.value));
        search.appendChild(searchInput);

        const vehicle = document.createElement('td');
        vehicle.dataset.label = 'Vehicle note';
        const vehicleInput = document.createElement('input');
        vehicleInput.className = 'vehicle-input';
        vehicleInput.value = report.vehicle || '';
        vehicleInput.placeholder = 'Example: 2006 BMW 3 Series';
        vehicleInput.addEventListener('change', (event) => updateVehicle(index, event.target.value));
        vehicle.appendChild(vehicleInput);
        if (report.vinMismatch) {
          const mismatch = document.createElement('div');
          mismatch.className = 'mismatch';
          mismatch.textContent = report.vinMismatchMessage || 'VIN mismatch: report returned a different VIN.';
          vehicle.appendChild(mismatch);
        }

        const opened = document.createElement('td');
        opened.className = 'time';
        opened.dataset.label = 'Opened';
        opened.textContent = formatDate(report.openedAt);

        const actions = document.createElement('td');
        actions.dataset.label = 'Actions';
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
        search.dataset.label = 'VIN / Plate';
        search.textContent = report.searchDisplay || report.searchKey || 'Not saved';
        const vehicle = document.createElement('td');
        vehicle.dataset.label = 'Vehicle note';
        vehicle.textContent = report.vehicle || '';
        if (report.vinMismatch) {
          const mismatch = document.createElement('div');
          mismatch.className = 'mismatch';
          mismatch.textContent = report.vinMismatchMessage || 'VIN mismatch: report returned a different VIN.';
          vehicle.appendChild(mismatch);
        }
        const bundleCell = document.createElement('td');
        bundleCell.dataset.label = 'Bundle';
        bundleCell.textContent = report.bundleName || report.bundleToken;
        const opened = document.createElement('td');
        opened.className = 'time';
        opened.dataset.label = 'Opened';
        opened.textContent = formatDate(report.openedAt);
        const actions = document.createElement('td');
        actions.dataset.label = 'Actions';
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
  <title>Report Inventory Admin</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; background: #f4f6f8; color: #18212f; }
    .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0; }
    h1 { margin: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    label { display: block; font-weight: 700; margin: 16px 0 8px; }
    input, textarea { width: 100%; border: 1px solid #d9dee7; border-radius: 6px; padding: 10px; font: inherit; }
    textarea { min-height: 220px; }
    button { margin-top: 16px; border: 0; border-radius: 6px; background: #1463ff; color: #fff; padding: 11px 14px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #fff; color: #18212f; border: 1px solid #d9dee7; }
    .box { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .stat { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 16px; }
    .stat strong { display: block; font-size: 30px; margin-bottom: 6px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .muted { color: #667085; }
    .result { line-height: 1.5; }
    @media (max-width: 760px) { .stats, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <h1>Report Inventory Admin</h1>
    <p class="muted">Add report links to inventory, then generate customer bundles by quantity. Using the same customer phone/account ID combines balances and history.</p>

    <section class="stats">
      <div class="stat"><strong id="stockAvailable">0</strong><span class="muted">Available stock</span></div>
      <div class="stat"><strong id="stockAssigned">0</strong><span class="muted">Assigned to bundles</span></div>
      <div class="stat"><strong id="stockTotal">0</strong><span class="muted">Total links added</span></div>
    </section>

    <div class="grid">
      <section class="box">
        <h2>Add Inventory</h2>
        <p class="muted">Paste newly purchased report links here, one per line. Duplicates will be skipped.</p>
        <label>New inventory links</label>
        <textarea id="stockLinks" placeholder="https://carfax.codes/..."></textarea>
        <button id="addStock">Add to inventory</button>
        <p class="result" id="stockResult"></p>
      </section>

      <section class="box">
        <h2>Single Report Sale</h2>
        <p class="muted">Use this for one-report customers. It takes one link from available inventory and gives you the raw CARFAX link to send.</p>
        <button id="singleLink" type="button">Get single report link</button>
        <button id="copySingleLink" class="secondary" type="button" disabled>Copy link</button>
        <p class="result" id="singleResult"></p>
      </section>

      <section class="box">
        <h2>Create Bundle / Add Credits</h2>
        <label>Customer name</label>
        <input id="name" value="Customer" />
        <label>Customer phone or account ID</label>
        <input id="accountKey" placeholder="Example: 5551234567" />
        <label>Quantity from inventory</label>
        <input id="quantity" type="number" min="0" step="1" placeholder="Example: 20" />
        <label>Optional manual links</label>
        <textarea id="links" placeholder="Use this only when you want to create a bundle from manually pasted links instead of stock."></textarea>
        <button id="create">Create bundle / Add credits</button>
        <button id="refresh" class="secondary" type="button">Refresh inventory</button>
        <p class="result" id="result"></p>
      </section>
    </div>
  </main>
  <script>
    const password = new URLSearchParams(location.search).get('password') || '';
    async function api(path, options = {}) {
      const response = await fetch(path + (path.includes('?') ? '&' : '?') + 'password=' + encodeURIComponent(password), {
        headers: { 'content-type': 'application/json' },
        ...options
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (error) {
        return false;
      }
    }
    async function loadInventory() {
      const data = await api('/api/inventory');
      document.getElementById('stockAvailable').textContent = data.available;
      document.getElementById('stockAssigned').textContent = data.assigned;
      document.getElementById('stockTotal').textContent = data.total;
    }
    document.getElementById('addStock').addEventListener('click', async () => {
      const links = document.getElementById('stockLinks').value.split('\\n').map((item) => item.trim()).filter(Boolean);
      try {
        const data = await api('/api/inventory/add', {
          method: 'POST',
          body: JSON.stringify({ links })
        });
        document.getElementById('stockResult').textContent = 'Added ' + data.added + ' links. Skipped duplicates: ' + data.skipped + '.';
        document.getElementById('stockLinks').value = '';
        await loadInventory();
      } catch (error) {
        document.getElementById('stockResult').textContent = error.message;
      }
    });
    document.getElementById('singleLink').addEventListener('click', async () => {
      if (!confirm('Take 1 available report link from inventory for a single-report sale?')) return;
      try {
        const data = await api('/api/inventory/single-link', { method: 'POST' });
        const copied = await copyText(data.url);
        document.getElementById('singleResult').innerHTML = 'Single report link: <a href="' + data.url + '" target="_blank" rel="noopener">' + data.url + '</a><br><span class="muted">' + (copied ? 'Copied to clipboard. ' : 'Use Copy link if it was not copied. ') + 'Remaining stock: ' + data.inventory.available + '.</span>';
        const copyButton = document.getElementById('copySingleLink');
        copyButton.disabled = false;
        copyButton.dataset.url = data.url;
        await loadInventory();
      } catch (error) {
        document.getElementById('singleResult').textContent = error.message;
      }
    });
    document.getElementById('copySingleLink').addEventListener('click', async () => {
      const url = document.getElementById('copySingleLink').dataset.url || '';
      if (!url) return;
      const copied = await copyText(url);
      document.getElementById('singleResult').innerHTML = 'Single report link: <a href="' + url + '" target="_blank" rel="noopener">' + url + '</a><br><span class="muted">' + (copied ? 'Copied to clipboard.' : 'Copy failed. Select and copy the link manually.') + '</span>';
    });
    document.getElementById('create').addEventListener('click', async () => {
      const customerName = document.getElementById('name').value.trim();
      const accountKey = document.getElementById('accountKey').value.trim();
      const links = document.getElementById('links').value.split('\\n').map((item) => item.trim()).filter(Boolean);
      const quantity = Number(document.getElementById('quantity').value || 0);
      try {
        const data = await api('/api/bundle', {
          method: 'POST',
          body: JSON.stringify({ customerName, accountKey, links, quantity })
        });
        const url = location.origin + '/r/' + data.token;
        document.getElementById('result').innerHTML = 'Customer link: <a href="' + url + '">' + url + '</a><br><span class="muted">Reports in this bundle: ' + data.bundle.total + '. Remaining stock: ' + data.inventory.available + '.</span>';
        document.getElementById('links').value = '';
        document.getElementById('quantity').value = '';
        await loadInventory();
      } catch (error) {
        document.getElementById('result').textContent = error.message;
      }
    });
    document.getElementById('refresh').addEventListener('click', loadInventory);
    loadInventory();
  </script>
</body>
</html>`;
}

async function handleApi(req, res, pathname) {
  const data = readData();

  if (req.method === 'GET' && pathname === '/api/inventory') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    return sendJson(res, 200, inventorySummary(data));
  }

  if (req.method === 'POST' && pathname === '/api/inventory/add') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const body = await readBody(req);
    const links = Array.isArray(body.links) ? body.links : [];
    if (!links.length) return sendJson(res, 400, { error: 'Paste at least one inventory link.' });
    const result = addInventoryLinks(data, links);
    writeData(data);
    return sendJson(res, 200, {
      added: result.added.length,
      skipped: result.skipped.length,
      inventory: inventorySummary(data)
    });
  }

  if (req.method === 'POST' && pathname === '/api/inventory/single-link') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const url = assignSingleInventoryLink(data);
    if (!url) return sendJson(res, 400, { error: 'No available inventory links left.' });
    writeData(data);
    return sendJson(res, 200, {
      url,
      inventory: inventorySummary(data)
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/search') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const query = normalizeSearchKey(requestUrl.searchParams.get('q') || requestUrl.searchParams.get('search') || '');
    const matches = [];
    Object.values(data.bundles).forEach((bundle) => {
      bundle.reports.forEach((report) => {
        const haystack = [
          report.searchKey,
          report.searchDisplay,
          report.vehicle,
          report.url,
          bundle.token,
          bundle.customerName,
          bundle.accountKey
        ].join(' ').toUpperCase();
        if (!query || haystack.includes(query)) {
          matches.push({
            bundle: bundle.token,
            customerName: bundle.customerName,
            accountLabel: maskAccount(bundle.accountKey),
            report: publicReport(bundle, report)
          });
        }
      });
    });
    return sendJson(res, 200, { query, matches });
  }

  if (req.method === 'POST' && pathname === '/api/bundle') {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (!isAdmin(req, requestUrl)) return sendJson(res, 401, { error: 'Admin password required.' });
    const body = await readBody(req);
    const manualLinks = Array.isArray(body.links) ? body.links.filter(Boolean) : [];
    const quantity = Math.max(0, Number.parseInt(body.quantity, 10) || 0);
    if (!manualLinks.length && !quantity) return sendJson(res, 400, { error: 'Enter a quantity or paste at least one report link.' });

    const requestedToken = String(body.token || '').trim();
    const token = /^[a-zA-Z0-9_-]{4,64}$/.test(requestedToken) ? requestedToken : crypto.randomBytes(5).toString('hex');
    const stockLinks = quantity ? assignInventory(data, quantity, token) : [];
    if (quantity && !stockLinks) {
      return sendJson(res, 400, { error: `Not enough inventory. Available stock: ${inventorySummary(data).available}.` });
    }
    const links = [...manualLinks, ...stockLinks];
    data.bundles[token] = {
      token,
      customerName: body.customerName || 'Customer',
      accountKey: normalizeAccount(body.accountKey || ''),
      createdAt: new Date().toISOString(),
      reports: links.map(blankReport)
    };
    writeData(data);
    return sendJson(res, 201, { token, bundle: publicBundle(data, data.bundles[token]), inventory: inventorySummary(data) });
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
          openedAt: item.openedAt ? String(item.openedAt) : '',
          vinMismatch: Boolean(item.vinMismatch),
          vinMismatchMessage: String(item.vinMismatchMessage || '')
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
    const searchKey = normalizeSearchKey(body.searchKey || '');
    const existing = findExistingSearch(data, bundle, searchKey);
    if (!existing) return sendJson(res, 200, { duplicate: false, bundle: publicBundle(data, bundle) });
    if (!isVinSearchKey(searchKey)) {
      return sendJson(res, 200, {
        duplicate: false,
        possibleMatch: true,
        report: publicReport(existing.bundle, existing.report),
        bundle: publicBundle(data, bundle)
      });
    }
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
    if (existing && existing.report !== bundle.reports[index] && isVinSearchKey(searchKey)) {
      return sendJson(res, 200, {
        duplicate: true,
        report: publicReport(existing.bundle, existing.report),
        bundle: publicBundle(data, bundle)
      });
    }

    const report = bundle.reports[index];
    if (searchDisplay) {
      report.searchDisplay = searchDisplay;
      report.searchKey = searchKey;
      report.used = true;
      if (!report.openedAt) report.openedAt = new Date().toISOString();
    } else {
      report.searchDisplay = '';
      report.searchKey = '';
      report.used = false;
      report.openedAt = '';
    }
    writeData(data);
    if (report.used && !report.vehicle) {
      setTimeout(async () => {
        const latestData = readData();
        const latestBundle = latestData.bundles[openMatch[1]];
        const latestReport = latestBundle && latestBundle.reports[index];
        if (latestReport && await fillVehicleFromReport(latestReport)) writeData(latestData);
      }, 30000).unref();
    }
    return sendJson(res, 200, { duplicate: false, url: report.url, bundle: publicBundle(data, bundle) });
  }

  const refreshVehiclesMatch = pathname.match(/^\/api\/bundle\/([^/]+)\/refresh-vehicles$/);
  if (req.method === 'POST' && refreshVehiclesMatch) {
    const bundle = data.bundles[refreshVehiclesMatch[1]];
    if (!bundle) return notFound(res);
    const changed = await refreshMissingVehicles(data, bundle);
    if (changed) writeData(data);
    return sendJson(res, 200, publicBundle(data, bundle));
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
    bundle.reports[index].used = Boolean(bundle.reports[index].searchKey);
    if (bundle.reports[index].used && !bundle.reports[index].openedAt) {
      bundle.reports[index].openedAt = new Date().toISOString();
    }
    if (!bundle.reports[index].used) {
      bundle.reports[index].openedAt = '';
    }
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
      return await handleApi(req, res, pathname);
    }

    return notFound(res);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.publicMessage || 'Server error' });
  }
});

ensureData();
server.listen(PORT, HOST, () => {
  console.log(`Report bundle server running at http://${HOST}:${PORT}/r/demo5`);
  console.log(`Admin page: http://${HOST}:${PORT}/admin`);
});
