const express = require('express');
const multer = require('multer');
const { getIncidentsForUser, getIncidentById, updateIncident } = require('../utils/store');
const { getSearchRecords, saveSearchRecord } = require('../utils/searchRecords');
const { buildIntelligenceReport, buildPhotoAuthenticityReport, buildQuestionVerificationReport } = require('../utils/intelligence');
const { requireAuth, requireRole } = require('../utils/auth');
const { normalizeString, parseJsonField, isAllowedImageMimeType } = require('../utils/validation');

const router = express.Router();
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter(req, file, callback) {
    if (!isAllowedImageMimeType(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }

    return callback(null, true);
  },
});

router.use(requireAuth);

router.get('/', async (req, res) => {
  const requestedLimit = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 20;
  const incidents = await getIncidentsForUser(req.user, limit);
  res.json({ incidents });
});

router.get('/search-records', async (req, res) => {
  const requestedLimit = Number.parseInt(String(req.query.limit || '30'), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 30;
  const records = await getSearchRecords(limit);
  res.json({ records });
});

router.get('/:id', async (req, res) => {
  const incident = await getIncidentById(req.params.id);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found' });
  }
  if (req.user.role === 'reporter' && incident.reportedBy !== req.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ incident });
});

router.post('/:id/intelligence-search', requireRole('admin'), async (req, res) => {
  const incident = await getIncidentById(req.params.id);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  const description = normalizeString(req.body.description, { maxLength: 2000, allowEmpty: true });
  if (!description && !incident.notes) {
    return res.status(400).json({ error: 'Add a text description or incident notes before running intelligence search.' });
  }

  try {
    const report = await buildIntelligenceReport(incident, description);
    const updatedIncident = await updateIncident(req.params.id, current => ({
      ...current,
      intelligenceReports: [report, ...(current.intelligenceReports || [])].slice(0, 10),
      latestIntelligenceReport: report,
    }));
    const savedSearchRecord = await saveSearchRecord({
      id: `search-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      createdAt: new Date().toISOString(),
      type: 'incident_intelligence',
      createdBy: req.user.username,
      incidentId: req.params.id,
      query: description || incident.notes || '',
      description,
      providerStatus: report.providerStatus,
      provider: report.analysis?.headline ? 'incident-intelligence' : 'unknown',
      summary: report.summary,
      analysis: report.analysis,
      sources: report.results || [],
      warnings: report.warnings || [],
    });

    res.json({
      incident: updatedIncident,
      report,
      savedSearchRecord,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to build intelligence search report.',
    });
  }
});

router.post('/:id/verification', requireRole('admin', 'verifier'), async (req, res) => {
  const incident = await getIncidentById(req.params.id);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  const decision = normalizeString(req.body.decision, { maxLength: 40, allowEmpty: true });
  const notes = normalizeString(req.body.notes, { maxLength: 2000, allowEmpty: true });
  const allowed = ['real', 'fake', 'needs_review'];

  if (!allowed.includes(decision)) {
    return res.status(400).json({ error: 'Decision must be real, fake, or needs_review.' });
  }

  const review = {
    reviewer: req.user.username,
    role: req.user.role,
    decision,
    notes,
    createdAt: new Date().toISOString(),
  };

  const updatedIncident = await updateIncident(req.params.id, current => ({
    ...current,
    verificationReviews: [review, ...(current.verificationReviews || [])],
    latestVerification: review,
  }));

  res.json({ incident: updatedIncident, review });
});

router.post('/photo-check', requireRole('admin', 'verifier'), photoUpload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Upload a photo to run authenticity verification.' });
  }

  let metadata = {};
  try {
    metadata = parseJsonField(req.body.metadata, {});
  } catch {
    return res.status(400).json({ error: 'Photo metadata must be valid JSON.' });
  }

  const description = normalizeString(req.body.description, { maxLength: 2000, allowEmpty: true });

  try {
    const report = await buildPhotoAuthenticityReport({
      file: req.file,
      buffer: req.file.buffer,
      metadata,
      description,
    });
    const responseReport = {
      ...report,
      filename: req.file.originalname,
      checkedAt: new Date().toISOString(),
    };
    const savedSearchRecord = await saveSearchRecord({
      id: `search-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      createdAt: responseReport.checkedAt,
      type: 'photo_check',
      createdBy: req.user.username,
      filename: req.file.originalname,
      description,
      verdict: responseReport.verdict,
      confidence: responseReport.confidence,
      fakeProbability: responseReport.fakeProbability,
      provider: responseReport.provider,
      summary: responseReport.summary,
      reasons: responseReport.reasons || [],
      detectedArtifacts: responseReport.detectedArtifacts || [],
      forensicSignals: responseReport.forensicSignals || null,
      advancedForensics: responseReport.advancedForensics || null,
      sources: responseReport.sources || [],
      warnings: [],
    });

    res.json({
      report: responseReport,
      savedSearchRecord,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to analyze the photo authenticity.',
    });
  }
});

router.post('/question-check', requireRole('admin', 'verifier'), async (req, res) => {
  const question = normalizeString(req.body.question, { maxLength: 2000, allowEmpty: true });
  if (!question) {
    return res.status(400).json({ error: 'Enter a question or claim to verify.' });
  }

  try {
    const report = await buildQuestionVerificationReport(question);
    const responseReport = {
      ...report,
      question,
      checkedAt: new Date().toISOString(),
    };
    const savedSearchRecord = await saveSearchRecord({
      id: `search-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      createdAt: responseReport.checkedAt,
      type: 'question_check',
      createdBy: req.user.username,
      query: question,
      verdict: responseReport.verdict,
      confidence: responseReport.confidence,
      fakeProbability: responseReport.fakeProbability,
      provider: responseReport.provider,
      providerStatus: responseReport.providerStatus,
      summary: responseReport.summary,
      answer: responseReport.answer,
      rationale: responseReport.rationale,
      reasons: responseReport.reasons || [],
      sources: responseReport.sources || [],
      warnings: responseReport.warnings || [],
    });
    res.json({
      report: responseReport,
      savedSearchRecord,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to verify the question.',
    });
  }
});

module.exports = router;
