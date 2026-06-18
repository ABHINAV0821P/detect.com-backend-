function parseCaptureTime(upload) {
  if (!upload.capturedAt) return null;
  const ts = Date.parse(upload.capturedAt);
  return Number.isNaN(ts) ? null : new Date(ts);
}

function parseLocation(upload) {
  if (!upload.location) return null;
  const parts = String(upload.location).split(',').map(part => part.trim());
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

function toIsoString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function clampScore(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function computeTemporalConfidence(item, referenceItems) {
  const time = parseCaptureTime(item);
  if (!time || referenceItems.length === 0) return 0.25;

  const bestMatch = Math.min(...referenceItems.map(other => {
    const otherTime = parseCaptureTime(other);
    return otherTime ? Math.abs(time - otherTime) : Number.MAX_VALUE;
  }));

  if (!Number.isFinite(bestMatch)) return 0.25;
  const minutes = bestMatch / 60_000;
  return clampScore(1 - minutes / 12, 0.2, 1);
}

function computeSpatialConfidence(item, referenceItems) {
  const location = parseLocation(item);
  if (!location || referenceItems.length === 0) return 0.25;

  const bestDistance = Math.min(...referenceItems.map(other => {
    const otherLocation = parseLocation(other);
    if (!otherLocation) return Number.MAX_VALUE;
    const dLat = location.lat - otherLocation.lat;
    const dLon = location.lon - otherLocation.lon;
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }));

  if (!Number.isFinite(bestDistance)) return 0.25;
  return clampScore(1 - bestDistance / 0.08, 0.2, 1);
}

function buildAnomalyFlags(upload, siblings, scores) {
  const flags = [];
  const time = parseCaptureTime(upload);
  const location = parseLocation(upload);
  const authenticityReport = upload.authenticityReport;

  if (!time) {
    flags.push({
      code: 'missing_timestamp',
      severity: 'medium',
      label: 'Missing capture timestamp',
      detail: 'The file does not include a reliable capture time, reducing timeline confidence.',
    });
  }

  if (!location && upload.type !== 'audio') {
    flags.push({
      code: 'missing_location',
      severity: 'low',
      label: 'Missing capture location',
      detail: 'No GPS coordinates were recovered from the media metadata.',
    });
  }

  const similarDevice = siblings.find(other => {
    if (!other.deviceId || !upload.deviceId) return false;
    const sameDevice = other.deviceId === upload.deviceId;
    const otherTime = parseCaptureTime(other);
    return sameDevice && otherTime && time && Math.abs(otherTime - time) > 15 * 60_000;
  });

  if (similarDevice) {
    flags.push({
      code: 'device_time_drift',
      severity: 'medium',
      label: 'Device clock drift detected',
      detail: `Another upload from ${upload.deviceId} appears materially offset in time.`,
    });
  }

  if (scores.alignmentScore < 0.45) {
    flags.push({
      code: 'alignment_outlier',
      severity: 'high',
      label: 'Alignment outlier',
      detail: 'This file sits outside the strongest cross-observer timeline cluster.',
    });
  }

  if (!upload.mimeType) {
    flags.push({
      code: 'missing_mimetype',
      severity: 'low',
      label: 'Unknown media signature',
      detail: 'The MIME type is unavailable, which limits upload validation.',
    });
  }

  if (authenticityReport?.verdict && authenticityReport.verdict !== 'real') {
    flags.push({
      code: 'video_authenticity_review',
      severity: authenticityReport.verdict === 'fake' ? 'high' : 'medium',
      label: authenticityReport.verdict === 'fake' ? 'Potential synthetic video' : 'Video needs authenticity review',
      detail: authenticityReport.summary || 'Sampled video frames showed authenticity concerns.',
    });
  }

  return flags;
}

function computeSyntheticRisk(scores, flags) {
  const severityWeight = { low: 0.08, medium: 0.18, high: 0.28 };
  const flagWeight = flags.reduce((total, flag) => total + (severityWeight[flag.severity] || 0), 0);
  const metadataPenalty = scores.hasMetadata ? 0 : 0.2;
  const instabilityPenalty = (1 - scores.temporalConfidence) * 0.3 + (1 - scores.spatialConfidence) * 0.2;
  const authenticityPenalty = scores.authenticityRisk ? scores.authenticityRisk * 0.55 : 0;
  return clampScore(0.12 + flagWeight + metadataPenalty + instabilityPenalty + authenticityPenalty, 0.05, 0.98);
}

function verifyUpload(upload, siblingUploads) {
  const temporalConfidence = computeTemporalConfidence(upload, siblingUploads);
  const spatialConfidence = computeSpatialConfidence(upload, siblingUploads);
  const alignmentScore = clampScore(temporalConfidence * 0.65 + spatialConfidence * 0.35);
  const hasMetadata = Boolean(upload.capturedAt || upload.location);
  const authenticityRisk = clampScore(upload.authenticityReport?.fakeProbability || 0, 0, 0.98);

  const scores = { temporalConfidence, spatialConfidence, alignmentScore, hasMetadata, authenticityRisk };
  const anomalyFlags = buildAnomalyFlags(upload, siblingUploads, scores);
  const syntheticRisk = computeSyntheticRisk(scores, anomalyFlags);

  return {
    ...upload,
    capturedAt: toIsoString(upload.capturedAt),
    verified: alignmentScore >= 0.58
      && hasMetadata
      && syntheticRisk < 0.55
      && (!upload.authenticityReport || upload.authenticityReport.verdict === 'real'),
    temporalConfidence,
    spatialConfidence,
    alignmentScore,
    confidence: clampScore(0.45 + alignmentScore * 0.55),
    syntheticRisk,
    anomalyFlags,
    forensicStatus: syntheticRisk < 0.35 ? 'trusted' : syntheticRisk < 0.6 ? 'review' : 'high-risk',
  };
}

function buildObserverSummary(uploads) {
  const observerMap = new Map();

  uploads.forEach(upload => {
    const key = upload.deviceId || 'unknown-device';
    const current = observerMap.get(key) || { observerId: key, uploads: 0, mediaTypes: new Set() };
    current.uploads += 1;
    current.mediaTypes.add(upload.type);
    observerMap.set(key, current);
  });

  return Array.from(observerMap.values()).map(item => ({
    observerId: item.observerId,
    uploads: item.uploads,
    mediaTypes: Array.from(item.mediaTypes),
  }));
}

function buildReconstructionSummary(timeline, uploads) {
  const verifiedCount = timeline.filter(item => item.verified).length;
  const flaggedCount = timeline.filter(item => item.anomalyFlags.length > 0).length;
  const averageAlignment = timeline.length
    ? timeline.reduce((sum, item) => sum + item.alignmentScore, 0) / timeline.length
    : 0;
  const averageSyntheticRisk = timeline.length
    ? timeline.reduce((sum, item) => sum + item.syntheticRisk, 0) / timeline.length
    : 0;
  const captureTimes = timeline
    .map(item => item.capturedAt)
    .filter(Boolean)
    .map(value => Date.parse(value))
    .filter(value => !Number.isNaN(value));

  return {
    observerCount: buildObserverSummary(uploads).length,
    evidenceCount: uploads.length,
    verifiedCount,
    flaggedCount,
    averageAlignment: clampScore(averageAlignment),
    averageSyntheticRisk: clampScore(averageSyntheticRisk),
    firstObservedAt: captureTimes.length ? new Date(Math.min(...captureTimes)).toISOString() : null,
    lastObservedAt: captureTimes.length ? new Date(Math.max(...captureTimes)).toISOString() : null,
    alignmentMethod: 'Metadata correlation with OpenCV-ready hook points',
    recommendedNextStep: averageSyntheticRisk > 0.55
      ? 'Escalate to analyst review and compare waveform/frame signatures.'
      : 'Preserve the record and continue collecting corroborating observer footage.',
  };
}

function buildTimeline(uploads) {
  const items = uploads.map(upload => ({
    ...upload,
    capturedAt: toIsoString(parseCaptureTime(upload)),
  })).sort((a, b) => {
    const aTime = a.capturedAt ? Date.parse(a.capturedAt) : Number.MAX_SAFE_INTEGER;
    const bTime = b.capturedAt ? Date.parse(b.capturedAt) : Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });

  const timeline = items.map(item => verifyUpload(item, items.filter(other => other !== item)));
  const observerSummary = buildObserverSummary(items);
  const reconstructionSummary = buildReconstructionSummary(timeline, items);
  const anomalies = timeline.flatMap(item => item.anomalyFlags.map(flag => ({
    media: item.originalName,
    observerId: item.deviceId || 'unknown-device',
    capturedAt: item.capturedAt,
    ...flag,
  })));

  return {
    timeline,
    observerSummary,
    anomalies,
    reconstructionSummary,
  };
}

module.exports = { buildTimeline };
