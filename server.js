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
const PAGE_SETTLE_MS = Number(process.env.PAGE_SETTLE_MS || 7000);

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

function parseLoadId(title, pageText) {
  const titleMatch = String(title || '').match(/^(\d{5,})\s*-/);
  if (titleMatch && titleMatch[1]) return titleMatch[1];

  return findFirst(pageText, [
    /Pro\s*#\/Load\s*ID\s*:?\s*([A-Za-z0-9-]+)/i,
    /Load\s*ID\s*:?\s*([A-Za-z0-9-]+)/i,
    /Shipper\s*Load\s*#\s*:?\s*([A-Za-z0-9-]+)/i
  ]);
}

function parseLatestStatus(pageText) {
  const text = cleanText(pageText);

  const latest = text.match(/Latest\s+Status\s*:\s*(.*?)(?:\s+✨|\s+Try the redesigned|\s+Open in a new tab|\s+All Events|\s+Driver|\s+Stops|\s+Map|$)/i);

  if (!latest || !latest[1]) {
    return {
      latestStatusRaw: '',
      status: inferStatus(text),
      statusTime: ''
    };
  }

  const raw = cleanText(latest[1]);

  const timed = raw.match(/^(.*?)\s+at\s+(.+)$/i);

  return {
    latestStatusRaw: raw,
    status: timed && timed[1] ? cleanText(timed[1]) : inferStatus(raw),
    statusTime: timed && timed[2] ? cleanText(timed[2]) : ''
  };
}

function inferStatus(text) {
  const lower = String(text || '').toLowerCase();

  if (lower.includes('left destination') || lower.includes('left delivery')) return 'Left Delivery';
  if (lower.includes('delivered')) return 'Delivered';
  if (lower.includes('arrived at consignee')) return 'Arrived at Consignee';
  if (lower.includes('entered delivery')) return 'Entered Delivery';
  if (lower.includes('out for delivery')) return 'Out for Delivery';
  if (lower.includes('in transit')) return 'In Transit';
  if (lower.includes('departed')) return 'Departed';
  if (lower.includes('loaded')) return 'Loaded';
  if (lower.includes('left pickup')) return 'Left Pickup';
  if (lower.includes('picked up') || lower.includes('pickup complete')) return 'Picked Up';
  if (lower.includes('arrived at shipper') || lower.includes('entered pickup')) return 'Arrived at Shipper';
  if (lower.includes('driver assigned')) return 'Driver Assigned';
  if (lower.includes('tracking')) return 'Tracking';
  return 'Unknown';
}

function extractFields(pageText, title) {
  const text = cleanText(pageText);
  const latest = parseLatestStatus(text);

  return {
    loadId: parseLoadId(title, text),
    status: latest.status,
    latestStatusRaw: latest.latestStatusRaw,
    statusTime: latest.statusTime,
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
    ]),
    lastKnownLocation: parseLastKnownLocation(text)
  };
}

function parseLastKnownLocation(pageText) {
  const text = cleanText(pageText);

  const match = text.match(/Last\s+Known\s+Location\s+(.+?)\s+at\s+(.+?)(?:\s+Map|\s+Satellite|\s+Pings|\s+Keyboard shortcuts|$)/i);

  if (!match) {
    return {
      address: '',
      time: ''
    };
  }

  return {
    address: cleanText(match[1]),
    time: cleanText(match[2])
  };
}

function extractEvents(pageText) {
  const text = String(pageText || '');

  const allEventsMatch = text.match(/All Events([\s\S]*?)(?:Stops|Route Map|Map Satellite|Last Known Location|Most recent Load Track location|$)/i);
  const eventsText = allEventsMatch && allEventsMatch[1] ? allEventsMatch[1] : text;

  const rawLines = eventsText
    .split(/\n+/)
    .map(cleanText)
    .filter(line => line.length > 2);

  const eventRows = [];
  const seen = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const next = rawLines[i + 1] || '';

    if (isNoiseLine(line)) continue;

    const eventKeyword = isTrackingEvent(line);
    const timeKeyword = looksLikeTruckerToolsTime(next);

    if (eventKeyword && timeKeyword) {
      const key = `${line}|${next}`;
      if (!seen.has(key)) {
        seen.add(key);
        eventRows.push({
          sequence: eventRows.length + 1,
          event: line,
          time: next,
          description: `${line} - ${next}`
        });
      }
      i += 1;
      continue;
    }

    if (eventKeyword && !seen.has(line)) {
      seen.add(line);
      eventRows.push({
        sequence: eventRows.length + 1,
        event: line,
        time: '',
        description: line
      });
    }

    if (eventRows.length >= 40) break;
  }

  return eventRows;
}

function isTrackingEvent(line) {
  const lower = cleanText(line).toLowerCase();

  const keywords = [
    'latest status',
    'delivered',
    'left delivery',
    'entered delivery',
    'left destination',
    'entered destination',
    'left pickup',
    'entered pickup',
    'pickup geofence',
    'delivery geofence',
    'arrived',
    'departed',
    'loaded',
    'picked up',
    'in transit',
    'driver assigned',
    'tracking',
    'created'
  ];

  return keywords.some(keyword => lower.includes(keyword));
}

function looksLikeTruckerToolsTime(line) {
  const value = cleanText(line);
  return /\b\d{1,2}:\d{2}\s*(PDT|PST|MDT|MST|CDT|CST|EDT|EST)?\b/i.test(value) ||
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(value);
}

function isNoiseLine(line) {
  const lower = cleanText(line).toLowerCase();

  const noise = [
    'load track details',
    'contact support',
    'sign in to see all my tracks',
    'copy shipper link',
    'the new load tracking experience',
    'try the redesigned',
    'open in a new tab',
    'all events',
    'driver',
    'phone',
    'time',
    'stops',
    'map satellite',
    'keyboard shortcuts',
    'map data',
    'google',
    'terms',
    'most recent load track location',
    'a radius around',
    'custom geofence',
    'load track starting',
    'alert - driver',
    'load track locations',
    'stop location',
    'low accuracy locations',
    'estimated gps route',
    'estimated telematics route'
  ];

  return noise.some(item => lower.includes(item));
}

function extractStops(pageText) {
  const text = String(pageText || '');
  const stopsMatch = text.match(/Stops([\s\S]*?)(?:Route Map|Map Satellite|Last Known Location|Most recent Load Track location|$)/i);

  if (!stopsMatch || !stopsMatch[1]) return [];

  const block = stopsMatch[1];
  const stopRegex = /([A-Z])\s+Stop\s+Name\s*:\s*([\s\S]*?)(?=(?:\s+[A-Z]\s+Stop\s+Name\s*:)|$)/gi;
  const stops = [];
  let match;

  while ((match = stopRegex.exec(block)) !== null) {
    const stopLetter = cleanText(match[1]);
    const stopBody = cleanText(match[2]);

    if (!stopBody) continue;

    const windowMatch = stopBody.match(/((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{1,2}:\d{2}\s+[A-Z]{3}\s+to\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{1,2}:\d{2}\s+[A-Z]{3})/i);

    const pieces = stopBody.split(/\s+(?=(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)/i);
    const locationText = cleanText(pieces[0] || stopBody);

    stops.push({
      sequence: stops.length + 1,
      stop: stopLetter,
      location: locationText,
      appointmentWindow: windowMatch && windowMatch[1] ? cleanText(windowMatch[1]) : '',
      raw: stopBody
    });
  }

  return stops;
}

function hasLoadNotFound(pageText) {
  return cleanText(pageText).toLowerCase().includes('load track not found');
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

    await page.waitForTimeout(PAGE_SETTLE_MS);

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (error) {
      // Some TruckerTools pages keep background requests open. Continue with available content.
    }

    const title = await page.title();
    const finalUrl = page.url();
    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');

    const fields = extractFields(pageText, title);
    const events = extractEvents(pageText);
    const stops = extractStops(pageText);
    const notFound = hasLoadNotFound(pageText);

    return {
      ok: true,
      service: 'GoCarga TruckerTools Hub',
      version: '1.1.0',
      source: 'TruckerTools',
      requestedUrl: url,
      finalUrl,
      title,
      loadFound: !notFound,
      loadId: fields.loadId,
      status: fields.status,
      latestStatusRaw: fields.latestStatusRaw,
      statusTime: fields.statusTime,
      eta: fields.eta,
      lastUpdate: fields.lastUpdate,
      lastKnownLocation: fields.lastKnownLocation,
      driver: fields.driver,
      phone: fields.phone,
      stops,
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
    version: '1.1.0',
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
    version: '1.1.0',
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
      version: '1.1.0',
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
      version: '1.1.0',
      source: 'TruckerTools',
      error: error.message || String(error),
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`GoCarga TruckerTools Hub v1.1.0 running on port ${PORT}`);
});
