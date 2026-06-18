const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../utils/auth');
const { hasFfmpeg, hasFfprobe } = require('../utils/intelligence');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  res.json({
    database: {
      provider: 'mongodb',
      connected: mongoose.connection.readyState === 1,
      name: mongoose.connection.name || null,
    },
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      serpapi: Boolean(process.env.SERPAPI_KEY),
      newsapi: Boolean(process.env.NEWS_API_KEY),
      gnews: Boolean(process.env.GNEWS_API_KEY),
      rss: true,
      ffmpeg: await hasFfmpeg(),
      ffprobe: await hasFfprobe(),
    },
    storage: {
      uploads: 'local',
      incidents: 'mongodb',
    },
  });
});

module.exports = router;
