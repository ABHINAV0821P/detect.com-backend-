import json
import math
import os
import sys
import tempfile

from PIL import Image, ImageChops, ImageFilter, ImageStat


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def mean_abs_difference(image_a, image_b):
    diff = ImageChops.difference(image_a, image_b)
    stat = ImageStat.Stat(diff)
    channel_means = stat.mean or [0]
    return sum(channel_means) / max(len(channel_means), 1)


def compute_entropy(image):
    histogram = image.histogram()
    total = float(sum(histogram) or 1)
    entropy = 0.0
    for count in histogram:
      if count:
        probability = count / total
        entropy -= probability * math.log(probability, 2)
    return entropy


def compute_edge_density(image):
    edge_image = image.convert("L").filter(ImageFilter.FIND_EDGES)
    histogram = edge_image.histogram()
    total_pixels = float(sum(histogram) or 1)
    strong_edges = sum(histogram[28:])
    return strong_edges / total_pixels


def compute_blockiness(image):
    grayscale = image.convert("L")
    width, height = grayscale.size
    pixels = grayscale.load()
    row_diffs = []
    col_diffs = []

    for x in range(8, width, 8):
        total = 0
        count = 0
        for y in range(height):
            total += abs(pixels[x, y] - pixels[x - 1, y])
            count += 1
        if count:
            col_diffs.append(total / count)

    for y in range(8, height, 8):
        total = 0
        count = 0
        for x in range(width):
            total += abs(pixels[x, y] - pixels[x, y - 1])
            count += 1
        if count:
            row_diffs.append(total / count)

    values = row_diffs + col_diffs
    return sum(values) / max(len(values), 1) if values else 0.0


def compute_noise_delta(image):
    grayscale = image.convert("L")
    median = grayscale.filter(ImageFilter.MedianFilter(size=3))
    return mean_abs_difference(grayscale, median)


def compute_sharpness_variance(image):
    grayscale = image.convert("L")
    laplace_like = grayscale.filter(ImageFilter.Kernel(
        (3, 3),
        (-1, -1, -1,
         -1, 8, -1,
         -1, -1, -1),
        scale=1,
    ))
    stat = ImageStat.Stat(laplace_like)
    return stat.var[0] if stat.var else 0.0


def compute_luma_clipping(image):
    grayscale = image.convert("L")
    histogram = grayscale.histogram()
    total = float(sum(histogram) or 1)
    dark = sum(histogram[:8])
    bright = sum(histogram[248:])
    return (dark + bright) / total


def compute_channel_misalignment(image):
    rgb = image.convert("RGB")
    red, green, blue = rgb.split()
    return (
        mean_abs_difference(red, green)
        + mean_abs_difference(green, blue)
        + mean_abs_difference(red, blue)
    ) / 3.0


def compute_tile_noise_variation(image):
    grayscale = image.convert("L")
    width, height = grayscale.size
    tile_size = 64
    tile_scores = []

    for left in range(0, width, tile_size):
        for top in range(0, height, tile_size):
            tile = grayscale.crop((left, top, min(left + tile_size, width), min(top + tile_size, height)))
            if tile.size[0] < 16 or tile.size[1] < 16:
                continue
            tile_scores.append(compute_noise_delta(tile))

    if len(tile_scores) < 2:
        return 0.0

    mean_value = sum(tile_scores) / len(tile_scores)
    variance = sum((score - mean_value) ** 2 for score in tile_scores) / len(tile_scores)
    return math.sqrt(variance)


def compute_ela_metrics(image):
    rgb = image.convert("RGB")
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp_file:
        temp_path = temp_file.name

    try:
        rgb.save(temp_path, "JPEG", quality=90)
        recompressed = Image.open(temp_path).convert("RGB")
        diff = ImageChops.difference(rgb, recompressed)
        stat = ImageStat.Stat(diff)
        return {
            "ela_mean": sum(stat.mean or [0]) / max(len(stat.mean or [0]), 1),
            "ela_max": max(stat.extrema[i][1] for i in range(len(stat.extrema or []))) if stat.extrema else 0,
        }
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


def analyze_image(path):
    with Image.open(path) as image:
        image.load()
        width, height = image.size
        mode = image.mode
        format_name = (image.format or "").lower() or "unknown"
        has_alpha = "A" in mode
        entropy = compute_entropy(image.convert("RGB"))
        edge_density = compute_edge_density(image)
        blockiness = compute_blockiness(image)
        noise_delta = compute_noise_delta(image)
        sharpness_variance = compute_sharpness_variance(image)
        luma_clipping = compute_luma_clipping(image)
        channel_misalignment = compute_channel_misalignment(image)
        tile_noise_variation = compute_tile_noise_variation(image)
        ela = compute_ela_metrics(image)

    suspicion = 0.12
    reasons = []

    if ela["ela_mean"] >= 16:
        suspicion += 0.22
        reasons.append("High error-level difference suggests uneven recompression or localized editing.")
    elif ela["ela_mean"] >= 10:
        suspicion += 0.1
        reasons.append("Moderate error-level difference suggests possible resave or edited regions.")

    if ela["ela_max"] >= 90:
        suspicion += 0.08
        reasons.append("Extreme error spikes were found in the recompression analysis.")

    if edge_density <= 0.018:
        suspicion += 0.07
        reasons.append("Very low edge density can indicate oversmoothing or generated imagery.")
    elif edge_density >= 0.16:
        suspicion += 0.05
        reasons.append("Edge density is unusually high and may reflect sharpening or compositing artifacts.")

    if blockiness >= 18:
        suspicion += 0.08
        reasons.append("JPEG-style block boundary contrast is unusually strong.")
    elif blockiness >= 12:
        suspicion += 0.04
        reasons.append("Mild block boundary contrast is present.")

    if noise_delta <= 1.6:
        suspicion += 0.08
        reasons.append("Noise residual is very low, which can happen after synthetic generation or heavy smoothing.")
    elif noise_delta >= 8:
        suspicion += 0.04
        reasons.append("Noise residual is unusually strong and may indicate layered recompression.")

    if sharpness_variance <= 140:
        suspicion += 0.06
        reasons.append("Edge sharpness variance is unusually low, suggesting oversmoothing or synthetic rendering.")
    elif sharpness_variance >= 3200:
        suspicion += 0.04
        reasons.append("Edge sharpness variance is unusually strong, which can happen after aggressive sharpening.")

    if luma_clipping >= 0.18:
        suspicion += 0.05
        reasons.append("A large share of pixels are clipped into very dark or very bright values.")

    if channel_misalignment <= 6:
        suspicion += 0.04
        reasons.append("Color channel separation is unusually low, which can indicate heavily processed imagery.")

    if tile_noise_variation >= 2.6:
        suspicion += 0.08
        reasons.append("Noise levels vary sharply across image regions, which can suggest compositing.")
    elif tile_noise_variation <= 0.35:
        suspicion += 0.05
        reasons.append("Noise levels are unusually uniform across the frame, which can happen in generated imagery.")

    if entropy <= 5.2:
        suspicion += 0.06
        reasons.append("Image entropy is low for a natural scene photo.")

    if has_alpha:
        suspicion += 0.05
        reasons.append("Transparency is present, which is uncommon for untouched camera photos.")

    if width * height < 300000:
        suspicion += 0.05
        reasons.append("Resolution is low, limiting reliable provenance and artifact analysis.")

    return {
        "available": True,
        "suspicion": clamp(suspicion, 0.04, 0.98),
        "reasons": reasons,
        "metrics": {
            "format": format_name,
            "mode": mode,
            "width": width,
            "height": height,
            "has_alpha": has_alpha,
            "entropy": round(entropy, 3),
            "edge_density": round(edge_density, 4),
            "blockiness": round(blockiness, 3),
            "noise_delta": round(noise_delta, 3),
            "sharpness_variance": round(sharpness_variance, 3),
            "luma_clipping": round(luma_clipping, 4),
            "channel_misalignment": round(channel_misalignment, 3),
            "tile_noise_variation": round(tile_noise_variation, 3),
            "ela_mean": round(ela["ela_mean"], 3),
            "ela_max": round(float(ela["ela_max"]), 3),
        },
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"available": False, "error": "No image path provided"}))
        return

    try:
        report = analyze_image(sys.argv[1])
    except Exception as exc:
        report = {"available": False, "error": str(exc)}

    print(json.dumps(report))


if __name__ == "__main__":
    main()
