const mongoose = require('mongoose');

const SearchSourceSchema = new mongoose.Schema({
  provider: String,
  title: String,
  url: String,
  snippet: String,
  source: String,
  publishedAt: String,
  relevanceScore: Number,
}, { _id: false });

const SearchRecordSchema = new mongoose.Schema(
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
    type: {
      type: String,
      required: true,
      index: true,
    },
    createdBy: String,
    incidentId: String,
    query: String,
    filename: String,
    description: String,
    verdict: String,
    confidence: Number,
    fakeProbability: Number,
    provider: String,
    providerStatus: {
      ai: String,
      search: String,
    },
    summary: String,
    answer: String,
    rationale: String,
    analysis: {
      headline: String,
      summary: String,
      incidentType: String,
      locationHint: String,
      entities: [String],
      searchQueries: [String],
      corroborationQuestions: [String],
      confidence: Number,
      rationale: String,
    },
    reasons: [String],
    detectedArtifacts: [String],
    forensicSignals: mongoose.Schema.Types.Mixed,
    advancedForensics: mongoose.Schema.Types.Mixed,
    sources: [SearchSourceSchema],
    warnings: [String],
  },
  {
    strict: true,
    versionKey: false,
    collection: 'searchRecords',
  }
);

SearchRecordSchema.index({ createdAt: -1 });
SearchRecordSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.models.SearchRecord || mongoose.model('SearchRecord', SearchRecordSchema);
