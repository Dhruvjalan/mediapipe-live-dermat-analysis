export class DermatologyEngine {
  // 1. Luminance Variance
  static getLuminanceVariance(roiMat: any): number {
    let gray = new cv.Mat();
    // RGBA to GRAY is natively supported
    cv.cvtColor(roiMat, gray, 11); // 11 = cv.COLOR_RGBA2GRAY

    let mean = new cv.Mat(),
      stddev = new cv.Mat();
    cv.meanStdDev(gray, mean, stddev);
    let variance = stddev.data64F[0] * stddev.data64F[0];

    gray.delete();
    mean.delete();
    stddev.delete();
    return variance;
  }

  // 2. Erythema Index (a* mean)
  static getErythemaIndex(roiMat: any): number {
    // Step 1: RGBA to RGB (Strip Alpha)
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    // Step 2: RGB to Lab
    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, 45); // 45 = cv.COLOR_RGB2Lab

    let channels = new cv.MatVector();
    cv.split(lab, channels);
    let aChannel = channels.get(1); // 'a' channel is index 1

    let mean = new cv.Mat(),
      stddev = new cv.Mat();
    cv.meanStdDev(aChannel, mean, stddev);
    let res = mean.data64F[0];

    // Cleanup all created matrices including the intermediate rgb
    rgb.delete();
    lab.delete();
    channels.delete();
    aChannel.delete();
    mean.delete();
    stddev.delete();
    return res;
  }

  // 3. Specular Glare (Oily Skin)
  static getSpecularGlare(roiMat: any): number {
    // Step 1: RGBA to RGB
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    // Step 2: RGB to HSV
    let hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, 41); // 41 = cv.COLOR_RGB2HSV

    let channels = new cv.MatVector();
    cv.split(hsv, channels);
    let v = channels.get(2),
      s = channels.get(1);

    let vMask = new cv.Mat(),
      sMask = new cv.Mat(),
      glareMask = new cv.Mat();
    cv.threshold(v, vMask, 220, 255, cv.THRESH_BINARY);
    cv.threshold(s, sMask, 40, 255, cv.THRESH_BINARY_INV);
    cv.bitwise_and(vMask, sMask, glareMask);

    let glarePct = (cv.countNonZero(glareMask) / (roiMat.rows * roiMat.cols)) * 100.0;

    // Cleanup
    rgb.delete();
    hsv.delete();
    channels.delete();
    v.delete();
    s.delete();
    glareMask.delete();
    vMask.delete();
    sMask.delete();
    return glarePct;
  }

  // 4. Image Sharpness (Laplacian variance)
  static getImageSharpness(roiMat: any): number {
    let gray = new cv.Mat();
    cv.cvtColor(roiMat, gray, 11); // 11 = cv.COLOR_RGBA2GRAY

    let lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F);

    let mean = new cv.Mat(),
      stddev = new cv.Mat();
    cv.meanStdDev(lap, mean, stddev);
    let sharpness = stddev.data64F[0] * stddev.data64F[0];

    gray.delete();
    lap.delete();
    mean.delete();
    stddev.delete();
    return sharpness;
  }

  // 5. Chrominance Variance (Cb & Cr Variance)
  static getChrominanceVariance(roiMat: any): any {
    // Step 1: RGBA to RGB
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    // Step 2: RGB to YCrCb
    let ycbcr = new cv.Mat();
    cv.cvtColor(rgb, ycbcr, 37); // 37 = cv.COLOR_RGB2YCrCb

    let channels = new cv.MatVector();
    cv.split(ycbcr, channels);
    let cb = channels.get(1),
      cr = channels.get(2);
    let mean = new cv.Mat(),
      stddev = new cv.Mat();

    cv.meanStdDev(cb, mean, stddev);
    let cbVar = stddev.data64F[0] ** 2;

    cv.meanStdDev(cr, mean, stddev);
    let crVar = stddev.data64F[0] ** 2;

    // Cleanup
    rgb.delete();
    ycbcr.delete();
    channels.delete();
    cb.delete();
    cr.delete();
    mean.delete();
    stddev.delete();
    return { Cb_variance: cbVar, Cr_variance: crVar };
  }

  // 6. Black Hat Pore Density
  static getBlackHatPoreDensity(roiMat: any): number {
    let gray = new cv.Mat();
    cv.cvtColor(roiMat, gray, 11); // 11 = cv.COLOR_RGBA2GRAY

    let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    let bh = new cv.Mat();
    cv.morphologyEx(gray, bh, cv.MORPH_BLACKHAT, kernel);
    cv.threshold(bh, bh, 15, 255, cv.THRESH_BINARY);

    let density = (cv.countNonZero(bh) / (bh.rows * bh.cols)) * 100.0;

    gray.delete();
    kernel.delete();
    bh.delete();
    return density;
  }

  // 7. Gray World White Balance
  static grayWorldWhiteBalance(roiMat: any): any {
    let result = new cv.Mat();
    roiMat.convertTo(result, cv.CV_32F);
    let channels = new cv.MatVector();
    cv.split(result, channels);

    for (let i = 0; i < 3; i++) {
      let channel = channels.get(i);
      let meanVal = cv.mean(channel)[0];
      if (meanVal > 0) {
        channel.convertTo(channel, -1, 128.0 / meanVal);
      }
    }
    cv.merge(channels, result);
    result.convertTo(result, cv.CV_8U);

    channels.delete();
    return result;
  }

  // 8. CLAHE Enhancement (Two-step conversions to avoid -206 Bad Flag error)
  static claheEnhance(roiMat: any): any {
    if (!roiMat || roiMat.empty()) return roiMat;

    // Step 1: RGBA to RGB
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    // Step 2: RGB to Lab
    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, 45); // 45 = cv.COLOR_RGB2Lab

    let channels = new cv.MatVector();
    cv.split(lab, channels);

    let l = channels.get(0);
    let clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(l, l);

    cv.merge(channels, lab);

    // Step 3: Lab to RGB
    let outRgb = new cv.Mat();
    cv.cvtColor(lab, outRgb, 57); // 57 = cv.COLOR_Lab2RGB

    // Step 4: RGB to RGBA (To match the input structure format for pipelines)
    let finalRgba = new cv.Mat();
    cv.cvtColor(outRgb, finalRgba, 0); // 0 = cv.COLOR_RGB2RGBA

    // Cleanup all intermediate matrices
    rgb.delete();
    lab.delete();
    channels.delete();
    l.delete();
    clahe.delete();
    outRgb.delete();
    return finalRgba;
  }

  // 9. Face Quality Heuristic
  static faceQualityHeuristic(roiMat: any, sharpness: number, glarePct: number): any {
    let gray = new cv.Mat();
    cv.cvtColor(roiMat, gray, 11); // 11 = cv.COLOR_RGBA2GRAY
    let brightness = cv.mean(gray)[0];

    // Thresholds: sharpness > 50, brightness 60-220, glare < 15%
    const qualityOk = sharpness > 50 && brightness > 60 && brightness < 220 && glarePct < 15;

    gray.delete();
    return { brightness, sharpness, glarePct, quality_ok: qualityOk };
  }

  // ── ILLUMINATION ROBUSTNESS ─────────────────────────────────────────────────

  // A. Detect Lighting Condition across 3 flat face regions.
  // Returns: avgBrightness, uniformity (0-100), lightingType, sideDelta
  static detectLightingCondition(foreheadRoi: any, leftCheekRoi: any, rightCheekRoi: any): any {
    const getBrightness = (roi: any): number => {
      let gray = new cv.Mat();
      cv.cvtColor(roi, gray, 11); // COLOR_RGBA2GRAY
      let b = cv.mean(gray)[0];
      gray.delete();
      return b;
    };

    const fhBright = getBrightness(foreheadRoi);
    const lcBright = getBrightness(leftCheekRoi);
    const rcBright = getBrightness(rightCheekRoi);

    const avgBrightness = (fhBright + lcBright + rcBright) / 3;
    const maxDiff = Math.max(fhBright, lcBright, rcBright) - Math.min(fhBright, lcBright, rcBright);
    // Uniformity: 0 difference = 100, 80+ difference = 0
    const uniformity = Math.max(0, 100 - (maxDiff / 80) * 100);
    const sideDelta = Math.abs(lcBright - rcBright);

    let lightingType = 'Even';
    if (avgBrightness > 210) lightingType = 'Overexposed';
    else if (avgBrightness < 50) lightingType = 'Dark';
    else if (sideDelta > 40) lightingType = 'Side-lit';
    else if (uniformity < 50) lightingType = 'Uneven';

    return { avgBrightness, uniformity, lightingType, sideDelta };
  }

  // B. Single Scale Retinex — separates skin reflectance from ambient illumination.
  // Works per-ROI so half-lit faces are handled independently.
  static normalizeIllumination(roiMat: any): any {
    if (!roiMat || roiMat.empty()) return roiMat.clone();

    let float32 = new cv.Mat();
    roiMat.convertTo(float32, cv.CV_32F, 1.0 / 255.0);

    let channels = new cv.MatVector();
    cv.split(float32, channels);

    const numChannels = Math.min(3, channels.size());
    let illumMats: any[] = [];

    for (let i = 0; i < numChannels; i++) {
      let ch = channels.get(i);
      // Add epsilon to avoid log(0)
      ch.convertTo(ch, -1, 1.0, 1e-4);
      cv.log(ch, ch); // ln(I + eps)

      // Estimate illumination via a large Gaussian blur (the "surround" in retinex)
      let illum = new cv.Mat();
      cv.GaussianBlur(ch, illum, new cv.Size(31, 31), 15, 15, cv.BORDER_REPLICATE);

      // Reflectance = log(I) - log(Illumination)
      cv.subtract(ch, illum, ch);
      illumMats.push(illum);
    }

    cv.merge(channels, float32);
    // Normalize reflectance values back to 0-255 range
    cv.normalize(float32, float32, 0, 255, cv.NORM_MINMAX);
    let result = new cv.Mat();
    float32.convertTo(result, cv.CV_8U);

    float32.delete();
    channels.delete();
    illumMats.forEach((m) => m.delete());
    return result;
  }

  // 10. Melanin Index
  // 4. Melanin Index (Logarithmic Scale)
  static getMelaninIndex(roiMat: any): number {
    // Step 1: RGBA to RGB
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    // Scale pixel values to 0.0 - 1.0 floats
    rgb.convertTo(rgb, cv.CV_32F, 1.0 / 255.0);

    let channels = new cv.MatVector();
    cv.split(rgb, channels);
    let r = channels.get(0);

    // Step 2: r = r + 1e-6
    // .convertTo(dest, type, alpha, beta) effectively does: dest = src * alpha + beta
    r.convertTo(r, -1, 1.0, 1e-6);

    // Step 3: r = 1.0 / r
    // We must create a matrix of 1.0s to divide against, because cv.divide requires Mat objects.
    let ones = new cv.Mat(r.rows, r.cols, r.type(), new cv.Scalar(1.0));
    cv.divide(ones, r, r);

    // Step 4: Natural Log -> ln(r)
    cv.log(r, r);

    // Step 5: Convert ln(x) to 100 * log10(x)
    // We use convertTo again to multiply the entire matrix by the scalar (100 / ln(10))
    const scaleFactor = 100.0 / Math.log(10);
    r.convertTo(r, -1, scaleFactor, 0.0);

    // Calculate final mean
    let mean = cv.mean(r)[0];

    // Cleanup
    rgb.delete();
    channels.delete();
    r.delete();
    ones.delete();

    return mean;
  }

  // 11. Yellowness Index (Scleral Icterus / Jaundice)
  static getYellownessIndex(roiMat: any): number {
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, 45); // 45 = cv.COLOR_RGB2Lab

    let channels = new cv.MatVector();
    cv.split(lab, channels);
    // The b* array isolates yellowness
    let bChannel = channels.get(2);

    let mean = new cv.Mat(),
      stddev = new cv.Mat();
    cv.meanStdDev(bChannel, mean, stddev);
    let res = mean.data64F[0];

    rgb.delete();
    lab.delete();
    channels.delete();
    bChannel.delete();
    mean.delete();
    stddev.delete();
    return res;
  }

  // 12. Hemoglobin Index (Green Channel / rPPG frame extraction)
  // Extracts the specific channel matrix needed for the 5-second FFT processing later.
  static getHemoglobinIndex(roiMat: any): number {
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // 1 = cv.COLOR_RGBA2RGB

    let channels = new cv.MatVector();
    cv.split(rgb, channels);
    // Green channel is highly correlated with Hemoglobin absorption and rPPG waves
    let gChannel = channels.get(1);

    let mean = new cv.Mat(),
      stddev = new cv.Mat();
    cv.meanStdDev(gChannel, mean, stddev);
    let res = mean.data64F[0];

    rgb.delete();
    channels.delete();
    gChannel.delete();
    mean.delete();
    stddev.delete();
    return res;
  }

  // 13. Eye Aspect Ratio (Fatigue / Drooping Eyes)
  // Note: Pass the isolated 6 MediaPipe landmark coordinates for the specific eye to this function.
  static getEyeAspectRatio(eyeLandmarks: any[]): number {
    if (!eyeLandmarks || eyeLandmarks.length < 6) return 0;

    // Euclidean distance helper function
    const dist = (p1: any, p2: any) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

    // Calculate the distances between the two vertical eye landmarks
    const v1 = dist(eyeLandmarks[1], eyeLandmarks[5]);
    const v2 = dist(eyeLandmarks[2], eyeLandmarks[4]);

    // Calculate the distance between the horizontal eye landmarks
    const h = dist(eyeLandmarks[0], eyeLandmarks[3]);

    if (h === 0) return 0;

    // Calculate and return the Eye Aspect Ratio
    return (v1 + v2) / (2.0 * h);
  }

  // 14. Heart Rate Estimation (Base Heuristic Model)
  // Placeholder for future fine-tuned LSTM / 1D-CNN model weights.
  static estimateHeartRate(signal: number[], times: number[]): number {
    if (signal.length < 30) return 0; // Need minimum frames to analyze

    // Step 1: Smoothing (5-point moving average to filter noise)
    let smoothed: number[] = [];
    for (let i = 2; i < signal.length - 2; i++) {
      smoothed.push((signal[i - 2] + signal[i - 1] + signal[i] + signal[i + 1] + signal[i + 2]) / 5.0);
    }
    let smoothTimes = times.slice(2, times.length - 2);

    // Step 2: Mean Centering (Remove DC offset / static lighting)
    let sum = smoothed.reduce((a, b) => a + b, 0);
    let mean = sum / smoothed.length;
    let centered = smoothed.map((v) => v - mean);

    // Step 3: Peak Detection (Find the systole pulses)
    let peaks: number[] = [];
    for (let i = 1; i < centered.length - 1; i++) {
      // Find local maxima above the mean
      if (centered[i] > centered[i - 1] && centered[i] > centered[i + 1] && centered[i] > 0) {
        peaks.push(smoothTimes[i]);
      }
    }

    // Step 4: Calculate Beats Per Minute (BPM)
    if (peaks.length < 2) return 0;
    let intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i - 1]); // Interval in milliseconds
    }

    let avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    let bpm = 60000 / avgInterval;

    // Clamp to realistic human resting/active range (40 - 180 BPM)
    if (bpm < 40 || bpm > 180) return 0;
    return bpm;
  }

  // 15. Wrinkle Score (Canny Edge Density)
  static getWrinkleScore(roiMat: any): number {
    let gray = new cv.Mat();
    cv.cvtColor(roiMat, gray, 11); // cv.COLOR_RGBA2GRAY

    // Smooth to reduce noise (pores)
    let blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    let edges = new cv.Mat();
    // Canny thresholds: 50, 150
    cv.Canny(blurred, edges, 50, 150);

    let edgeDensity = (cv.countNonZero(edges) / (edges.rows * edges.cols)) * 100.0;

    gray.delete();
    blurred.delete();
    edges.delete();
    return edgeDensity;
  }

  // 16. Dark Circle Score (Under-eye Luminance vs Cheek Luminance)
  static getDarkCircleScore(underEyeRoi: any, cheekRoi: any): number {
    let eyeGray = new cv.Mat();
    cv.cvtColor(underEyeRoi, eyeGray, 11);
    let eyeLum = cv.mean(eyeGray)[0];

    let cheekGray = new cv.Mat();
    cv.cvtColor(cheekRoi, cheekGray, 11);
    let cheekLum = cv.mean(cheekGray)[0];

    eyeGray.delete();
    cheekGray.delete();

    // Score based on how much darker the under-eye is compared to the cheek
    let diff = cheekLum - eyeLum;
    if (diff < 0) diff = 0; // If eye is brighter, no dark circles

    // Map max diff of 100 to a score of 100
    let score = (diff / 100.0) * 100.0;
    return Math.min(Math.max(score, 0), 100);
  }

  // 17. Texture Score (0-100, where 100 is perfectly smooth)
  static getTextureScore(roiMat: any): number {
    // Instead of raw sharpness which depends on webcam resolution,
    // use Pore Density (which is morphological) to estimate texture.
    let poreDensity = this.getBlackHatPoreDensity(roiMat);
    // Pore density usually ranges from 1% to 10%
    let score = 100 - poreDensity * 8;
    return Math.min(Math.max(score, 0), 100);
  }

  // 18. Hydration Score (Pseudo-heuristic combining glow and smoothness)
  static getHydrationScore(luminance: number, textureScore: number): number {
    // Map luminance to a 0-100 glow score. Average luminance variance is ~1000.
    let glow = Math.min((luminance / 1500) * 100, 100);

    // Combine 50% glow and 50% smoothness
    return glow * 0.5 + textureScore * 0.5;
  }

  // 19. Overall Skin Health Score
  static getOverallSkinHealth(metrics: any): number {
    let score = 100;

    // Penalties (Removed Melanin, as base pigmentation is not a health defect)
    if (metrics.erythema > 130) score -= (metrics.erythema - 130) * 0.8;
    if (metrics.yellowness > 130) score -= (metrics.yellowness - 130) * 0.8;

    score -= metrics.poreDensity * 2.5;
    score -= metrics.wrinkles * 2.0;

    if (metrics.darkCircles > 5) score -= (metrics.darkCircles - 5) * 0.5;
    if (metrics.acne > 10) score -= (metrics.acne - 10) * 0.3; // Acne penalty
    if (metrics.uvDamage > 20) score -= (metrics.uvDamage - 20) * 0.2; // Sun damage penalty

    // Ensure score doesn't drop below 0 before applying bonuses
    score = Math.max(score, 0);

    // Hydration acts as a strong scaler for overall health
    score = score * 0.6 + (metrics.hydration || 50) * 0.4;

    return Math.min(Math.max(score, 0), 100);
  }

  // 20. Image Quality Score
  static getImageQualityScore(quality: any): number {
    let score = 100;

    // Brightness 60-220 is good
    if (quality.brightness < 60) score -= 60 - quality.brightness;
    if (quality.brightness > 220) score -= quality.brightness - 220;

    // Sharpness > 50 is good
    if (quality.sharpness < 50) score -= 50 - quality.sharpness;

    // Glare < 15 is good
    if (quality.glarePct > 15) score -= (quality.glarePct - 15) * 2;

    return Math.min(Math.max(score, 0), 100);
  }

  // 21. Acne Severity (Blob detection on Erythema)
  static getAcneSeverity(roiMat: any): number {
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // COLOR_RGBA2RGB

    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, 45); // COLOR_RGB2Lab

    let channels = new cv.MatVector();
    cv.split(lab, channels);
    let aChannel = channels.get(1); // Erythema channel

    // Threshold the a-channel to find highly inflamed spots
    let redMask = new cv.Mat();
    cv.threshold(aChannel, redMask, 145, 255, cv.THRESH_BINARY);

    // Filter out tiny noise (like pores) using morphological opening
    let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    let opened = new cv.Mat();
    cv.morphologyEx(redMask, opened, cv.MORPH_OPEN, kernel);

    let acnePixels = cv.countNonZero(opened);
    let totalPixels = opened.rows * opened.cols;
    let acneDensity = (acnePixels / totalPixels) * 100.0;

    // Scale density so 0-5% maps to a 0-100 severity score
    let severity = Math.min((acneDensity / 5.0) * 100.0, 100.0);

    rgb.delete();
    lab.delete();
    channels.delete();
    aChannel.delete();
    redMask.delete();
    kernel.delete();
    opened.delete();

    return severity;
  }

  // 22. UV Damage Score (Melanin Variance + Wrinkles)
  static getUVDamageScore(roiMat: any, wrinkleScore: number): number {
    let rgb = new cv.Mat();
    cv.cvtColor(roiMat, rgb, 1); // COLOR_RGBA2RGB

    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, 45); // COLOR_RGB2Lab

    let channels = new cv.MatVector();
    cv.split(lab, channels);
    let lChannel = channels.get(0); // Luminance

    let mean = new cv.Mat();
    let stddev = new cv.Mat();
    cv.meanStdDev(lChannel, mean, stddev);
    let luminanceVariance = stddev.data64F[0];

    let pigmentationUnevenness = Math.min((Math.max(luminanceVariance - 10, 0) / 20.0) * 100, 100);
    let uvScore = pigmentationUnevenness * 0.7 + Math.min(wrinkleScore * 20, 100) * 0.3;

    rgb.delete();
    lab.delete();
    channels.delete();
    lChannel.delete();
    mean.delete();
    stddev.delete();

    return Math.min(Math.max(uvScore, 0), 100);
  }

  // 23. Elasticity Score (Firmness)
  static getElasticityScore(textureScore: number, wrinkleScore: number, fatigueEAR: number): number {
    let elasticity = textureScore;
    let wrinklePenalty = Math.min(wrinkleScore * 10, 40);
    elasticity -= wrinklePenalty;

    // Penalty for drooping eyes (sagging skin)
    if (fatigueEAR < 0.25) {
      elasticity -= (0.25 - fatigueEAR) * 100;
    }

    return Math.min(Math.max(elasticity, 0), 100);
  }
}
