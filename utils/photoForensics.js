const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'photo_forensics.py');

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

async function runPhotoForensics({ buffer, originalName = 'image' }) {
  const extension = path.extname(originalName || '') || '.bin';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-photo-'));
  const tempPath = path.join(tempDir, `probe${extension}`);

  try {
    await fs.writeFile(tempPath, buffer);
    const { stdout } = await execFileAsync('python3', [SCRIPT_PATH, tempPath], { timeout: 15000 });
    const parsed = JSON.parse(stdout || '{}');
    const metrics = parsed.metrics || {};

    return {
      available: Boolean(parsed.available),
      suspicion: clamp(Number(parsed.suspicion) || 0, 0.02, 0.98),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter(Boolean) : [],
      metrics: {
        format: metrics.format || null,
        mode: metrics.mode || null,
        width: Number.isFinite(Number(metrics.width)) ? Number(metrics.width) : null,
        height: Number.isFinite(Number(metrics.height)) ? Number(metrics.height) : null,
        hasAlpha: Boolean(metrics.has_alpha),
        entropy: Number.isFinite(Number(metrics.entropy)) ? Number(metrics.entropy) : null,
        edgeDensity: Number.isFinite(Number(metrics.edge_density)) ? Number(metrics.edge_density) : null,
        blockiness: Number.isFinite(Number(metrics.blockiness)) ? Number(metrics.blockiness) : null,
        noiseDelta: Number.isFinite(Number(metrics.noise_delta)) ? Number(metrics.noise_delta) : null,
        sharpnessVariance: Number.isFinite(Number(metrics.sharpness_variance)) ? Number(metrics.sharpness_variance) : null,
        lumaClipping: Number.isFinite(Number(metrics.luma_clipping)) ? Number(metrics.luma_clipping) : null,
        channelMisalignment: Number.isFinite(Number(metrics.channel_misalignment)) ? Number(metrics.channel_misalignment) : null,
        tileNoiseVariation: Number.isFinite(Number(metrics.tile_noise_variation)) ? Number(metrics.tile_noise_variation) : null,
        elaMean: Number.isFinite(Number(metrics.ela_mean)) ? Number(metrics.ela_mean) : null,
        elaMax: Number.isFinite(Number(metrics.ela_max)) ? Number(metrics.ela_max) : null,
      },
      error: parsed.error || null,
    };
  } catch (error) {
    return {
      available: false,
      suspicion: 0,
      reasons: [`Advanced photo forensics could not be completed: ${error.message}`],
      metrics: {},
      error: error.message,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runPhotoForensics };
