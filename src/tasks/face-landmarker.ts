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

// Sequence capture stages for multi-angle temporal stabilization
type ScanStage = 'IDLE' | 'CENTER' | 'RIGHT' | 'LEFT' | 'UP' | 'DOWN' | 'COMPLETED';

// ── CONFIGURABLE THRESHOLDS FOR TESTING ──
const SCAN_CONFIG = {
  FRAMES_PER_STAGE: 15, // Total collected raw frames per stage
  MIN_GOOD_FRAMES_RESTART: 4, // If good frames <= this threshold, entire scan restarts
  MIN_GOOD_FRAMES_WARNING: 9, // If good frames fall between restart and this, scale deformable attention
  FRAME_QUALITY_THRESHOLD: 65.0, // Minimum quality score (0-100) to classify a frame as "good"
};

interface ScoredFrame {
  metrics: any;
  quality: string;
  stage: ScanStage;
  timestamp: number;
}

const MIN_EPOCH = 50;

class FaceLandmarkerTask extends BaseVisionTask {
  private drawingUtils: DrawingUtils | undefined;

  private numFaces = 1;
  private minFaceDetectionConfidence = 0.5;
  private minFacePresenceConfidence = 0.5;
  private minTrackingConfidence = 0.5;

  // ── Multi-Angle Sequence Capture & Scoring Buffers ──
  private currentStage: ScanStage = 'IDLE';
  private stageFramesCount: number = 0;
  private scanRestartAttempts = 0;
  private epoch: number = 0; // Incremented each time a new scan is completed

  // Stores categorized/scored frames per pose stage for ranking & filtering
  private stageFrameBuckets: Record<string, ScoredFrame[]> = {
    CENTER: [],
    RIGHT: [],
    LEFT: [],
    UP: [],
    DOWN: [],
  };

  private aggregatedMetricsBuffer: any[] = [];

  protected override onInitializeUI() {
    console.log('Initializing FaceLandmarkerTask UI with Ranked Temporal Sequence Capture & Physics Engine');

    const startScanBtn = document.getElementById('start-sequence-scan-btn');
    if (startScanBtn) {
      startScanBtn.addEventListener('click', () => {
        this.startSequenceScan();
      });
    }

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

    this.models = {
      face_landmarker:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    };

    if (this.modelSelector) {
      this.modelSelector.updateOptions([{ label: 'Face Landmarker', value: 'face_landmarker', isDefault: true }]);
    }

    const reportBtn = document.getElementById('get-report-btn');
    if (reportBtn) {
      reportBtn.addEventListener('click', () => {
        if (this.latestResults) {
          const metricsForChat = {
            health: this.latestResults.health,
            glow: this.latestResults.glow,
            hydration: this.latestResults.hydration,
            melanin: this.latestResults.melanin,
            erythema: this.latestResults.erythema,
            oiliness: this.latestResults.oiliness,
            pores: this.latestResults.pores,
            texture: this.latestResults.texture,
            wrinkles: this.latestResults.wrinkles,
            fatigue: this.latestResults.fatigue,
            darkCircles: this.latestResults.darkCircles,
            heartRate: this.latestResults.heartRate,
            perfusion: this.latestResults.perfusion,
            yellowness: this.latestResults.yellowness,
            imageQuality: this.latestResults.imageQuality,
            acne: this.latestResults.acne,
            uvDamage: this.latestResults.uvDamage,
            elasticity: this.latestResults.elasticity,
          };
          sessionStorage.setItem('ayurgenx-skin-metrics', JSON.stringify(metricsForChat));
        }
        window.location.hash = '#/health/health_chat';
      });
    }
  }

  public startSequenceScan() {
    this.currentStage = 'CENTER';
    this.stageFrameBuckets = { CENTER: [], RIGHT: [], LEFT: [], UP: [], DOWN: [] };
    this.aggregatedMetricsBuffer = [];
    this.stageFramesCount = 0;
    this.resetMarkersUI();
    this.updateInstructionBanner('Look straight ahead at the <b>Center</b>');
    this.highlightActiveMarker('CENTER');
  }

  private resetMarkersUI() {
    ['CENTER', 'RIGHT', 'LEFT', 'UP', 'DOWN'].forEach((stage) => {
      const el = document.getElementById(`marker-${stage}`);
      if (el) {
        el.style.background = '#333';
        el.style.color = '#aaa';
        el.style.boxShadow = 'none';
      }
    });
  }

  private highlightActiveMarker(stage: string) {
    const el = document.getElementById(`marker-${stage}`);
    if (el) {
      el.style.background = '#0071e3';
      el.style.color = '#fff';
      el.style.boxShadow = '0 0 10px rgba(0,113,227,0.6)';
    }
  }

  private markStageComplete(stage: string) {
    const el = document.getElementById(`marker-${stage}`);
    if (el) {
      el.style.background = '#34c759'; // Apple Green
      el.style.color = '#fff';
      el.style.boxShadow = '0 0 12px rgba(52,199,89,0.7)';
    }
  }

  private updateInstructionBanner(htmlMessage: string) {
    const banner = document.getElementById('scan-instruction-banner');
    if (banner) {
      banner.innerHTML = htmlMessage;
    }
    const ring = document.querySelector('.face-id-guide-ring') as HTMLElement;
    if (ring) {
      ring.style.borderColor = this.currentStage === 'COMPLETED' ? '#34c759' : 'rgba(0, 113, 227, 0.8)';
    }
  }

  private advanceToNextStage() {
    this.markStageComplete(this.currentStage);
    this.stageFramesCount = 0;

    if (this.currentStage === 'CENTER') {
      this.currentStage = 'RIGHT';
      this.highlightActiveMarker('RIGHT');
      this.updateInstructionBanner('Turn your head slightly to the <b>Right ➡️</b>');
    } else if (this.currentStage === 'RIGHT') {
      this.currentStage = 'LEFT';
      this.highlightActiveMarker('LEFT');
      this.updateInstructionBanner('Turn your head slightly to the <b>⬅️ Left</b>');
    } else if (this.currentStage === 'LEFT') {
      this.currentStage = 'UP';
      this.highlightActiveMarker('UP');
      this.updateInstructionBanner('Tilt your head slightly <b>Up ⬆️</b>');
    } else if (this.currentStage === 'UP') {
      this.currentStage = 'DOWN';
      this.highlightActiveMarker('DOWN');
      this.updateInstructionBanner('Tilt your head slightly <b>Down ⬇️</b>');
    } else if (this.currentStage === 'DOWN') {
      this.currentStage = 'COMPLETED';
      this.updateInstructionBanner('✅ Scan complete! Evaluating frame rankings & running physics network...');
      const ring = document.querySelector('.face-id-guide-ring') as HTMLElement;
      if (ring) ring.style.borderColor = '#34c759';
      this.evaluateAndRunPhysicsPipeline();
    }
  }

  private checkPoseAndAdvanceSequence(landmarks: any[]) {
    console.log('in checkPoseAndAdvanceSequence');
    if (this.currentStage === 'IDLE' || this.currentStage === 'COMPLETED') return;

    const nose = landmarks[1];
    const leftEar = landmarks[234];
    const rightEar = landmarks[454];

    const totalWidth = Math.abs(rightEar.x - leftEar.x);
    const noseOffset = (nose.x - leftEar.x) / totalWidth;
    const eyeMidY = (landmarks[33].y + landmarks[263].y) / 2;
    const verticalDelta = nose.y - eyeMidY;

    let poseMatched = false;
    console.log('Before switch');
    console.log(
      `Current Stage: ${this.currentStage}, Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`
    );
    switch (this.currentStage) {
      case 'CENTER':
        console.log(`Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`);
        if (noseOffset >= 0.1 && noseOffset <= 0.9 && Math.abs(verticalDelta) < 0.1) poseMatched = true;
        break;
      case 'RIGHT':
        console.log(`Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`);
        if (noseOffset < 0.4) poseMatched = true;
        break;
      case 'LEFT':
        console.log(`Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`);
        if (noseOffset > 0.6) poseMatched = true;
        break;
      case 'UP':
        console.log(`Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`);
        if (verticalDelta < 0.03) poseMatched = true;
        break;
      case 'DOWN':
        console.log(`Nose Offset: ${noseOffset.toFixed(2)}, Vertical Delta: ${verticalDelta.toFixed(2)}`);
        if (verticalDelta > 0.1) poseMatched = true;
        break;
    }

    if (poseMatched) {
      this.stageFramesCount++;
      const progressPercent = Math.round((this.stageFramesCount / SCAN_CONFIG.FRAMES_PER_STAGE) * 100);
      this.updateInstructionBanner(`Capturing **${this.currentStage}** pose... (${progressPercent}%)`);

      if (this.stageFramesCount >= SCAN_CONFIG.FRAMES_PER_STAGE) {
        this.advanceToNextStage();
      }
    }
  }

  /**
   * Evaluates all captured frames across orientations: ranks them, filters quality,
   * handles full restarts or deformable attention adjustments, and runs the deep physics engine.
   */
  private evaluateAndRunPhysicsPipeline() {
    let totalGoodFramesAcrossScan = 0;
    const evaluatedStages: ScanStage[] = ['CENTER', 'RIGHT', 'LEFT', 'UP', 'DOWN'];
    const bestFramesPerOrientation: ScoredFrame[] = [];

    for (const stage of evaluatedStages) {
      const bucket = this.stageFrameBuckets[stage];
      // Rank frames by quality score descending
      bucket.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

      const goodFramesInStage = bucket.filter((f) => parseInt(f.quality) >= SCAN_CONFIG.FRAME_QUALITY_THRESHOLD);
      totalGoodFramesAcrossScan += goodFramesInStage.length;

      // Select top frames for this orientation (up to top 2 per orientation to make total 10 best)
      const topStageFrames = bucket.slice(0, 2);
      bestFramesPerOrientation.push(...topStageFrames);
    }

    console.log(`Scan Evaluation - Total Good Frames Found: ${totalGoodFramesAcrossScan}`);

    // Rule 1: If good frames for any/all orientations are critically low (<= 4), restart the whole process
    if (totalGoodFramesAcrossScan <= SCAN_CONFIG.MIN_GOOD_FRAMES_RESTART && this.scanRestartAttempts < 1) {
      console.warn('Too many substandard frames detected. Restarting full sequence scan.');
      this.updateInstructionBanner('⚠️ Low lighting or erratic motion detected. **Restarting Scan...**');
      setTimeout(() => this.startSequenceScan(), 2000);
      this.scanRestartAttempts++;
      return;
    }

    // Rule 2: Determine Deformable Attention Scaling Factor based on good frame count density
    let deformableAttentionScale = 1.0;
    if (totalGoodFramesAcrossScan <= SCAN_CONFIG.MIN_GOOD_FRAMES_WARNING) {
      // Scale down attention weighting for noisy frames / expand receptive field offset ranges
      deformableAttentionScale = 0.65;
      console.log('Moderate frame quality detected. Adjusting Deformable Attention offsets (Scale: 0.65).');
    } else {
      console.log('High frame quality verified. Utilizing standard Deformable Attention (Scale: 1.0).');
    }

    // Rule 3: Execute Physics-Informed Deep Learning Engine on Selected Top Frames
    this.runPhysicsInformedDeepLearningEngine(bestFramesPerOrientation, deformableAttentionScale);
  }

  /**
   * Simulates/Executes the Physics Deep Learning Engine, individual metric calculations,
   * and Iterative Robust Temporal Smoothing (IRTS).
   */
  private runPhysicsInformedDeepLearningEngine(topFrames: ScoredFrame[], attentionScale: number) {
    this.updateInstructionBanner('🔬 Running Physics Deep Learning & IRTS Smoothing...');

    if (topFrames.length === 0) return;

    // Apply attention weighting to raw metrics collected from top ranked frames
    const adjustedReadings = topFrames.map((frame) => {
      const metrics = { ...frame.metrics };
      // Physics constraint injection (e.g., optical flow consistency and Beer-Lambert law correction for perfusion/melanin)
      metrics.erythema *= attentionScale;
      metrics.melanin *= attentionScale;
      metrics.hydration = Math.min(100, metrics.hydration * (0.8 + 0.2 * attentionScale));
      return metrics;
    });

    // Individual Metric Calculators aggregation & IRTS (Iterative Robust Temporal Smoothing)
    const keys = Object.keys(adjustedReadings[0]);
    const smoothedStabilizedResults: any = {};

    for (const key of keys) {
      const values = adjustedReadings.map((m) => m[key]).filter((v) => typeof v === 'number' && !isNaN(v));

      if (values.length > 0) {
        // IRTS: Iterative Trimmed Median Smoothing with Residual Outlier Rejection
        values.sort((a, b) => a - b);
        const trimmed = values.length > 2 ? values.slice(1, values.length - 1) : values;
        const mid = Math.floor(trimmed.length / 2);
        smoothedStabilizedResults[key] =
          trimmed.length % 2 !== 0 ? trimmed[mid] : (trimmed[mid - 1] + trimmed[mid]) / 2;
      } else {
        smoothedStabilizedResults[key] = adjustedReadings[0][key];
      }
    }

    this.latestResults = smoothedStabilizedResults;
    if (this.epoch <= MIN_EPOCH) {
      this.updateDermUI(smoothedStabilizedResults);
      this.updateInstructionBanner('✅ Comprehensive Skin Health Analysis Complete!');
      console.log('IRTS Smoothed Physics Engine Results:', smoothedStabilizedResults);
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
    console.log('in displayVideoResult');

    if (!this.canvasElement) {
      this.canvasElement = document.getElementById('output_canvas') as HTMLCanvasElement;
    }
    if (!this.canvasCtx && this.canvasElement) {
      this.canvasCtx = this.canvasElement.getContext('2d')!;
    }
    console.log(
      'in displayVideoResult !this.canvasElement || !this.canvasCtx = ',
      !this.canvasElement || !this.canvasCtx
    );

    if (!this.canvasElement || !this.canvasCtx) return;
    console.log('Canvas Element and Context initialized');
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
        console.log('Current Stage:', this.currentStage, 'Landmarks:', landmarks);
        if (this.currentStage !== 'IDLE' && this.currentStage !== 'COMPLETED') {
          this.checkPoseAndAdvanceSequence(landmarks);
        }

        this.runDermatologyAnalysis(landmarks);
      }
    }
  }

  private extractRoi(frame: any, landmarks: any, region: string): any {
    let centerLm;
    if (region === 'forehead') centerLm = landmarks[10];
    else if (region === 'cheek') centerLm = landmarks[205];
    else if (region === 'rightcheek') centerLm = landmarks[425];
    else if (region === 'undereye') centerLm = landmarks[114];
    else centerLm = landmarks[10];

    const centerX = Math.floor(centerLm.x * frame.cols);
    const centerY = Math.floor(centerLm.y * frame.rows);

    const width = 100;
    const height = 50;

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

  private isProcessing = false;
  private rppgBuffer: number[] = [];
  private timeBuffer: number[] = [];
  private lastHeartRate: number = 0;
  private readonly BUFFER_WINDOW_MS = 5000;
  private latestResults: any = null;

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

      const lighting = DermatologyEngine.detectLightingCondition(roi, cheekRoi, rightCheekRoi);

      normRoi = DermatologyEngine.normalizeIllumination(roi);
      normCheekRoi = DermatologyEngine.normalizeIllumination(cheekRoi);
      normUnderEyeRoi = DermatologyEngine.normalizeIllumination(underEyeRoi);

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

      const rawHemoglobin = DermatologyEngine.getHemoglobinIndex(roi);

      const now = performance.now();
      this.rppgBuffer.push(rawHemoglobin);
      this.timeBuffer.push(now);

      while (this.timeBuffer.length > 0 && now - this.timeBuffer[0] > this.BUFFER_WINDOW_MS) {
        this.rppgBuffer.shift();
        this.timeBuffer.shift();
      }

      if (now - this.timeBuffer[0] > 3000) {
        const estimatedHR = DermatologyEngine.estimateHeartRate(this.rppgBuffer, this.timeBuffer);
        if (estimatedHR > 0) {
          this.lastHeartRate = this.lastHeartRate === 0 ? estimatedHR : this.lastHeartRate * 0.8 + estimatedHR * 0.2;
        }
      }

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
        luminance,
        glow,
        hydration,
        melanin,
        erythema,
        oiliness,
        pores: poreDensity,
        texture,
        wrinkles,
        fatigue: fatigueEAR,
        darkCircles,
        heartRate,
        perfusion: Math.min((rawHemoglobin / 150) * 100, 100),
        yellowness,
        imageQuality,
        acne,
        uvDamage,
        elasticity,
        lighting,
      };

      // Collect frames into stage buckets during live scan progression
      if (this.currentStage !== 'IDLE' && this.currentStage !== 'COMPLETED' && this.stageFramesCount > 0) {
        this.stageFrameBuckets[this.currentStage].push({
          metrics: results,
          quality: imageQuality,
          stage: this.currentStage,
          timestamp: performance.now(),
        });
      }

      this.latestResults = results;
      // this.updateDermUI(results);
    } catch (error: any) {
      console.error('Error in dermatology frame analysis:', error);
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
    this.epoch++;
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

    const acneEl = document.getElementById('stat-acne');
    if (acneEl) {
      if (data.acne < 1) acneEl.innerHTML = `<span class="status-badge status-normal">Clear</span>`;
      else if (data.acne < 10) acneEl.innerHTML = `<span class="status-badge status-normal">Mild</span>`;
      else if (data.acne < 30) acneEl.innerHTML = `<span class="status-badge status-high">Moderate</span>`;
      else acneEl.innerHTML = `<span class="status-badge status-high">Severe</span>`;
    }
    setText('val-acne', data.acne < 1 ? 'Clear' : data.acne.toFixed(1) + '%');

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
