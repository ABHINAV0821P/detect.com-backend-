const SearchRecord = require('../models/SearchRecord');

function sanitizeDocument(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete plain._id;
  return plain;
}

async function saveSearchRecord(record) {
  const entry = new SearchRecord(record);
  await entry.save();
  return sanitizeDocument(entry);
}

async function getSearchRecords(limit = 20) {
  const entries = await SearchRecord.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return entries.map(sanitizeDocument);
}

module.exports = {
  saveSearchRecord,
  getSearchRecords,
};
