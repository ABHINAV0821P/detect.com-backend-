const express = require('express');
const { requireAuth } = require('../utils/auth');
const { getLiveNews } = require('../utils/news');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const requestedLimit = Number.parseInt(String(req.query.limit || '8'), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 8;

  try {
    const news = await getLiveNews(limit);
    res.json(news);
  } catch (error) {
    res.status(502).json({
      error: 'Unable to fetch live news right now.',
      items: [],
      warnings: [error.message],
      providerStatus: 'unavailable',
      feedCount: 0,
    });
  }
});

module.exports = router;
