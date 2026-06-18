const { getArrayEnv } = require('./env');

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_FEEDS = [
  'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
  'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=public%20safety%20OR%20police%20OR%20fire&hl=en-US&gl=US&ceid=US:en',
];

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeText(value) {
  return stripHtml(decodeEntities(value)).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? normalizeText(match[1]) : '';
}

function extractSource(block) {
  const source = extractTag(block, 'source');
  if (source) return source;

  const creator = extractTag(block, 'dc:creator');
  if (creator) return creator;

  const title = extractTag(block, 'title');
  const sourceMatch = title.match(/\s*-\s*([^-]+)$/);
  return sourceMatch ? normalizeText(sourceMatch[1]) : 'RSS Feed';
}

function parseRssItems(xml, feedUrl) {
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

  return matches.map(item => {
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const description = extractTag(item, 'description');

    return {
      title,
      url: link,
      publishedAt: pubDate || null,
      source: extractSource(item),
      summary: description || `Headline collected from ${feedUrl}.`,
    };
  }).filter(item => item.title && item.url);
}

async function fetchFeed(feedUrl) {
  const response = await fetch(feedUrl, {
    signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
    headers: {
      'User-Agent': 'detect-com-news-panel/1.0',
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Feed request failed with ${response.status}`);
  }

  const xml = await response.text();
  return parseRssItems(xml, feedUrl);
}

function dedupeItems(items) {
  const seen = new Set();

  return items.filter(item => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function getLiveNews(limit = 8) {
  const feeds = getArrayEnv('NEWS_RSS_FEEDS', DEFAULT_FEEDS).slice(0, 5);
  const settled = await Promise.allSettled(feeds.map(feed => fetchFeed(feed)));
  const warnings = [];
  const collected = [];

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
    } else {
      warnings.push(`Feed unavailable: ${feeds[index]} (${result.reason.message})`);
    }
  });

  const items = dedupeItems(collected)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, Math.max(1, Math.min(limit, 20)));

  return {
    items,
    warnings,
    providerStatus: items.length > 0 ? 'live' : 'unavailable',
    feedCount: feeds.length,
  };
}

module.exports = { getLiveNews };
