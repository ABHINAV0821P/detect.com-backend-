const mongoose = require('mongoose');

const AnomalyFlagSchema = new mongoose.Schema({
  code: String,
  severity: String,
  label: String,
  detail: String,
}, { _id: false });

const UploadSchema = new mongoose.Schema({
  originalName: String,
  storagePath: String,
  mimeType: String,
  size: Number,
  sha256: String,
  capturedAt: String,
  location: String,
  type: String,
  deviceId: String,
  verified: Boolean,
  temporalConfidence: Number,
  spatialConfidence: Number,
  alignmentScore: Number,
  confidence: Number,
  syntheticRisk: Number,
  anomalyFlags: [AnomalyFlagSchema],
  forensicStatus: String,
}, { _id: false, strict: false });

const ObserverSummarySchema = new mongoose.Schema({
  observerId: String,
  uploads: Number,
  mediaTypes: [String],
}, { _id: false });

const ReconstructionSummarySchema = new mongoose.Schema({
  observerCount: Number,
  evidenceCount: Number,
  verifiedCount: Number,
  flaggedCount: Number,
  averageAlignment: Number,
  averageSyntheticRisk: Number,
  firstObservedAt: String,
  lastObservedAt: String,
  alignmentMethod: String,
  recommendedNextStep: String,
}, { _id: false });

const VerificationReviewSchema = new mongoose.Schema({
  reviewer: String,
  role: String,
  decision: String,
  notes: String,
  createdAt: String,
}, { _id: false });

const IntelligenceAnalysisSchema = new mongoose.Schema({
  headline: String,
  summary: String,
  incidentType: String,
  locationHint: String,
  entities: [String],
  searchQueries: [String],
  corroborationQuestions: [String],
  confidence: Number,
  rationale: String,
}, { _id: false });

const IntelligenceResultSchema = new mongoose.Schema({
  provider: String,
  title: String,
  url: String,
  snippet: String,
  source: String,
  publishedAt: String,
  relevanceScore: Number,
}, { _id: false });

const IntelligenceReportSchema = new mongoose.Schema({
  id: String,
  createdAt: String,
  description: String,
  analysis: IntelligenceAnalysisSchema,
  results: [IntelligenceResultSchema],
  summary: String,
  providerStatus: {
    ai: String,
    search: String,
  },
  warnings: [String],
}, { _id: false });

const IncidentSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    createdAt: {
      type: String,
      required: true,
      index: true,
    },
    title: String,
    status: {
      type: String,
      default: 'submitted',
      index: true,
    },
    reportedBy: String,
    reporterRole: String,
    reporterEmail: String,
    locationHint: String,
    observerId: String,
    notes: String,
    uploads: [UploadSchema],
    timeline: [UploadSchema],
    observerSummary: [ObserverSummarySchema],
    anomalies: [{
      media: String,
      observerId: String,
      capturedAt: String,
      code: String,
      severity: String,
      label: String,
      detail: String,
    }],
    reconstructionSummary: ReconstructionSummarySchema,
    verifiedTruth: [UploadSchema],
    verificationReviews: [VerificationReviewSchema],
    latestVerification: VerificationReviewSchema,
    intelligenceReports: [IntelligenceReportSchema],
    latestIntelligenceReport: IntelligenceReportSchema,
  },
  {
    strict: true,
    versionKey: false,
    collection: 'incidents',
  }
);

IncidentSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Incident || mongoose.model('Incident', IncidentSchema);
