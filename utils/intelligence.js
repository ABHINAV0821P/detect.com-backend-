const fs = require('fs').promises;
const { extractVideoFrames, hasFfmpeg, hasFfprobe } = require('./videoForensics');
const { runPhotoForensics } = require('./photoForensics');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gemini-2.5-flash';
const OPENAI_MODEL_FALLBACKS = (process.env.OPENAI_MODEL_FALLBACKS || 'gemini-2.5-flash-lite')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const REQUEST_TIMEOUT_MS = 12000;

function getAIConfigError() {
  if (!OPENAI_API_KEY) {
    return 'OPENAI_API_KEY is missing. Add your Gemini/Google AI API key to server/.env.';
  }

  return '';
}

function getGeminiModelCode() {
  const raw = String(OPENAI_MODEL || '').trim();
  if (!raw) {
    return 'gemini-2.5-flash';
  }

  if (raw.startsWith('models/')) {
    return raw.slice('models/'.length);
  }

  if (/gemini/i.test(raw) && /\s/.test(raw)) {
    return raw.toLowerCase().replace(/\s+/g, '-');
  }

  return raw;
}

function normalizeGeminiModelCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('models/')) {
    return raw.slice('models/'.length);
  }
  if (/gemini/i.test(raw) && /\s/.test(raw)) {
    return raw.toLowerCase().replace(/\s+/g, '-');
  }
  return raw;
}

function getGeminiModelCandidates() {
  return Array.from(new Set([
    normalizeGeminiModelCode(OPENAI_MODEL),
    ...OPENAI_MODEL_FALLBACKS.map(normalizeGeminiModelCode),
  ].filter(Boolean)));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function average(values = []) {
  const numeric = values.filter(value => Number.isFinite(value));
  if (numeric.length === 0) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function logisticProbability(score) {
  return clamp(1 / (1 + Math.exp(-score)), 0.02, 0.98);
}

function blendProbabilities(entries = []) {
  const normalized = entries
    .filter(entry => Number.isFinite(entry?.probability) && Number.isFinite(entry?.weight) && entry.weight > 0)
    .map(entry => ({
      probability: clamp(entry.probability, 0.02, 0.98),
      weight: entry.weight,
    }));

  if (normalized.length === 0) return 0.5;

  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0) || 1;
  const logitSum = normalized.reduce((sum, item) => {
    const odds = item.probability / (1 - item.probability);
    return sum + Math.log(odds) * item.weight;
  }, 0);

  return logisticProbability(logitSum / totalWeight);
}

function scoreAdvancedForensicMetrics(metrics = {}) {
  if (!metrics || typeof metrics !== 'object') {
    return {
      probability: 0.5,
      reasons: [],
    };
  }

  const reasons = [];
  let score = 0;

  if (Number.isFinite(metrics.elaMean)) {
    if (metrics.elaMean >= 14) {
      score += 0.95;
      reasons.push('Error-level analysis is strongly elevated.');
    } else if (metrics.elaMean >= 9) {
      score += 0.45;
    } else if (metrics.elaMean <= 3.5) {
      score += 0.2;
    }
  }

  if (Number.isFinite(metrics.elaMax) && metrics.elaMax >= 90) {
    score += 0.35;
  }

  if (Number.isFinite(metrics.edgeDensity)) {
    if (metrics.edgeDensity <= 0.018 || metrics.edgeDensity >= 0.16) {
      score += 0.35;
    }
  }

  if (Number.isFinite(metrics.blockiness)) {
    if (metrics.blockiness >= 18) {
      score += 0.42;
    } else if (metrics.blockiness >= 12) {
      score += 0.2;
    }
  }

  if (Number.isFinite(metrics.noiseDelta)) {
    if (metrics.noiseDelta <= 1.6) {
      score += 0.45;
    } else if (metrics.noiseDelta >= 8) {
      score += 0.2;
    }
  }

  if (Number.isFinite(metrics.sharpnessVariance)) {
    if (metrics.sharpnessVariance <= 140) {
      score += 0.28;
    } else if (metrics.sharpnessVariance >= 3200) {
      score += 0.16;
    }
  }

  if (Number.isFinite(metrics.lumaClipping) && metrics.lumaClipping >= 0.18) {
    score += 0.18;
  }

  if (Number.isFinite(metrics.channelMisalignment) && metrics.channelMisalignment <= 6) {
    score += 0.16;
  }

  if (Number.isFinite(metrics.tileNoiseVariation)) {
    if (metrics.tileNoiseVariation >= 2.6) {
      score += 0.42;
      reasons.push('Noise characteristics vary sharply across regions.');
    } else if (metrics.tileNoiseVariation <= 0.35) {
      score += 0.24;
    }
  }

  if (Number.isFinite(metrics.entropy) && metrics.entropy <= 5.2) {
    score += 0.16;
  }

  return {
    probability: logisticProbability(-0.65 + score),
    reasons,
  };
}

function buildForensicFusion({ fallbackProbability, forensicSignals, advancedForensics, aiProbability = null, frameProbability = null }) {
  const advancedModel = scoreAdvancedForensicMetrics(advancedForensics?.metrics || forensicSignals?.advancedMetrics || {});
  const probability = blendProbabilities([
    { probability: fallbackProbability, weight: 1.1 },
    { probability: clamp(forensicSignals?.suspicion ?? 0.5, 0.02, 0.98), weight: 1.15 },
    { probability: clamp(advancedForensics?.suspicion ?? advancedModel.probability, 0.02, 0.98), weight: 1.45 },
    Number.isFinite(frameProbability) ? { probability: frameProbability, weight: 1.35 } : null,
    Number.isFinite(aiProbability) ? { probability: aiProbability, weight: 0.9 } : null,
  ]);

  return {
    probability,
    reasons: Array.from(new Set([
      ...(advancedModel.reasons || []),
      ...((advancedForensics?.reasons) || []),
    ])).filter(Boolean),
  };
}

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const pngHeader = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== pngHeader) return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: [4, 6].includes(buffer[25]),
    format: 'png',
  };
}

function parseJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        hasAlpha: false,
        format: 'jpeg',
      };
    }

    if (!Number.isFinite(length) || length < 2) {
      break;
    }
    offset += 2 + length;
  }

  return { format: 'jpeg', width: null, height: null, hasAlpha: false };
}

function parseWebpDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return null;
  }

  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      hasAlpha: (buffer[20] & 0b00010000) !== 0,
      format: 'webp',
    };
  }

  return { format: 'webp', width: null, height: null, hasAlpha: false };
}

function extractBasicImageSignals(file, buffer, metadata = {}, advancedForensics = null) {
  const filename = String(file.originalname || '').toLowerCase().trim();
  const mimeType = String(file.mimetype || '').toLowerCase();
  const parsed = parsePngDimensions(buffer) || parseJpegDimensions(buffer) || parseWebpDimensions(buffer) || {
    width: null,
    height: null,
    hasAlpha: false,
    format: mimeType.replace('image/', '') || 'unknown',
  };

  const reasons = [];
  let suspicion = 0.18;
  const ratio = parsed.width && parsed.height ? parsed.width / parsed.height : null;
  const hasCameraMetadata = Boolean(metadata.capturedAt || metadata.deviceId || metadata.location);
  const genericFilename = /^(image|photo|picture|img|screenshot)[-_ ]?\d*\.(png|jpg|jpeg|webp)$/i.test(filename);
  const likelyScreenshot = parsed.format === 'png' && !hasCameraMetadata;

  if (!hasCameraMetadata) {
    suspicion += 0.18;
    reasons.push('No camera-style provenance metadata was available.');
  } else {
    suspicion -= 0.05;
    reasons.push('Some capture provenance metadata is available.');
  }

  if (genericFilename) {
    suspicion += 0.08;
    reasons.push('The filename looks like a pasted, downloaded, or generic export name.');
  }

  if (likelyScreenshot) {
    suspicion += 0.16;
    reasons.push('The image is PNG without capture metadata, which often indicates a screenshot, repost, or edited export rather than an original camera photo.');
  }

  if (parsed.hasAlpha) {
    suspicion += 0.06;
    reasons.push('The image uses transparency, which is uncommon for untouched camera photos.');
  }

  if (ratio && (ratio > 2.2 || ratio < 0.45)) {
    suspicion += 0.05;
    reasons.push('The aspect ratio is unusual for a standard camera photo.');
  }

  if (parsed.width && parsed.height && parsed.width * parsed.height < 220000) {
    suspicion += 0.05;
    reasons.push('The image resolution is low, which reduces forensic confidence.');
  }

  if (/ai|generated|synthetic|deepfake|faceswap|edited|remix/.test(filename)) {
    suspicion += 0.14;
    reasons.push('The filename itself suggests AI generation or editing.');
  }

  return {
    format: parsed.format,
    width: parsed.width,
    height: parsed.height,
    hasAlpha: parsed.hasAlpha,
    genericFilename,
    likelyScreenshot,
    advancedAvailable: Boolean(advancedForensics?.available),
    advancedMetrics: advancedForensics?.metrics || null,
    suspicion: clamp(suspicion, 0.04, 0.98),
    reasons: [
      ...reasons,
      ...(advancedForensics?.reasons || []),
    ],
  };
}

function descriptionLooksLikeIncidentClaim(description = '') {
  const text = normalizeText(description).toLowerCase();
  if (!text) return false;

  const claimPatterns = [
    /\b(fake news|viral|claim|claimed|rumou?r|hoax|staged|edited|ai generated|deepfake)\b/,
    /\b(bitten|attack(?:ed)?|killed|shot|stabbed|beaten|injured|arrested|kidnapped|burned|exploded)\b/,
    /\b(happened|occurred|reported|reports|show(s|ing)?|depicts|proves|confirm(s|ed)?)\b/,
    /\b(is|was|were|are)\b.{0,30}\b(by|at|in|near|on)\b/,
  ];

  return claimPatterns.some(pattern => pattern.test(text));
}

function finalizeAuthenticityVerdict({
  verdict,
  confidence,
  fakeProbability,
  fallback,
  forensicSignals,
  summary,
  reasons,
  provider,
  description = '',
}) {
  let nextVerdict = verdict;
  let nextConfidence = clamp(confidence, 0.25, 0.98);
  const nextFakeProbability = clamp(Math.max(fakeProbability, fallback.fakeProbability, forensicSignals.suspicion), 0.02, 0.98);
  const mergedReasons = Array.from(new Set([...(reasons || []), ...(forensicSignals.reasons || [])])).filter(Boolean);
  let nextSummary = summary;
  const hasWeakProvenance = !forensicSignals.likelyScreenshot
    && (!forensicSignals.width || !forensicSignals.height || forensicSignals.genericFilename || nextFakeProbability >= 0.28);
  const incidentClaimContext = descriptionLooksLikeIncidentClaim(description);

  if (nextVerdict === 'real' && (nextConfidence < 0.72 || nextFakeProbability >= 0.28 || hasWeakProvenance)) {
    nextVerdict = 'needs_review';
    nextConfidence = Math.max(nextConfidence, 0.52);
    nextSummary = 'The image does not have enough trustworthy provenance and forensic support to be called real. It should stay in analyst review.';
  }

  if (forensicSignals.likelyScreenshot && nextVerdict === 'real') {
    nextVerdict = 'needs_review';
    nextConfidence = Math.max(nextConfidence, 0.58);
    nextSummary = 'The image looks more like a screenshot, repost, or export than an original camera photo, so it should not be treated as definitively real.';
  }

  if (incidentClaimContext && nextVerdict === 'real') {
    nextVerdict = 'needs_review';
    nextConfidence = Math.max(nextConfidence, 0.6);
    nextSummary = 'The uploaded image may be an authentic photo, but this check cannot confirm that it matches the described incident or proves the claim. Keep it in review.';
    mergedReasons.push('The attached description makes an incident claim, but photo-authenticity checks alone cannot verify event truth or context.');
  }

  if (forensicSignals.suspicion >= 0.62 && nextVerdict !== 'fake') {
    nextVerdict = 'fake';
    nextConfidence = Math.max(nextConfidence, 0.66);
    nextSummary = 'Multiple forensic and provenance signals point to manipulation or synthetic generation.';
  }

  return {
    verdict: nextVerdict,
    confidence: nextConfidence,
    fakeProbability: nextFakeProbability,
    summary: nextSummary,
    reasons: mergedReasons,
    provider,
    forensicSignals,
  };
}

function trimWords(value, maxWords = 90) {
  const words = normalizeText(value).split(' ').filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return response;
}

function extractGeminiText(body) {
  const text = body?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim();

  return text || '';
}

function stripJsonFence(value) {
  const text = String(value || '').trim();
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function generateGeminiJson({ system, userParts }) {
  const modelCandidates = getGeminiModelCandidates();
  let lastError = null;

  for (const modelCode of modelCandidates) {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelCode)}:generateContent`);

    const response = await fetchJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': OPENAI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: system }],
        },
        contents: [
          {
            role: 'user',
            parts: userParts,
          },
        ],
        generation_config: {
          response_mime_type: 'application/json',
        },
      }),
    });

    if (response.ok) {
      const body = await response.json();
      const text = stripJsonFence(extractGeminiText(body));
      return JSON.parse(text || '{}');
    }

    const detail = await response.text().catch(() => '');
    lastError = new Error(`Gemini request failed for ${modelCode} with ${response.status}${detail ? `: ${detail}` : ''}`);

    if (response.status !== 503 && response.status !== 429) {
      throw lastError;
    }
  }

  throw lastError || new Error('Gemini request failed for all configured models.');
}

function collectMediaSignals(incident) {
  const uploads = incident.uploads || [];
  const timeline = incident.timeline || [];

  return uploads.map((upload, index) => {
    const correlated = timeline[index] || {};
    return {
      originalName: upload.originalName,
      type: upload.type,
      mimeType: upload.mimeType,
      capturedAt: upload.capturedAt || correlated.capturedAt || null,
      location: upload.location || correlated.location || null,
      deviceId: upload.deviceId || correlated.deviceId || null,
      verified: Boolean(correlated.verified),
      syntheticRisk: correlated.syntheticRisk || null,
      anomalyFlags: correlated.anomalyFlags || [],
      storagePath: upload.storagePath,
    };
  });
}

async function buildImageInputs(signals) {
  const imageSignals = signals.filter(item => item.mimeType && item.mimeType.startsWith('image/')).slice(0, 2);
  const result = [];

  for (const signal of imageSignals) {
    try {
      const raw = await fs.readFile(signal.storagePath);
      result.push({
        inline_data: {
          mime_type: signal.mimeType,
          data: raw.toString('base64'),
        },
      });
    } catch (error) {
      result.push({
        text: `Image ${signal.originalName} could not be loaded for direct vision analysis.`,
      });
    }
  }

  return result;
}

async function analyzeIncidentWithGemini(incident, description, signals) {
  const fallback = buildHeuristicAnalysis(incident, description, signals);
  const openAIConfigError = getAIConfigError();

  if (openAIConfigError) {
    return {
      ...fallback,
      providerStatus: {
        ai: 'misconfigured',
        search: 'pending',
      },
      warnings: [openAIConfigError],
    };
  }

  const mediaSummary = signals.map(signal => (
    `File: ${signal.originalName}; type: ${signal.type}; capturedAt: ${signal.capturedAt || 'unknown'}; location: ${signal.location || 'unknown'}; verified: ${signal.verified}; syntheticRisk: ${signal.syntheticRisk ?? 'unknown'}; flags: ${signal.anomalyFlags.map(flag => flag.label).join(', ') || 'none'}`
  )).join('\n');

  try {
    const parsed = await generateGeminiJson({
      system: 'You analyze public-safety incident evidence and produce structured web-search intelligence. Return only JSON.',
      userParts: [
        {
          text: [
            `Incident notes: ${incident.notes || 'None provided.'}`,
            `Analyst description: ${description || 'None provided.'}`,
            `Media summary:\n${mediaSummary}`,
            'Return JSON with keys: headline, summary, incident_type, location_hint, entities, search_queries, corroboration_questions, confidence, rationale.',
            'entities must be an array of short strings. search_queries must be an array of 3 to 6 concise search queries.',
          ].join('\n\n'),
        },
        ...(await buildImageInputs(signals)),
      ],
    });

    return {
      headline: normalizeText(parsed.headline) || fallback.headline,
      summary: normalizeText(parsed.summary) || fallback.summary,
      incidentType: normalizeText(parsed.incident_type) || fallback.incidentType,
      locationHint: normalizeText(parsed.location_hint) || fallback.locationHint,
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(normalizeText).filter(Boolean) : fallback.entities,
      searchQueries: Array.isArray(parsed.search_queries) ? parsed.search_queries.map(normalizeText).filter(Boolean).slice(0, 6) : fallback.searchQueries,
      corroborationQuestions: Array.isArray(parsed.corroboration_questions) ? parsed.corroboration_questions.map(normalizeText).filter(Boolean) : fallback.corroborationQuestions,
      confidence: Math.max(0.2, Math.min(0.98, Number(parsed.confidence) || fallback.confidence)),
      rationale: normalizeText(parsed.rationale) || fallback.rationale,
      providerStatus: {
        ai: 'configured',
        search: 'pending',
      },
    };
  } catch (error) {
    return {
      ...fallback,
      providerStatus: {
        ai: 'fallback',
        search: 'pending',
      },
      warnings: [`AI analysis fallback used: ${error.message}`],
    };
  }
}

function buildHeuristicAnalysis(incident, description, signals) {
  const text = normalizeText(`${incident.notes || ''} ${description || ''}`);
  const entities = Array.from(new Set(text.match(/\b[A-Z][a-zA-Z0-9-]{2,}\b/g) || [])).slice(0, 8);
  const locationHint = signals.find(item => item.location)?.location || 'Unknown location';
  const typeCounts = signals.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'media';
  const queryBase = trimWords(text || `${dominantType} incident ${locationHint}`, 18);

  return {
    headline: `Possible corroborating reports for ${dominantType} incident`,
    summary: text || 'Media evidence uploaded without analyst description. Search will rely on metadata and filename hints.',
    incidentType: dominantType,
    locationHint,
    entities,
    searchQueries: [
      `${queryBase} ${locationHint}`,
      `${queryBase} witness report`,
      `${queryBase} news`,
      `${queryBase} social media video`,
    ].map(normalizeText),
    corroborationQuestions: [
      'Do local news or public incident logs describe the same time window?',
      'Are there matching witness videos or photos from nearby observers?',
      'Do article timestamps and location references align with the uploaded metadata?',
    ],
    confidence: 0.44,
    rationale: 'Fallback analysis generated from incident notes, description text, and file metadata.',
  };
}

async function searchWithSerpApi(query) {
  if (!SERPAPI_KEY) return [];

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', SERPAPI_KEY);
  url.searchParams.set('num', '5');

  const response = await fetchJson(url);
  if (!response.ok) {
    throw new Error(`SerpAPI request failed with ${response.status}`);
  }

  const body = await response.json();
  const organic = Array.isArray(body.organic_results) ? body.organic_results : [];

  return organic.slice(0, 5).map(item => ({
    provider: 'serpapi',
    title: normalizeText(item.title),
    url: item.link,
    snippet: normalizeText(item.snippet),
    source: normalizeText(item.source || item.displayed_link),
    publishedAt: item.date || null,
  }));
}

async function searchWithNewsApi(query) {
  if (!NEWS_API_KEY) return [];

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('pageSize', '5');
  url.searchParams.set('sortBy', 'publishedAt');

  const response = await fetchJson(url, {
    headers: { 'X-Api-Key': NEWS_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`NewsAPI request failed with ${response.status}`);
  }

  const body = await response.json();
  const articles = Array.isArray(body.articles) ? body.articles : [];

  return articles.slice(0, 5).map(item => ({
    provider: 'newsapi',
    title: normalizeText(item.title),
    url: item.url,
    snippet: normalizeText(item.description || item.content),
    source: normalizeText(item.source?.name),
    publishedAt: item.publishedAt || null,
  }));
}

async function searchWithGNews(query) {
  if (!GNEWS_API_KEY) return [];

  const url = new URL('https://gnews.io/api/v4/search');
  url.searchParams.set('q', query);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('max', '5');
  url.searchParams.set('apikey', GNEWS_API_KEY);

  const response = await fetchJson(url);
  if (!response.ok) {
    throw new Error(`GNews request failed with ${response.status}`);
  }

  const body = await response.json();
  const articles = Array.isArray(body.articles) ? body.articles : [];

  return articles.slice(0, 5).map(item => ({
    provider: 'gnews',
    title: normalizeText(item.title),
    url: item.url,
    snippet: normalizeText(item.description || item.content),
    source: normalizeText(item.source?.name),
    publishedAt: item.publishedAt || null,
  }));
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter(item => {
    const key = item.url || `${item.title}-${item.source}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreResult(result, analysis) {
  const haystack = normalizeText(`${result.title} ${result.snippet} ${result.source}`).toLowerCase();
  let score = 0.2;

  for (const entity of analysis.entities || []) {
    if (haystack.includes(entity.toLowerCase())) score += 0.12;
  }

  if (analysis.locationHint && analysis.locationHint !== 'Unknown location') {
    const locationTokens = analysis.locationHint.toLowerCase().split(/[,\s]+/).filter(token => token.length > 2);
    if (locationTokens.some(token => haystack.includes(token))) {
      score += 0.18;
    }
  }

  const incidentTokens = normalizeText(analysis.incidentType).toLowerCase().split(/\s+/).filter(token => token.length > 2);
  if (incidentTokens.some(token => haystack.includes(token))) {
    score += 0.18;
  }

  if (/video|photo|footage|witness|incident|police|report/.test(haystack)) {
    score += 0.14;
  }

  return Math.max(0.1, Math.min(0.99, score));
}

function buildPhotoFallbackReport({ file, buffer, metadata = {}, description = '', advancedForensics = null }) {
  const reasons = [];
  const filename = String(file.originalname || '').toLowerCase();
  let suspicion = 0.2;
  const forensicSignals = extractBasicImageSignals(file, buffer, metadata, advancedForensics);

  if (!metadata.capturedAt) {
    suspicion += 0.14;
    reasons.push('No reliable capture timestamp was provided.');
  } else {
    suspicion -= 0.06;
    reasons.push('Capture timestamp is present.');
  }

  if (!metadata.deviceId) {
    suspicion += 0.08;
    reasons.push('Device model metadata is missing.');
  } else {
    suspicion -= 0.04;
    reasons.push(`Device metadata references ${metadata.deviceId}.`);
  }

  if (!metadata.location) {
    suspicion += 0.05;
    reasons.push('No embedded location metadata was detected.');
  } else {
    suspicion -= 0.03;
    reasons.push('Embedded location metadata is present.');
  }

  if (!file.mimetype?.startsWith('image/')) {
    suspicion += 0.22;
    reasons.push('The upload is not a standard image type.');
  } else {
    suspicion -= 0.03;
  }

  if (filename.includes('edited')) {
    suspicion += 0.12;
    reasons.push('Filename hints that the image may have been edited.');
  }

  if (description) {
    reasons.push('The verifier description was included in the assessment context.');
  }

  const fused = buildForensicFusion({
    fallbackProbability: clamp(suspicion, 0.04, 0.98),
    forensicSignals,
    advancedForensics,
  });
  const fakeProbability = clamp(Math.max(fused.probability, forensicSignals.suspicion * 0.96), 0.04, 0.98);
  const verdict = fakeProbability >= 0.68 ? 'fake' : fakeProbability >= 0.45 ? 'needs_review' : 'real';
  const confidence = verdict === 'real'
    ? clamp(0.66 + (0.45 - fakeProbability) * 0.55, 0.58, 0.94)
    : verdict === 'fake'
      ? clamp(0.66 + (fakeProbability - 0.68) * 0.7, 0.58, 0.95)
      : clamp(0.46 + Math.abs(fakeProbability - 0.56) * 0.2, 0.4, 0.68);

  return finalizeAuthenticityVerdict({
    verdict,
    confidence,
    fakeProbability,
    summary: verdict === 'real'
      ? 'The image metadata does not strongly indicate manipulation, but this is not a definitive authenticity proof.'
      : verdict === 'fake'
        ? 'The image shows several metadata or consistency signals that justify treating it as potentially manipulated.'
      : 'The image has mixed signals and should receive analyst review before being trusted.',
    reasons: [...reasons, ...(fused.reasons || [])],
    provider: 'heuristic-forensic',
    fallback: { fakeProbability, verdict, confidence },
    forensicSignals,
    description,
  });
}

async function buildPhotoAuthenticityReport({ file, buffer, metadata = {}, description = '' }) {
  const advancedForensics = await runPhotoForensics({
    buffer,
    originalName: file.originalname,
  });
  const fallback = buildPhotoFallbackReport({ file, buffer, metadata, description, advancedForensics });
  const openAIConfigError = getAIConfigError();

  if (openAIConfigError || !file.mimetype?.startsWith('image/')) {
    return {
      ...fallback,
      advancedForensics,
      summary: openAIConfigError
        ? `${fallback.summary} AI fallback used because ${openAIConfigError}`
        : fallback.summary,
    };
  }

  try {
    const extractedClaim = await extractClaimFromImage({ file, buffer, metadata, description });
    if (extractedClaim?.claim) {
      const claimReport = await verifyVisualClaim(extractedClaim.claim, {
        description,
        contextType: extractedClaim.contextType,
      });

      return {
        ...finalizeAuthenticityVerdict({
          verdict: claimReport.verdict,
          confidence: claimReport.confidence,
          fakeProbability: claimReport.fakeProbability,
          summary: normalizeText(claimReport.summary) || fallback.summary,
          reasons: Array.isArray(claimReport.reasons) && claimReport.reasons.length > 0
            ? claimReport.reasons
            : fallback.reasons,
          provider: claimReport.provider,
          fallback,
          forensicSignals: fallback.forensicSignals,
          description,
        }),
        summary: normalizeText(claimReport.summary) || fallback.summary,
        extractedClaim: extractedClaim.claim,
        contextType: extractedClaim.contextType,
      };
    }

    const parsed = await generateGeminiJson({
      system: 'Assess whether the uploaded photo shows authenticity concerns. Distinguish between an authentic camera photo and a screenshot or repost of a possibly false claim. Screenshots of news or social posts should usually be needs_review unless there is strong evidence of manipulation or fabrication. Only use real when there is strong evidence the image is an authentic camera photo and no meaningful manipulation cues. If provenance is weak, choose needs_review rather than real. Return only JSON. Do not claim certainty. Use verdict real, fake, or needs_review.',
      userParts: [
        {
          text: [
            `Filename: ${file.originalname}`,
            `MIME type: ${file.mimetype}`,
            `Captured at: ${metadata.capturedAt || 'unknown'}`,
            `Location: ${metadata.location || 'unknown'}`,
            `Device: ${metadata.deviceId || 'unknown'}`,
            `Basic forensic signals: ${JSON.stringify({
              format: fallback.forensicSignals?.format,
              width: fallback.forensicSignals?.width,
              height: fallback.forensicSignals?.height,
              likelyScreenshot: fallback.forensicSignals?.likelyScreenshot,
              genericFilename: fallback.forensicSignals?.genericFilename,
            })}`,
            `Verifier description: ${description || 'none provided'}`,
            'Return JSON with keys: verdict, confidence, fake_probability, summary, reasons, detected_artifacts.',
            'detected_artifacts must be an array of short strings covering cues like edge blending, warped geometry, inconsistent lighting, malformed text, or facial asymmetry when present.',
          ].join('\n'),
        },
        {
          inline_data: {
            mime_type: file.mimetype,
            data: buffer.toString('base64'),
          },
        },
      ],
    });
    const verdict = ['real', 'fake', 'needs_review'].includes(parsed.verdict) ? parsed.verdict : fallback.verdict;
    const fused = buildForensicFusion({
      fallbackProbability: fallback.fakeProbability,
      forensicSignals: fallback.forensicSignals,
      advancedForensics,
      aiProbability: clamp(Number(parsed.fake_probability) || fallback.fakeProbability, 0.02, 0.98),
    });
    const result = finalizeAuthenticityVerdict({
      verdict,
      confidence: clamp(Number(parsed.confidence) || fallback.confidence, 0.25, 0.98),
      fakeProbability: Math.max(
        clamp(Number(parsed.fake_probability) || fallback.fakeProbability, 0.02, 0.98),
        fused.probability,
      ),
      summary: normalizeText(parsed.summary) || fallback.summary,
      reasons: Array.isArray(parsed.reasons) && parsed.reasons.length > 0
        ? parsed.reasons.map(reason => normalizeText(reason)).filter(Boolean)
        : [...fallback.reasons, ...(fused.reasons || [])],
      provider: 'gemini-forensic',
      fallback,
      forensicSignals: fallback.forensicSignals,
      description,
    });

    return {
      ...result,
      advancedForensics,
      detectedArtifacts: Array.isArray(parsed.detected_artifacts)
        ? parsed.detected_artifacts.map(item => normalizeText(item)).filter(Boolean).slice(0, 8)
        : [],
    };
  } catch (error) {
    return {
      ...fallback,
      advancedForensics,
      summary: `${fallback.summary} AI fallback used because ${error.message}.`,
    };
  }
}

async function analyzeVideoFramesLocally(frames = []) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return {
      available: false,
      frameReports: [],
      suspiciousFrameCount: 0,
      averageSuspicion: null,
      peakSuspicion: null,
      aggregatedProbability: null,
      reasons: [],
    };
  }

  const frameReports = await Promise.all(frames.map(async frame => {
    const report = await runPhotoForensics({
      buffer: frame.buffer,
      originalName: frame.filename || 'frame.jpg',
    });

    return {
      filename: frame.filename,
      sampleTime: frame.sampleTime,
      available: report.available,
      suspicion: report.suspicion,
      reasons: report.reasons || [],
      metrics: report.metrics || {},
    };
  }));

  const availableReports = frameReports.filter(item => item.available);
  const suspicions = availableReports.map(item => item.suspicion).filter(Number.isFinite);
  const averageSuspicion = average(suspicions);
  const peakSuspicion = suspicions.length > 0 ? Math.max(...suspicions) : null;
  const suspiciousFrameCount = availableReports.filter(item => item.suspicion >= 0.62).length;
  const aggregatedProbability = suspicions.length > 0
    ? blendProbabilities([
      { probability: averageSuspicion, weight: 1.1 },
      Number.isFinite(peakSuspicion) ? { probability: peakSuspicion, weight: 1.4 } : null,
      suspiciousFrameCount > 0 ? { probability: clamp(0.45 + suspiciousFrameCount * 0.12, 0.45, 0.9), weight: 1.0 } : null,
    ])
    : null;

  const reasons = Array.from(new Set(
    availableReports
      .flatMap(item => item.reasons || [])
      .filter(Boolean),
  )).slice(0, 10);

  return {
    available: availableReports.length > 0,
    frameReports,
    suspiciousFrameCount,
    averageSuspicion,
    peakSuspicion,
    aggregatedProbability,
    reasons,
  };
}

function buildVideoFallbackReport({ file, metadata = {}, description = '', extraction = {}, frameForensics = null }) {
  const reasons = [];
  let suspicion = 0.34;
  const filename = normalizeText(file.originalname).toLowerCase();
  const duration = extraction.video?.durationSeconds || null;
  const frameRate = extraction.video?.frameRate || null;
  const width = extraction.video?.width || null;
  const height = extraction.video?.height || null;

  if (!file.mimetype?.startsWith('video/')) {
    suspicion += 0.22;
    reasons.push('The upload is not a standard video type.');
  } else {
    suspicion -= 0.04;
  }

  if (!metadata.capturedAt) {
    suspicion += 0.1;
    reasons.push('No capture timestamp was supplied for the video.');
  } else {
    suspicion -= 0.03;
    reasons.push('A capture timestamp was supplied.');
  }

  if (!metadata.location) {
    suspicion += 0.06;
    reasons.push('No capture location was supplied for the video.');
  } else {
    suspicion -= 0.02;
  }

  if (/ai|generated|render|deepfake|faceswap|synthetic|edited/.test(filename)) {
    suspicion += 0.12;
    reasons.push('The filename suggests editing or synthetic generation.');
  }

  if (duration !== null && duration < 1.2) {
    suspicion += 0.08;
    reasons.push('The clip is extremely short, which limits confidence and can mask visual artifacts.');
  }

  if (frameRate && (frameRate > 60 || frameRate < 10)) {
    suspicion += 0.05;
    reasons.push('The frame rate is atypical for normal phone footage.');
  }

  if (width && height && width * height < 320 * 240) {
    suspicion += 0.06;
    reasons.push('The video resolution is very low, which reduces forensic reliability.');
  }

  if (!extraction.available) {
    suspicion += 0.06;
    reasons.push('Frame extraction tools are unavailable, so only metadata heuristics were used.');
  } else if ((extraction.frames || []).length === 0) {
    suspicion += 0.08;
    reasons.push('No usable frames could be extracted from the video.');
  } else {
    suspicion -= 0.04;
    reasons.push(`Sampled ${(extraction.frames || []).length} frame(s) for review.`);
  }

  if (frameForensics?.available) {
    const averageFrameSuspicion = Number.isFinite(frameForensics.averageSuspicion)
      ? frameForensics.averageSuspicion
      : 0;
    suspicion = Math.max(suspicion, clamp(0.12 + averageFrameSuspicion * 0.92, 0.05, 0.98));

    if (frameForensics.suspiciousFrameCount > 0) {
      reasons.push(`${frameForensics.suspiciousFrameCount} sampled frame(s) showed strong local forensic anomalies.`);
    } else {
      reasons.push('Sampled frame forensics completed without decisive synthetic evidence.');
    }
  }

  if (description) {
    reasons.push('The verifier description was included in the assessment context.');
  }

  const fakeProbability = clamp(Math.max(suspicion, frameForensics?.aggregatedProbability || 0), 0.05, 0.98);
  const verdict = fakeProbability >= 0.68 ? 'fake' : fakeProbability >= 0.45 ? 'needs_review' : 'real';

  return {
    verdict,
    confidence: verdict === 'needs_review'
      ? clamp(0.44 + Math.abs(fakeProbability - 0.55) * 0.18, 0.4, 0.69)
      : clamp(0.63 + Math.abs(fakeProbability - 0.56) * 0.45, 0.56, 0.93),
    fakeProbability,
    summary: extraction.available
      ? 'The video was sampled for a lightweight authenticity review, but this remains a screening result rather than a forensic proof.'
      : 'The video authenticity result is based on metadata heuristics because local frame extraction is not available.',
    reasons: [...reasons, ...((frameForensics?.reasons) || [])],
    provider: frameForensics?.available ? 'ensemble-video-forensics' : extraction.available ? 'heuristic-frames' : 'heuristic-metadata',
    frameObservations: [],
    sampledFrames: (extraction.frames || []).map(frame => ({
      filename: frame.filename,
      sampleTime: frame.sampleTime,
    })),
    technicalSignals: {
      durationSeconds: duration,
      frameRate,
      width,
      height,
      codec: extraction.video?.codec || null,
      ffmpegAvailable: Boolean(extraction.available),
    },
    localFrameForensics: frameForensics ? {
      available: Boolean(frameForensics.available),
      suspiciousFrameCount: frameForensics.suspiciousFrameCount,
      averageSuspicion: frameForensics.averageSuspicion,
      peakSuspicion: frameForensics.peakSuspicion,
      frameReports: frameForensics.frameReports.map(item => ({
        filename: item.filename,
        sampleTime: item.sampleTime,
        suspicion: item.suspicion,
      })),
    } : null,
  };
}

async function buildVideoAuthenticityReport({ file, metadata = {}, description = '' }) {
  const extraction = await extractVideoFrames(file.storagePath, { maxFrames: 3 });
  const frameForensics = await analyzeVideoFramesLocally(extraction.frames || []);
  const fallback = buildVideoFallbackReport({ file, metadata, description, extraction, frameForensics });
  const openAIConfigError = getAIConfigError();

  if (openAIConfigError || !file.mimetype?.startsWith('video/') || (extraction.frames || []).length === 0) {
    return {
      ...fallback,
      summary: openAIConfigError
        ? `${fallback.summary} AI fallback used because ${openAIConfigError}`
        : fallback.summary,
    };
  }

  try {
    const parsed = await generateGeminiJson({
      system: [
        'You assess whether a video may be AI-generated, deepfaked, face-swapped, or materially manipulated.',
        'You are reviewing a small set of sampled frames plus metadata, not the entire video.',
        'Do not claim certainty. Use fake only when the sampled frames show strong synthetic or manipulation cues.',
        'Return only JSON.',
      ].join(' '),
      userParts: [
        {
          text: [
            `Filename: ${file.originalname}`,
            `MIME type: ${file.mimetype}`,
            `Captured at: ${metadata.capturedAt || 'unknown'}`,
            `Location: ${metadata.location || 'unknown'}`,
            `Device: ${metadata.deviceId || 'unknown'}`,
            `Duration seconds: ${extraction.video?.durationSeconds ?? 'unknown'}`,
            `Resolution: ${extraction.video?.width || 'unknown'}x${extraction.video?.height || 'unknown'}`,
            `Frame rate: ${extraction.video?.frameRate || 'unknown'}`,
            `Codec: ${extraction.video?.codec || 'unknown'}`,
            `Verifier description: ${description || 'none provided'}`,
            `Sample times: ${(extraction.frames || []).map(frame => `${frame.sampleTime}s`).join(', ') || 'none'}`,
            'Return JSON with keys: verdict, confidence, fake_probability, summary, reasons, frame_observations, detected_artifacts.',
            'verdict must be one of real, fake, or needs_review.',
            'frame_observations must be an array of short strings.',
            'detected_artifacts must be an array of short strings such as inconsistent face edges, warped text, unstable hands, impossible reflections, or unnatural lighting.',
          ].join('\n'),
        },
        ...extraction.frames.map(frame => ({
          inline_data: {
            mime_type: frame.mimeType,
            data: frame.buffer.toString('base64'),
          },
        })),
      ],
    });

    const verdict = ['real', 'fake', 'needs_review'].includes(parsed.verdict) ? parsed.verdict : fallback.verdict;
    const frameObservations = Array.isArray(parsed.frame_observations)
      ? parsed.frame_observations.map(item => normalizeText(item)).filter(Boolean).slice(0, 6)
      : [];
    const detectedArtifacts = Array.isArray(parsed.detected_artifacts)
      ? parsed.detected_artifacts.map(item => normalizeText(item)).filter(Boolean).slice(0, 8)
      : [];
    const fusedProbability = blendProbabilities([
      { probability: clamp(Number(parsed.fake_probability) || fallback.fakeProbability, 0.02, 0.98), weight: 1.0 },
      Number.isFinite(frameForensics?.aggregatedProbability) ? { probability: frameForensics.aggregatedProbability, weight: 1.35 } : null,
      { probability: fallback.fakeProbability, weight: 1.1 },
    ]);

    return {
      verdict,
      confidence: clamp(Number(parsed.confidence) || fallback.confidence, 0.25, 0.98),
      fakeProbability: Math.max(clamp(Number(parsed.fake_probability) || fallback.fakeProbability, 0.02, 0.98), fusedProbability),
      summary: normalizeText(parsed.summary) || fallback.summary,
      reasons: Array.isArray(parsed.reasons) && parsed.reasons.length > 0
        ? parsed.reasons.map(reason => normalizeText(reason)).filter(Boolean)
        : fallback.reasons,
      provider: 'gemini-video',
      frameObservations,
      detectedArtifacts,
      sampledFrames: fallback.sampledFrames,
      technicalSignals: fallback.technicalSignals,
      localFrameForensics: fallback.localFrameForensics,
    };
  } catch (error) {
    return {
      ...fallback,
      summary: `${fallback.summary} AI fallback used because ${error.message}.`,
    };
  }
}

async function extractClaimFromImage({ file, buffer, metadata = {}, description = '' }) {
  const parsed = await generateGeminiJson({
    system: 'You inspect uploaded images and determine whether they contain a visible news headline, social-media claim, meme text, or screenshot text that should be verified on the web. Return only JSON.',
    userParts: [
      {
        text: [
          `Filename: ${file.originalname}`,
          `MIME type: ${file.mimetype}`,
          `Captured at: ${metadata.capturedAt || 'unknown'}`,
          `Location: ${metadata.location || 'unknown'}`,
          `Device: ${metadata.deviceId || 'unknown'}`,
          `Verifier description: ${description || 'none provided'}`,
          'Return JSON with keys: contains_claim, extracted_claim, context_type, rationale.',
          'context_type must be one of screenshot, post, headline, photo, or other.',
          'If there is visible text to verify, extracted_claim should contain the clearest concise claim or headline from the image.',
        ].join('\n'),
      },
      {
        inline_data: {
          mime_type: file.mimetype,
          data: buffer.toString('base64'),
        },
      },
    ],
  });
  const claim = trimWords(normalizeText(parsed.extracted_claim), 24);

  return {
    containsClaim: Boolean(parsed.contains_claim),
    claim: parsed.contains_claim && claim ? claim : '',
    contextType: ['screenshot', 'post', 'headline', 'photo', 'other'].includes(parsed.context_type)
      ? parsed.context_type
      : 'other',
    rationale: normalizeText(parsed.rationale),
  };
}

async function verifyVisualClaim(claim, { description = '', contextType = 'other' } = {}) {
  const incident = {
    notes: claim,
    uploads: [],
    timeline: [],
  };
  const analysis = await analyzeIncidentWithGemini(incident, `${claim}\n${description}`.trim(), []);
  const webSearch = await fetchSearchResults(analysis);

  const fallbackVerdict = webSearch.results.length > 0 ? 'needs_review' : 'needs_review';
  const fallbackSummary = webSearch.results.length > 0
    ? 'The visible claim was extracted from the image and matched against live web/news results, but the evidence is not strong enough for a confident true/false decision.'
    : 'The visible claim was extracted from the image, but no strong live corroboration was available.';

  if (!OPENAI_API_KEY) {
    return {
      verdict: fallbackVerdict,
      confidence: 0.45,
      fakeProbability: 0.5,
      summary: fallbackSummary,
      reasons: [
        `Visible claim extracted: ${claim}`,
        `Context detected: ${contextType}.`,
      ],
      provider: 'heuristic-web',
      sources: webSearch.results.slice(0, 5),
      searchQueries: analysis.searchQueries,
    };
  }

  const parsed = await generateGeminiJson({
    system: 'You verify a visible claim extracted from an image using only supplied web/news search results. Decide whether the claim appears real, fake, or needs_review. Use fake when the results strongly contradict or debunk the claim. Use real when multiple reliable results strongly support it. Use needs_review when evidence is weak, mixed, or missing. Return only JSON.',
    userParts: [
      {
        text: [
          `Extracted claim: ${claim}`,
          `Image context type: ${contextType}`,
          `Extra verifier description: ${description || 'none provided'}`,
          `Search queries: ${(analysis.searchQueries || []).join(' | ')}`,
          `Matched results:\n${webSearch.results.slice(0, 8).map((item, index) => `${index + 1}. ${item.title} | ${item.source} | ${item.publishedAt || 'no date'} | ${item.snippet}`).join('\n')}`,
          'Return JSON with keys: verdict, confidence, fake_probability, summary, reasons.',
          'verdict must be one of real, fake, or needs_review.',
        ].join('\n\n'),
      },
    ],
  });
  const verdict = ['real', 'fake', 'needs_review'].includes(parsed.verdict) ? parsed.verdict : fallbackVerdict;

  return {
    verdict,
    confidence: clamp(Number(parsed.confidence) || 0.45, 0.25, 0.98),
    fakeProbability: clamp(
      Number(parsed.fake_probability) || (verdict === 'fake' ? 0.82 : verdict === 'real' ? 0.18 : 0.5),
      0.02,
      0.98
    ),
    summary: normalizeText(parsed.summary) || fallbackSummary,
    reasons: Array.isArray(parsed.reasons) && parsed.reasons.length > 0
      ? parsed.reasons.map(reason => normalizeText(reason)).filter(Boolean)
      : [
        `Visible claim extracted: ${claim}`,
        `Context detected: ${contextType}.`,
      ],
    provider: 'gemini-web',
    sources: webSearch.results.slice(0, 5),
    searchQueries: analysis.searchQueries,
  };
}

function buildFallbackWebResults(analysis) {
  return analysis.searchQueries.slice(0, 3).map((query, index) => ({
    provider: 'manual',
    title: `Manual web search recommended: ${query}`,
    url: null,
    snippet: 'Configure a search provider key to fetch live corroborating reports automatically.',
    source: 'Local fallback',
    publishedAt: null,
    relevanceScore: Math.max(0.35, 0.55 - index * 0.05),
  }));
}

function summarizeResults(analysis, rankedResults) {
  if (rankedResults.length === 0) {
    return 'No live web results were fetched. Add at least one search provider key to enable automatic corroboration.';
  }

  const top = rankedResults[0];
  const strongMatches = rankedResults.filter(item => item.relevanceScore >= 0.55).length;

  return [
    `Top corroborating lead: ${top.title}.`,
    strongMatches > 1
      ? `${strongMatches} results show moderate or stronger alignment with the uploaded incident description.`
      : 'Only a limited number of results show meaningful overlap with the uploaded evidence.',
    'Review source timestamps, geography, and whether witness details genuinely match before treating these as confirmation.',
  ].join(' ');
}

function buildQuestionFallbackAnswer(question, analysis, rankedResults) {
  const topResults = rankedResults.slice(0, 3);
  const topTitles = topResults.map(item => item.title).filter(Boolean);
  const confidence = topResults.length > 0 ? 0.62 : 0.34;

  return {
    answer: topResults.length > 0
      ? `Based on the currently matched reports, the strongest leads are: ${topTitles.join('; ')}. Treat this as corroboration support rather than definitive proof.`
      : 'I could not verify the question with live sources right now. Add search provider keys or retry with a more specific question.',
    confidence,
    rationale: topResults.length > 0
      ? 'Answer generated from the top ranked external results and the query interpretation step.'
      : 'No live corroborating results were available, so the response falls back to query generation only.',
    verdict: topResults.length > 0 ? 'partially_verified' : 'unverified',
    provider: 'heuristic',
    searchQueries: analysis.searchQueries,
  };
}

async function fetchSearchResults(analysis) {
  const queries = analysis.searchQueries.slice(0, 4);
  const collected = [];
  const warnings = [];

  for (const query of queries) {
    const providerCalls = [
      searchWithSerpApi(query),
      searchWithNewsApi(query),
      searchWithGNews(query),
    ];

    const settled = await Promise.allSettled(providerCalls);
    settled.forEach(item => {
      if (item.status === 'fulfilled') {
        collected.push(...item.value);
      } else {
        warnings.push(item.reason.message);
      }
    });
  }

  const deduped = dedupeResults(collected);
  if (deduped.length === 0) {
    return {
      results: buildFallbackWebResults(analysis),
      providerStatus: 'fallback',
      warnings,
    };
  }

  const ranked = deduped.map(result => ({
    ...result,
    relevanceScore: scoreResult(result, analysis),
  })).sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);

  return {
    results: ranked,
    providerStatus: 'configured',
    warnings,
  };
}

async function buildIntelligenceReport(incident, description) {
  const signals = collectMediaSignals(incident);
  const analysis = await analyzeIncidentWithGemini(incident, description, signals);
  const webSearch = await fetchSearchResults(analysis);

  const report = {
    id: `intel-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    createdAt: new Date().toISOString(),
    description: normalizeText(description),
    analysis: {
      headline: analysis.headline,
      summary: analysis.summary,
      incidentType: analysis.incidentType,
      locationHint: analysis.locationHint,
      entities: analysis.entities,
      searchQueries: analysis.searchQueries,
      corroborationQuestions: analysis.corroborationQuestions,
      confidence: analysis.confidence,
      rationale: analysis.rationale,
    },
    results: webSearch.results,
    summary: summarizeResults(analysis, webSearch.results),
    providerStatus: {
      ai: analysis.providerStatus.ai,
      search: webSearch.providerStatus,
    },
    warnings: [...(analysis.warnings || []), ...(webSearch.warnings || [])],
  };

  return report;
}

async function buildQuestionVerificationReport(question) {
  const normalizedQuestion = normalizeText(question);
  const incident = {
    notes: normalizedQuestion,
    uploads: [],
    timeline: [],
  };
  const analysis = await analyzeIncidentWithGemini(incident, normalizedQuestion, []);
  const webSearch = await fetchSearchResults(analysis);
  const fallback = buildQuestionFallbackAnswer(normalizedQuestion, analysis, webSearch.results);
  const openAIConfigError = getAIConfigError();

  if (openAIConfigError) {
    return {
      ...fallback,
      sources: webSearch.results.slice(0, 5),
      warnings: [...(analysis.warnings || []), ...(webSearch.warnings || []), openAIConfigError],
      providerStatus: {
        ai: analysis.providerStatus.ai,
        search: webSearch.providerStatus,
      },
    };
  }

  try {
    const parsed = await generateGeminiJson({
      system: 'You answer verification questions using only the supplied search results and context. Return only JSON.',
      userParts: [
        {
          text: [
            `Question: ${normalizedQuestion}`,
            `Generated incident framing: ${analysis.summary}`,
            `Search queries: ${(analysis.searchQueries || []).join(' | ')}`,
            `Matched results:\n${webSearch.results.slice(0, 6).map((item, index) => `${index + 1}. ${item.title} | ${item.source} | ${item.publishedAt || 'no date'} | ${item.snippet}`).join('\n')}`,
            'Return JSON with keys: answer, confidence, verdict, rationale.',
            'verdict must be one of verified, partially_verified, inconclusive, or unverified.',
          ].join('\n\n'),
        },
      ],
    });
    const verdict = ['verified', 'partially_verified', 'inconclusive', 'unverified'].includes(parsed.verdict)
      ? parsed.verdict
      : fallback.verdict;

    return {
      answer: normalizeText(parsed.answer) || fallback.answer,
      confidence: clamp(Number(parsed.confidence) || fallback.confidence, 0.2, 0.98),
      verdict,
      rationale: normalizeText(parsed.rationale) || fallback.rationale,
      provider: 'gemini',
      searchQueries: analysis.searchQueries,
      sources: webSearch.results.slice(0, 5),
      warnings: [...(analysis.warnings || []), ...(webSearch.warnings || [])],
      providerStatus: {
        ai: analysis.providerStatus.ai,
        search: webSearch.providerStatus,
      },
    };
  } catch (error) {
    return {
      ...fallback,
      answer: `${fallback.answer} AI fallback used because ${error.message}.`,
      sources: webSearch.results.slice(0, 5),
      warnings: [...(analysis.warnings || []), ...(webSearch.warnings || []), error.message],
      providerStatus: {
        ai: 'fallback',
        search: webSearch.providerStatus,
      },
    };
  }
}

module.exports = {
  buildIntelligenceReport,
  buildPhotoAuthenticityReport,
  buildQuestionVerificationReport,
  buildVideoAuthenticityReport,
  hasFfmpeg,
  hasFfprobe,
};
