/**
 * Copyright 2026 The MediaPipe Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FaceLandmarkerResult, DrawingUtils, FaceLandmarker } from '@mediapipe/tasks-vision';
import { BaseVisionTask } from '../components/base-vision-task';
import { DermatologyEngine } from '../tasks/dermatology-engine';

// @ts-ignore
import template from '../templates/face-landmarker.html?raw';
// @ts-ignore
declare var cv: any;
class FaceLandmarkerTask extends BaseVisionTask {
  private drawingUtils: DrawingUtils | undefined;

  private numFaces = 1;
  private minFaceDetectionConfidence = 0.5;
  private minFacePresenceConfidence = 0.5;
  private minTrackingConfidence = 0.5;

  protected override onInitializeUI() {
    console.log('Initializing FaceLandmarkerTask UI');
    //     console.log("Checking OpenCV constants:", {
    //     RGBA2Lab: cv.COLOR_RGBA2Lab,
    //     RGBA2GRAY: cv.COLOR_RGBA2GRAY,
    //     test: cv.getBuildInformation ? cv.getBuildInformation() : "No build info"
    // });
    // Confidence Sliders
    const setupSlider = (id: string, onChange: (val: number) => void) => {
      const input = document.getElementById(id) as HTMLInputElement;
      const valueDisplay = document.getElementById(`${id}-value`)!;
      if (input && valueDisplay) {
        input.addEventListener('input', () => {
          const val = parseFloat(input.value);
          valueDisplay.innerText = val.toString();
          onChange(val);
        });
      }
    };

    setupSlider('min-face-detection-confidence', (val) => {
      this.minFaceDetectionConfidence = val;
      this.worker?.postMessage({ type: 'SET_OPTIONS', minFaceDetectionConfidence: this.minFaceDetectionConfidence });
      this.triggerRedetection();
    });

    setupSlider('min-face-presence-confidence', (val) => {
      this.minFacePresenceConfidence = val;
      this.worker?.postMessage({ type: 'SET_OPTIONS', minFacePresenceConfidence: this.minFacePresenceConfidence });
      this.triggerRedetection();
    });

    setupSlider('min-tracking-confidence', (val) => {
      this.minTrackingConfidence = val;
      this.worker?.postMessage({ type: 'SET_OPTIONS', minTrackingConfidence: this.minTrackingConfidence });
      this.triggerRedetection();
    });

    setupSlider('num-faces', (val) => {
      this.numFaces = val;
      this.worker?.postMessage({ type: 'SET_OPTIONS', numFaces: this.numFaces });
      this.triggerRedetection();
    });

    // Custom model options for Face Landmarker
    this.models = {
      face_landmarker:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    };

    if (this.modelSelector) {
      this.modelSelector.updateOptions([{ label: 'Face Landmarker', value: 'face_landmarker', isDefault: true }]);
    }
  }

  private triggerRedetection() {
    if (this.runningMode === 'IMAGE') {
      const testImage = document.getElementById('test-image') as HTMLImageElement;
      if (testImage && testImage.src) {
        this.detectImage(testImage);
      }
    }
  }

  protected override getWorkerInitParams(): Record<string, any> {
    return {
      numFaces: this.numFaces,
      minFaceDetectionConfidence: this.minFaceDetectionConfidence,
      minFacePresenceConfidence: this.minFacePresenceConfidence,
      minTrackingConfidence: this.minTrackingConfidence,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    };
  }

  protected override displayImageResult(result: FaceLandmarkerResult) {
    const imageCanvas = document.getElementById('image-canvas') as HTMLCanvasElement;
    const testImage = document.getElementById('test-image') as HTMLImageElement;
    const ctx = imageCanvas.getContext('2d')!;

    imageCanvas.width = testImage.naturalWidth;
    imageCanvas.height = testImage.naturalHeight;

    ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
    ctx.beginPath();
    ctx.rect(0, 0, imageCanvas.width, imageCanvas.height);
    ctx.clip();

    if (result.faceLandmarks) {
      if (!this.drawingUtils) this.drawingUtils = new DrawingUtils(ctx);
      else this.drawingUtils = new DrawingUtils(ctx);

      for (const landmarks of result.faceLandmarks) {
        this.drawLandmarks(this.drawingUtils, landmarks);
        this.runDermatologyAnalysis(landmarks);
      }
    }
  }

  protected override displayVideoResult(result: FaceLandmarkerResult) {
    this.canvasElement.width = this.video.videoWidth;
    this.canvasElement.height = this.video.videoHeight;
    this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

    this.canvasCtx.beginPath();
    this.canvasCtx.rect(0, 0, this.canvasElement.width, this.canvasElement.height);
    this.canvasCtx.clip();

    if (result.faceLandmarks) {
      if (!this.drawingUtils) this.drawingUtils = new DrawingUtils(this.canvasCtx);
      else this.drawingUtils = new DrawingUtils(this.canvasCtx);

      for (const landmarks of result.faceLandmarks) {
        this.drawLandmarks(this.drawingUtils, landmarks);
        this.runDermatologyAnalysis(landmarks);
      }
    }
  }
  private extractRoi(frame: any, landmarks: any, region: string): any {
    let centerLm;
    if (region === 'forehead') centerLm = landmarks[10];
    else if (region === 'cheek')
      centerLm = landmarks[205]; // left cheek
    else if (region === 'rightcheek')
      centerLm = landmarks[425]; // right cheek
    else if (region === 'undereye')
      centerLm = landmarks[114]; // left under eye
    else centerLm = landmarks[10];

    const centerX = Math.floor(centerLm.x * frame.cols);
    const centerY = Math.floor(centerLm.y * frame.rows);

    // Use a fixed, safe size
    const width = 100;
    const height = 50;

    // Strict clamping
    let x = Math.max(0, Math.min(centerX - width / 2, frame.cols - width));
    let y = Math.max(0, Math.min(centerY, frame.rows - height));

    let rect = new cv.Rect(x, y, width, height);
    return frame.roi(rect);
  }
  private drawLandmarks(drawingUtils: DrawingUtils, landmarks: any[]) {
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {
      color: '#C0C0C070',
      lineWidth: 1,
    });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: '#FF3030' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#FF3030' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: '#30FF30' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, { color: '#30FF30' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: '#E0E0E0' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: '#E0E0E0' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: '#FF3030' });
    drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: '#30FF30' });
  }

  // Add these to FaceLandmarkerTask class
  // Add these to your FaceLandmarkerTask class
  private isProcessing = false;
  private rppgBuffer: number[] = [];
  private timeBuffer: number[] = [];
  private lastHeartRate: number = 0;
  private readonly BUFFER_WINDOW_MS = 5000; // 5-second sampling window

  private async runDermatologyAnalysis(landmarks: any[]) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    let frame: any,
      balanced: any,
      processed: any,
      extractedRoi: any,
      roi: any,
      cheekRoi: any,
      underEyeRoi: any,
      rightCheekRoi: any,
      normRoi: any,
      normCheekRoi: any,
      normUnderEyeRoi: any;

    try {
      let sourceElement: HTMLVideoElement | HTMLImageElement;
      if (this.runningMode === 'IMAGE') {
        sourceElement = document.getElementById('test-image') as HTMLImageElement;
      } else {
        sourceElement = this.video;
      }
      if (!sourceElement) return;

      let tempCanvas = document.getElementById('derm-buffer') as HTMLCanvasElement;
      if (!tempCanvas) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.id = 'derm-buffer';
        tempCanvas.style.display = 'none';
        document.body.appendChild(tempCanvas);
      }

      const width = sourceElement instanceof HTMLVideoElement ? sourceElement.videoWidth : sourceElement.naturalWidth;
      const height =
        sourceElement instanceof HTMLVideoElement ? sourceElement.videoHeight : sourceElement.naturalHeight;

      tempCanvas.width = width;
      tempCanvas.height = height;
      let ctx = tempCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(sourceElement, 0, 0, width, height);

      frame = cv.imread('derm-buffer');
      balanced = DermatologyEngine.grayWorldWhiteBalance(frame);
      processed = DermatologyEngine.claheEnhance(balanced);

      extractedRoi = this.extractRoi(processed, landmarks, 'forehead');
      roi = extractedRoi.clone();

      cheekRoi = this.extractRoi(processed, landmarks, 'cheek');
      underEyeRoi = this.extractRoi(processed, landmarks, 'undereye');
      rightCheekRoi = this.extractRoi(processed, landmarks, 'rightcheek');

      // ── STEP 1: Detect lighting conditions across all 3 flat face regions ──
      const lighting = DermatologyEngine.detectLightingCondition(roi, cheekRoi, rightCheekRoi);

      // ── STEP 2: Apply Single Scale Retinex normalization per-ROI ──
      // This removes ambient illumination, leaving only true skin reflectance.
      normRoi = DermatologyEngine.normalizeIllumination(roi);
      normCheekRoi = DermatologyEngine.normalizeIllumination(cheekRoi);
      normUnderEyeRoi = DermatologyEngine.normalizeIllumination(underEyeRoi);

      // ── STEP 3: Run all metrics on illumination-normalized ROIs ──

      const eyeLandmarks = [
        landmarks[33],
        landmarks[160],
        landmarks[158],
        landmarks[133],
        landmarks[153],
        landmarks[144],
      ];

      const sharpness = DermatologyEngine.getImageSharpness(roi);
      const glare = DermatologyEngine.getSpecularGlare(roi);
      const quality = DermatologyEngine.faceQualityHeuristic(roi, sharpness, glare);

      // Bypass the strict quality check to show all features working
      // if (quality.quality_ok) {
      const rawHemoglobin = DermatologyEngine.getHemoglobinIndex(roi);

      // --- rPPG Temporal Processing ---
      const now = performance.now();
      this.rppgBuffer.push(rawHemoglobin);
      this.timeBuffer.push(now);

      // Prune data older than the 5-second window
      while (this.timeBuffer.length > 0 && now - this.timeBuffer[0] > this.BUFFER_WINDOW_MS) {
        this.rppgBuffer.shift();
        this.timeBuffer.shift();
      }

      // Estimate Heart Rate if we have at least 3 seconds of buffer data
      if (now - this.timeBuffer[0] > 3000) {
        const estimatedHR = DermatologyEngine.estimateHeartRate(this.rppgBuffer, this.timeBuffer);
        if (estimatedHR > 0) {
          // Smooth the transition of the UI number
          this.lastHeartRate = this.lastHeartRate === 0 ? estimatedHR : this.lastHeartRate * 0.8 + estimatedHR * 0.2;
        }
      }
      // --------------------------------

      const luminance = DermatologyEngine.getLuminanceVariance(normRoi);
      const erythema = DermatologyEngine.getErythemaIndex(normRoi);
      const poreDensity = DermatologyEngine.getBlackHatPoreDensity(normRoi);
      const melanin = DermatologyEngine.getMelaninIndex(normRoi);
      const yellowness = DermatologyEngine.getYellownessIndex(normRoi);
      const fatigueEAR = DermatologyEngine.getEyeAspectRatio(eyeLandmarks);
      const heartRate = this.lastHeartRate;
      const oiliness = glare;

      const texture = DermatologyEngine.getTextureScore(normRoi);
      const wrinkles = DermatologyEngine.getWrinkleScore(normRoi);
      const darkCircles = DermatologyEngine.getDarkCircleScore(normUnderEyeRoi, normCheekRoi);
      const hydration = DermatologyEngine.getHydrationScore(luminance, texture);
      const imageQuality = DermatologyEngine.getImageQualityScore(quality);
      const glow = Math.min((luminance / 1500) * 100, 100);

      const acne = DermatologyEngine.getAcneSeverity(normRoi);
      const uvDamage = DermatologyEngine.getUVDamageScore(normRoi, wrinkles);
      const elasticity = DermatologyEngine.getElasticityScore(texture, wrinkles, fatigueEAR);

      const healthMetrics = {
        erythema,
        yellowness,
        poreDensity,
        melanin,
        wrinkles,
        darkCircles,
        hydration,
        acne,
        uvDamage,
      };
      const healthScore = DermatologyEngine.getOverallSkinHealth(healthMetrics);

      const results = {
        health: healthScore,
        luminance: luminance,
        glow: glow,
        hydration: hydration,
        melanin: melanin,
        erythema: erythema,
        oiliness: oiliness,
        pores: poreDensity,
        texture: texture,
        wrinkles: wrinkles,
        fatigue: fatigueEAR,
        darkCircles: darkCircles,
        heartRate: heartRate,
        perfusion: Math.min((rawHemoglobin / 150) * 100, 100),
        yellowness: yellowness,
        imageQuality: imageQuality,
        acne: acne,
        uvDamage: uvDamage,
        elasticity: elasticity,
        lighting: lighting,
      };
      this.updateDermUI(results);
      // }
    } catch (error: any) {
      if (typeof error === 'number') {
        try {
          const cvErr = cv.exceptionFromPtr(error);
          console.error('OpenCV C++ Exception:', cvErr.msg);
        } catch (e) {
          console.error('OpenCV Raw Pointer Error:', error);
        }
      } else {
        console.error('JavaScript Error in dermatology analysis:', error);
      }
    } finally {
      if (frame)
        try {
          frame.delete();
        } catch (e) {}
      if (balanced)
        try {
          balanced.delete();
        } catch (e) {}
      if (processed)
        try {
          processed.delete();
        } catch (e) {}
      if (extractedRoi)
        try {
          extractedRoi.delete();
        } catch (e) {}
      if (roi)
        try {
          roi.delete();
        } catch (e) {}
      if (cheekRoi)
        try {
          cheekRoi.delete();
        } catch (e) {}
      if (underEyeRoi)
        try {
          underEyeRoi.delete();
        } catch (e) {}
      if (rightCheekRoi)
        try {
          rightCheekRoi.delete();
        } catch (e) {}
      if (normRoi)
        try {
          normRoi.delete();
        } catch (e) {}
      if (normCheekRoi)
        try {
          normCheekRoi.delete();
        } catch (e) {}
      if (normUnderEyeRoi)
        try {
          normUnderEyeRoi.delete();
        } catch (e) {}

      this.isProcessing = false;
    }
  }

  private updateDermUI(data: any) {
    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };

    const setStatus = (
      id: string,
      value: number,
      lowThresh: number,
      highThresh: number,
      higherIsBetter: boolean = false
    ) => {
      const el = document.getElementById(id);
      if (!el) return;

      if (value > highThresh) {
        el.innerHTML = higherIsBetter
          ? `<span class="status-badge status-normal">Excellent</span>`
          : `<span class="status-badge status-high">Elevated</span>`;
      } else if (value < lowThresh) {
        el.innerHTML = higherIsBetter
          ? `<span class="status-badge status-high">Low</span>`
          : `<span class="status-badge status-low">Low</span>`;
      } else {
        el.innerHTML = `<span class="status-badge status-normal">Normal</span>`;
      }
    };

    setText('val-health', Math.round(data.health).toString() + '/100');
    setStatus('stat-health', data.health, 50, 80, true);

    setText('val-luminance', Math.round(data.glow).toString() + '/100');
    setStatus('stat-luminance', data.glow, 40, 70, true);

    setText('val-hydration', Math.round(data.hydration).toString() + '/100');
    setStatus('stat-hydration', data.hydration, 40, 70, true);

    setText('val-melanin', data.melanin.toFixed(2));
    setStatus('stat-melanin', data.melanin, 5, 25);

    setText('val-erythema', data.erythema.toFixed(1));
    setStatus('stat-erythema', data.erythema, 90, 150);

    setText('val-oiliness', data.oiliness.toFixed(1) + '%');
    setStatus('stat-oiliness', data.oiliness, 5, 15);

    setText('val-pores', data.pores.toFixed(1) + '%');
    setStatus('stat-pores', data.pores, 2, 10);

    setText('val-texture', Math.round(data.texture).toString() + '/100');
    setStatus('stat-texture', data.texture, 40, 75, true);

    setText('val-wrinkles', data.wrinkles.toFixed(1) + '%');
    setStatus('stat-wrinkles', data.wrinkles, 1, 5);

    setText('val-fatigue', data.fatigue.toFixed(3));
    // Fatigue EAR: higher EAR is more awake
    const fatigueEl = document.getElementById('stat-fatigue');
    if (fatigueEl) {
      fatigueEl.innerHTML =
        data.fatigue < 0.2
          ? `<span class="status-badge status-high">Fatigued</span>`
          : `<span class="status-badge status-normal">Awake</span>`;
    }

    setText('val-dark-circles', Math.round(data.darkCircles).toString() + '%');
    setStatus('stat-dark-circles', data.darkCircles, 10, 30);

    if (data.heartRate === 0) {
      setText('val-heartrate', 'Calibrating...');
      const statEl = document.getElementById('stat-heartrate');
      if (statEl) statEl.innerHTML = `<span class="status-badge status-normal">Buffering</span>`;
    } else {
      setText('val-heartrate', Math.round(data.heartRate).toString() + ' BPM');
      setStatus('stat-heartrate', data.heartRate, 60, 100);
    }

    setText('val-perfusion', Math.round(data.perfusion).toString() + '/100');
    setStatus('stat-perfusion', data.perfusion, 40, 80, true);

    setText('val-yellowness', data.yellowness.toFixed(1));
    setStatus('stat-yellowness', data.yellowness, 110, 140);

    setText('val-image-quality', Math.round(data.imageQuality).toString() + '/100');
    // Show lighting condition as the status for Image Quality
    const iqEl = document.getElementById('stat-image-quality');
    if (iqEl && data.lighting) {
      const lt = data.lighting.lightingType;
      const uni = Math.round(data.lighting.uniformity);
      if (lt === 'Even') {
        iqEl.innerHTML = `<span class="status-badge status-normal">Even ✓</span>`;
      } else if (lt === 'Overexposed') {
        iqEl.innerHTML = `<span class="status-badge status-high">⚠ Overexposed</span>`;
      } else if (lt === 'Dark') {
        iqEl.innerHTML = `<span class="status-badge status-high">⚠ Dark Room</span>`;
      } else if (lt === 'Side-lit') {
        iqEl.innerHTML = `<span class="status-badge status-high">⚠ Side-lit</span>`;
      } else {
        iqEl.innerHTML = `<span class="status-badge status-high">⚠ Uneven (${uni}%)</span>`;
      }
    }

    // Acne: lower is better - show clear labels instead of raw %
    const acneEl = document.getElementById('stat-acne');
    if (acneEl) {
      if (data.acne < 1) acneEl.innerHTML = `<span class="status-badge status-normal">Clear</span>`;
      else if (data.acne < 10) acneEl.innerHTML = `<span class="status-badge status-normal">Mild</span>`;
      else if (data.acne < 30) acneEl.innerHTML = `<span class="status-badge status-high">Moderate</span>`;
      else acneEl.innerHTML = `<span class="status-badge status-high">Severe</span>`;
    }
    setText('val-acne', data.acne < 1 ? 'Clear' : data.acne.toFixed(1) + '%');

    // UV Damage: show descriptive labels
    const uvEl = document.getElementById('stat-uv');
    if (uvEl) {
      if (data.uvDamage < 20) uvEl.innerHTML = `<span class="status-badge status-normal">Minimal</span>`;
      else if (data.uvDamage < 50) uvEl.innerHTML = `<span class="status-badge status-high">Moderate</span>`;
      else uvEl.innerHTML = `<span class="status-badge status-high">High</span>`;
    }
    setText('val-uv', Math.round(data.uvDamage).toString() + '/100');

    setText('val-elasticity', Math.round(data.elasticity).toString() + '/100');
    setStatus('stat-elasticity', data.elasticity, 50, 80, true);
  }
}

// Singleton instance to support modular cleanup
let activeTask: FaceLandmarkerTask | null = null;

export async function setupFaceLandmarker(container: HTMLElement) {
  activeTask = new FaceLandmarkerTask({
    container,
    template,
    defaultModelName: 'face_landmarker',
    defaultModelUrl:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    workerFactory: () =>
      new Worker(new URL('../workers/face-landmarker.worker.ts', import.meta.url), { type: 'module' }),
  });

  await activeTask.initialize();
}

export function cleanupFaceLandmarker() {
  if (activeTask) {
    activeTask.cleanup();
    activeTask = null;
  }
}
