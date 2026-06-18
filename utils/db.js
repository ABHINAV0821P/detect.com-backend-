const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const User = require('../models/User');
const userUtils = require('./users');
const { getOptionalEnv, getRequiredEnv } = require('./env');

let connectionPromise = null;
let lastConnectionError = null;

async function seedAdminUserIfAvailable() {
  if (typeof userUtils.ensureAdminUser !== 'function') {
    console.warn('Admin user seed skipped: utils/users.ensureAdminUser is not available.');
    return;
  }

  await userUtils.ensureAdminUser();
}

async function ensureModelIndexes() {
  try {
    await User.syncIndexes();
  } catch (error) {
    console.warn('User index sync skipped:', error.message);
  }
}

async function migrateLegacyIncidents() {
  const count = await Incident.countDocuments();
  if (count > 0) {
    return;
  }

  const legacyPath = path.join(__dirname, '..', 'data', 'incidents.json');

  try {
    const raw = await fs.readFile(legacyPath, 'utf8');
    const records = JSON.parse(raw);

    if (Array.isArray(records) && records.length > 0) {
      await Incident.insertMany(records, { ordered: false });
      console.log(`Migrated ${records.length} legacy incident record(s) into MongoDB.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Legacy incident migration skipped:', error.message);
    }
  }
}

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) {
    lastConnectionError = null;
    return mongoose.connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  const uri = getRequiredEnv('MONGODB_URI');

  connectionPromise = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  }).then(async instance => {
    await ensureModelIndexes();
    await migrateLegacyIncidents();
    await seedAdminUserIfAvailable();
    lastConnectionError = null;
    return instance.connection;
  }).catch(error => {
    lastConnectionError = error;
    throw error;
  });

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

function getDatabaseStatus() {
  return {
    configured: Boolean(getOptionalEnv('MONGODB_URI')),
    connected: mongoose.connection.readyState === 1,
    connecting: mongoose.connection.readyState === 2 || Boolean(connectionPromise),
    readyState: mongoose.connection.readyState,
    name: mongoose.connection.name || null,
    lastError: lastConnectionError ? lastConnectionError.message : null,
  };
}

module.exports = { connectToDatabase, getDatabaseStatus };
