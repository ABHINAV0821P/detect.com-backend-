const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let ffmpegAvailabilityPromise;
let ffprobeAvailabilityPromise;

async function commandAvailable(command) {
  try {
    await execFileAsync(command, ['-version'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function hasFfmpeg() {
  if (!ffmpegAvailabilityPromise) {
    ffmpegAvailabilityPromise = commandAvailable('ffmpeg');
  }

  return ffmpegAvailabilityPromise;
}

function hasFfprobe() {
  if (!ffprobeAvailabilityPromise) {
    ffprobeAvailabilityPromise = commandAvailable('ffprobe');
  }

  return ffprobeAvailabilityPromise;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function parseFraction(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  if (!raw.includes('/')) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  const [numerator, denominator] = raw.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

async function inspectVideo(filepath) {
  if (!await hasFfprobe()) {
    return {
      available: false,
      durationSeconds: null,
      width: null,
      height: null,
      frameRate: null,
      codec: null,
    };
  }

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filepath,
    ], { timeout: 8000 });

    const parsed = JSON.parse(stdout || '{}');
    const stream = parsed.streams?.[0] || {};
    const format = parsed.format || {};
    const durationSeconds = Number(format.duration);

    return {
      available: true,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
      height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null,
      frameRate: clamp(parseFraction(stream.r_frame_rate), 0, 240),
      codec: stream.codec_name || null,
    };
  } catch {
    return {
      available: false,
      durationSeconds: null,
      width: null,
      height: null,
      frameRate: null,
      codec: null,
    };
  }
}

function getSampleTimes(durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0.8) {
    return [0];
  }

  const safeTail = Math.max(durationSeconds - 0.35, 0);
  const checkpoints = [0.12, 0.5, 0.88]
    .map(point => Number((durationSeconds * point).toFixed(2)))
    .map(point => Math.min(point, safeTail));

  return Array.from(new Set(checkpoints.filter(point => point >= 0)));
}

async function extractVideoFrames(filepath, { maxFrames = 3 } = {}) {
  if (!await hasFfmpeg()) {
    return {
      available: false,
      frames: [],
      video: await inspectVideo(filepath),
    };
  }

  const video = await inspectVideo(filepath);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-video-'));

  try {
    const sampleTimes = getSampleTimes(video.durationSeconds).slice(0, maxFrames);
    const frames = [];

    for (let index = 0; index < sampleTimes.length; index += 1) {
      const sampleTime = sampleTimes[index];
      const outputPath = path.join(outputDir, `frame-${index + 1}.jpg`);

      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', String(sampleTime),
        '-i', filepath,
        '-frames:v', '1',
        '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease',
        outputPath,
      ], { timeout: 15000 });

      const buffer = await fs.readFile(outputPath);
      frames.push({
        filename: path.basename(outputPath),
        sampleTime,
        mimeType: 'image/jpeg',
        buffer,
      });
    }

    return {
      available: true,
      frames,
      video,
    };
  } catch {
    return {
      available: false,
      frames: [],
      video,
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  hasFfmpeg,
  hasFfprobe,
  inspectVideo,
  extractVideoFrames,
};
