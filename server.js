import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GOCARGA_TRACKING_API_KEY || '';
const TRACKER_TIMEOUT_MS = Number(process.env.TRACKER_TIMEOUT_MS || 45000);

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const providedKey =
    (req.headers.authorization || '').replace('Bearer ', '').trim() ||
    String(req.query.apiKey || '').trim();

  if (providedKey !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  return next();
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTruckerToolsUrl(input) {
  const value = cleanText(input);

  if (!value) {
    throw new Error('Missing TruckerTools shipper link or uniqueDispatchId.');
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  if (value.includes('uniqueDispatchId=')) {
    return `https://dashboard.loadtracking.truckertools.com/#/app/loadtrack-details-map?${value}`;
  }

  return `https://dashboard.loadtracking.truckertools.com/#/app/loadtrack-details-map?uniqueDispatchId=${encodeURIComponent(value)}`;
}

function findFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return cleanText(match[1]);
  }
  return '';
}

function inferStatus(text) {
  const lower = String(text || '').toLowerCase();

  if (lower.includes('delivered')) return 'Delivered';
  if (lower.includes('arrived at consignee')) return 'Arrived at Consignee';
  if (lower.includes('out for delivery')) return 'Out for Delivery';
  if (lower.includes('in transit')) return 'In Transit';
  if (lower.includes('departed')) return 'Departed';
  if (lower.includes('loaded')) return 'Loaded';
  if (lower.includes('picked up') || lower.includes('pickup complete')) return 'Picked Up';
  if (lower.includes('arrived at shipper')) return 'Arrived at Shipper';
  if (lower.includes('driver assigned')) return 'Driver Assigned';
  if (lower.includes('tracking')) return 'Tracking';
  return 'Unknown';
}

function extractFields(pageText) {
  const text = cleanText(pageText);

  return {
    status: inferStatus(text),
    eta: findFirst(text, [
      /ETA\s*:?\s*([^|]{3,80})/i,
      /Estimated\s+Delivery\s*:?\s*([^|]{3,80})/i,
      /Estimated\s+Arrival\s*:?\s*([^|]{3,80})/i
    ]),
    lastUpdate: findFirst(text, [
      /Last\s+Update\s*:?\s*([^|]{3,100})/i,
      /Updated\s*:?\s*([^|]{3,100})/i,
      /Tracking\s+at\s*([^|]{3,100})/i
    ]),
    driver: findFirst(text, [
      /Driver\s*:?\s*([A-Za-z][A-Za-z\s.'-]{2,70})/i
    ]),
    phone: findFirst(text, [
      /Phone\s*:?\s*([()+\-\d\s.]{7,30})/i
    ])
  };
}

function extractEvents(pageText) {
  const lines = String(pageText || '')
    .split(/\n+/)
    .map(cleanText)
    .filter(line => line.length > 3);

  const keywords = [
    'delivered',
    'arrived',
    'departed',
    'loaded',
    'picked up',
    'pickup',
    'in transit',
    'tracking',
    'eta',
    'left',
    'entered',
    'driver',
    'location',
    'updated'
  ];

  const seen = new Set();
  const events = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (!keywords.some(keyword => lower.includes(keyword))) continue;
    if (seen.has(line)) continue;

    seen.add(line);
    events.push({
      sequence: events.length + 1,
      description: line
    });

    if (events.length >= 30) break;
  }

  return events;
}

async function scrapeTruckerTools(shipperLink) {
  const url = normalizeTruckerToolsUrl(shipperLink);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  });

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TRACKER_TIMEOUT_MS
    });

    await page.waitForTimeout(7000);

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (error) {
      // Some TruckerTools pages keep background requests open. Continue with available content.
    }

    const title = await page.title();
    const finalUrl = page.url();
    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');

    const fields = extractFields(pageText);
    const events = extractEvents(pageText);

    return {
      ok: true,
      service: 'GoCarga TruckerTools Hub',
      source: 'TruckerTools',
      requestedUrl: url,
      finalUrl,
      title,
      status: fields.status,
      eta: fields.eta,
      lastUpdate: fields.lastUpdate,
      driver: fields.driver,
      phone: fields.phone,
      events,
      rawTextPreview: cleanText(pageText).slice(0, 3000),
      scrapedAt: new Date().toISOString()
    };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'GoCarga TruckerTools Hub',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      trackGet: 'GET /track?shipperLink=...',
      trackPost: 'POST /track { "shipperLink": "..." }'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'GoCarga TruckerTools Hub',
    status: 'healthy',
    time: new Date().toISOString()
  });
});

app.get('/track', requireApiKey, async (req, res) => {
  try {
    const shipperLink = req.query.shipperLink || req.query.url || req.query.uniqueDispatchId || '';
    const result = await scrapeTruckerTools(shipperLink);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'GoCarga TruckerTools Hub',
      source: 'TruckerTools',
      error: error.message || String(error),
      scrapedAt: new Date().toISOString()
    });
  }
});

app.post('/track', requireApiKey, async (req, res) => {
  try {
    const shipperLink = req.body.shipperLink || req.body.url || req.body.uniqueDispatchId || '';
    const result = await scrapeTruckerTools(shipperLink);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'GoCarga TruckerTools Hub',
      source: 'TruckerTools',
      error: error.message || String(error),
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`GoCarga TruckerTools Hub running on port ${PORT}`);
});
