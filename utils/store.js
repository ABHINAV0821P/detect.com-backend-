const Incident = require('../models/Incident');

function sanitizeDocument(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete plain._id;
  return plain;
}

async function saveIncident(record) {
  const incident = new Incident(record);
  await incident.save();
  return sanitizeDocument(incident);
}

async function getIncidents(limit = 20) {
  const incidents = await Incident.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return incidents.map(sanitizeDocument);
}

async function getIncidentsForUser(user, limit = 20) {
  if (!user) {
    return [];
  }

  if (user.role === 'admin' || user.role === 'verifier') {
    return getIncidents(limit);
  }

  const incidents = await Incident.find({ reportedBy: user.username })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return incidents.map(sanitizeDocument);
}

async function getIncidentById(id) {
  const incident = await Incident.findOne({ id }).lean();
  return sanitizeDocument(incident);
}

async function updateIncident(id, updater) {
  const currentDoc = await Incident.findOne({ id });
  if (!currentDoc) {
    return null;
  }

  const current = sanitizeDocument(currentDoc);
  const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };

  Object.keys(currentDoc.toObject()).forEach(key => {
    if (key === '_id') return;
    if (!(key in next)) {
      currentDoc.set(key, undefined);
    }
  });

  Object.entries(next).forEach(([key, value]) => {
    if (key === '_id') return;
    currentDoc.set(key, value);
  });

  await currentDoc.save();
  return sanitizeDocument(currentDoc);
}

module.exports = { saveIncident, getIncidents, getIncidentsForUser, getIncidentById, updateIncident };
