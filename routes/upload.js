const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const multer = require('multer');
const os = require('os');
const path = require('path');
const { buildTimeline } = require('../utils/align');
const { buildVideoAuthenticityReport } = require('../utils/intelligence');
const { saveIncident } = require('../utils/store');
const { requireAuth, requireRole } = require('../utils/auth');
const { normalizeString, parseJsonField, isAllowedMediaMimeType } = require('../utils/validation');

const MAX_MEDIA_FILES = 8;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const upload = multer({
  dest: process.env.VERCEL
    ? path.join(os.tmpdir(), 'detect-uploads')
    : path.join(__dirname, '..', 'uploads'),
  limits: {
    files: MAX_MEDIA_FILES,
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter(req, file, callback) {
    if (!isAllowedMediaMimeType(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }

    return callback(null, true);
  },
});
const router = express.Router();

async function sha256File(filepath) {
  const buffer = await fs.readFile(filepath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function buildIncidentFromRequest(req) {
  const observerId = normalizeString(req.body.observerId, { maxLength: 120, allowEmpty: true }) || 'observer-command';
  const title = normalizeString(req.body.title, { maxLength: 160, allowEmpty: true }) || 'Untitled incident report';
  const locationHint = normalizeString(req.body.locationHint, { maxLength: 200, allowEmpty: true }) || null;
  const notes = normalizeString(req.body.notes, { maxLength: 4000, allowEmpty: true });
  let evidence = [];
  try {
    evidence = parseJsonField(req.body.evidence, []);
  } catch {
    const error = new Error('Evidence metadata must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }

  const files = req.files || [];
  if (files.length === 0) {
    const error = new Error('Upload at least one media file.');
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(evidence) || evidence.length > files.length) {
    const error = new Error('Evidence metadata does not match the uploaded files.');
    error.statusCode = 400;
    throw error;
  }

  const uploads = await Promise.all(files.map(async (file, index) => ({
    originalName: file.originalname,
    storagePath: file.path,
    mimeType: file.mimetype,
    size: file.size,
    sha256: await sha256File(file.path),
    capturedAt: normalizeString(evidence[index]?.capturedAt, { maxLength: 80, allowEmpty: true }) || null,
    location: normalizeString(evidence[index]?.location, { maxLength: 120, allowEmpty: true }) || null,
    type: evidence[index]?.type || (file.mimetype.startsWith('image/') ? 'photo' : file.mimetype.startsWith('video/') ? 'video' : 'audio'),
    deviceId: normalizeString(evidence[index]?.deviceId, { maxLength: 120, allowEmpty: true }) || observerId || `observer-${index + 1}`,
  })));

  const enrichedUploads = await Promise.all(uploads.map(async uploadItem => {
    if (!uploadItem.mimeType?.startsWith('video/')) {
      return uploadItem;
    }

    const videoReport = await buildVideoAuthenticityReport({
      file: {
        originalname: uploadItem.originalName,
        mimetype: uploadItem.mimeType,
        storagePath: uploadItem.storagePath,
      },
      metadata: {
        capturedAt: uploadItem.capturedAt,
        location: uploadItem.location,
        deviceId: uploadItem.deviceId,
      },
      description: notes,
    });

    return {
      ...uploadItem,
      authenticityReport: videoReport,
    };
  }));

  const reconstruction = buildTimeline(enrichedUploads);
  return {
    id: `incident-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    createdAt: new Date().toISOString(),
    title,
    status: req.user.role === 'admin' ? 'under_review' : 'submitted',
    reportedBy: req.user.username,
    reporterRole: req.user.role,
    reporterEmail: req.user.email || null,
    locationHint,
    observerId,
    notes,
    uploads: enrichedUploads,
    timeline: reconstruction.timeline,
    observerSummary: reconstruction.observerSummary,
    anomalies: reconstruction.anomalies,
    reconstructionSummary: {
      ...reconstruction.reconstructionSummary,
      alignmentMethod: reconstruction.reconstructionSummary.alignmentMethod.includes('video')
        ? reconstruction.reconstructionSummary.alignmentMethod
        : `${reconstruction.reconstructionSummary.alignmentMethod} + sampled video authenticity review`,
    },
    verifiedTruth: reconstruction.timeline.filter(item => item.verified),
  };
}

router.post('/', requireAuth, requireRole('admin', 'reporter'), upload.array('mediaFiles', MAX_MEDIA_FILES), async (req, res) => {
  try {
    const incident = await buildIncidentFromRequest(req);
    await saveIncident(incident);
    res.json(incident);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to create incident.' });
  }
});

router.post('/admin', requireAuth, requireRole('admin'), upload.array('mediaFiles', MAX_MEDIA_FILES), async (req, res) => {
  try {
    const incident = await buildIncidentFromRequest(req);
    const elevatedIncident = {
      ...incident,
      status: 'under_review',
    };
    await saveIncident(elevatedIncident);
    res.json(elevatedIncident);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to create incident.' });
  }
});

module.exports = router;
