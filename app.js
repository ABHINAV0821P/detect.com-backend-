const express = require('express');
const cors = require('cors');
const { loadEnvFile, getArrayEnv } = require('./utils/env');
const { connectToDatabase, getDatabaseStatus } = require('./utils/db');
const authRoute = require('./routes/auth');
const statusRoute = require('./routes/status');
const newsRoute = require('./routes/news');
const uploadRoute = require('./routes/upload');
const incidentRoute = require('./routes/incident');
const usersRoute = require('./routes/users');

loadEnvFile();

const app = express();
const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://detect.deployhub.in'
  'http://detect-com-backend-ze9r.vercel.app/',
];
const allowedOrigins = getArrayEnv('CORS_ORIGIN', defaultAllowedOrigins);
const allowAllOrigins = allowedOrigins.length === 0;
let databaseReadyPromise = null;

function ensureDatabaseConnection() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = connectToDatabase().catch(error => {
      databaseReadyPromise = null;
      throw error;
    });
  }

  return databaseReadyPromise;
}

app.get('/api/health', (req, res) => {
  const database = getDatabaseStatus();
  const healthy = database.connected || !database.configured;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    database,
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    name: 'detect backend',
    status: 'ok',
    health: '/api/health',
  });
});

app.use(async (req, res, next) => {
  if (req.path === '/' || req.path === '/api/health') {
    return next();
  }

  try {
    await ensureDatabaseConnection();
    next();
  } catch (error) {
    console.error('Failed to connect to database:', error.message);
    res.status(503).json({ error: 'Database connection failed.', details: error.message });
  }
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/auth', authRoute);
app.use('/api/status', statusRoute);
app.use('/api/news', newsRoute);
app.use('/api/users', usersRoute);
app.use('/api/upload', uploadRoute);
app.use('/api/incidents', incidentRoute);

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload is too large.' });
  }

  if (error?.message === 'Origin is not allowed by CORS.') {
    return res.status(403).json({ error: 'Origin is not allowed.' });
  }

  if (error?.name === 'MulterError') {
    return res.status(400).json({ error: error.message });
  }

  if (error) {
    console.error('Unhandled server error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }

  return next();
});

module.exports = { app, ensureDatabaseConnection };
