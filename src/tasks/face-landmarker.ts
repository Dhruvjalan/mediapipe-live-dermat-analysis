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
import {
  aggregateScan,
  analyzeFrame,
  deriveCompositeMetrics,
  estimatePulse,
  faceRegions,
  PulseTracker,
  skinColour,
  type FrameMeasures,
  type LightingInfo,
} from './dermatology-engine';
import {
  healthLevel,
  interpretSkin,
  skinHealthScore,
  SKIN_METRICS_VERSION,
  type SkinMetrics,
} from '../services/skin-interpretation';
import { saveScanToHistory } from '../services/history-store';

// @ts-ignore
import template from '../templates/face-landmarker.html?raw';

// Sequence capture stages for multi-angle temporal stabilization
type ScanStage = 'IDLE' | 'CENTER' | 'RIGHT' | 'LEFT' | 'UP' | 'DOWN' | 'COMPLETED';

// ── CONFIGURABLE THRESHOLDS FOR TESTING ──
const SCAN_CONFIG = {
  FRAMES_PER_STAGE: 15, // Total collected raw frames per stage
  MIN_GOOD_FRAMES_RESTART: 4, // If good frames <= this threshold, entire scan restarts
  FRAME_QUALITY_THRESHOLD: 65.0, // Minimum quality score (0-100) to classify a frame as "good"
  TOP_FRAMES_PER_STAGE: 3, // Best frames per pose that go into the final result
  // How long the centre pose waits for a pulse before moving on. A clear pulse locks after
  // ~11-13 s of still video; a faint one (dim or flickering light) can need up to ~20 s.
  PULSE_MAX_WAIT_MS: 20000,
};

/** The frozen result of a completed scan: what the table shows and what the chat receives. */
type ScanResult = SkinMetrics & { lighting: LightingInfo };

class FaceLandmarkerTask extends BaseVisionTask {
  private drawingUtils: DrawingUtils | undefined;

  private numFaces = 1;
  private minFaceDetectionConfidence = 0.5;
  private minFacePresenceConfidence = 0.5;
  private minTrackingConfidence = 0.5;

  // ── Multi-Angle Sequence Capture & Scoring Buffers ──
  private currentStage: ScanStage = 'IDLE';
  private stageFramesCount: number = 0;
  private poseMatched = false; // whether the latest frame matched the current stage's pose
  private scanRestartAttempts = 0;

  // Stores measured frames per pose stage for ranking & filtering
  private stageFrameBuckets: Record<string, FrameMeasures[]> = {
    CENTER: [],
    RIGHT: [],
    LEFT: [],
    UP: [],
    DOWN: [],
  };

  // ── Pulse (camera PPG) ──
  private pulse = new PulseTracker();
  private centerStartedAt = 0;

  private scanResult: ScanResult | null = null;

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
      reportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.saveMetricsAndProceed();
      });
    }
  }

  /**
   * Save the completed scan (exactly what the table shows) to session storage.
   */
  public saveMetricsToSession(): void {
    if (!this.scanResult) return;
    const { lighting, ...metrics } = this.scanResult;
    sessionStorage.setItem('ayurgenx-skin-metrics', JSON.stringify(metrics));
  }

  /**
   * Save analyzed metrics to session storage and navigate directly to AI questions consultation.
   */
  public saveMetricsAndProceed(): void {
    if (!this.scanResult) {
      this.updateInstructionBanner('Please complete the <b>Multi-Angle Scan</b> first, then continue.');
      return;
    }
    this.saveMetricsToSession();
    window.location.hash = '#/health/health_chat';
  }

  public startSequenceScan() {
    this.currentStage = 'CENTER';
    this.stageFrameBuckets = { CENTER: [], RIGHT: [], LEFT: [], UP: [], DOWN: [] };
    this.stageFramesCount = 0;
    this.scanResult = null;
    // The pulse is read fresh from the still centre pose of this scan.
    this.pulse = new PulseTracker();
    this.centerStartedAt = 0; // set at the first measurable centre-pose frame
    document.getElementById('get-report-btn')?.classList.remove('pulse-highlight');
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
      this.updateInstructionBanner('✅ Scan complete! Combining the best frames from each angle...');
      const ring = document.querySelector('.face-id-guide-ring') as HTMLElement;
      if (ring) ring.style.borderColor = '#34c759';
      this.evaluateScan();
    }
  }

  private checkPoseAndAdvanceSequence(landmarks: any[]) {
    if (this.currentStage === 'IDLE' || this.currentStage === 'COMPLETED') return;

    const nose = landmarks[1];
    const leftEar = landmarks[234];
    const rightEar = landmarks[454];

    const totalWidth = Math.abs(rightEar.x - leftEar.x);
    const noseOffset = (nose.x - leftEar.x) / totalWidth;
    const eyeMidY = (landmarks[33].y + landmarks[263].y) / 2;
    const verticalDelta = nose.y - eyeMidY;

    let poseMatched = false;
    switch (this.currentStage) {
      case 'CENTER':
        if (noseOffset >= 0.1 && noseOffset <= 0.9 && Math.abs(verticalDelta) < 0.1) poseMatched = true;
        break;
      case 'RIGHT':
        if (noseOffset < 0.4) poseMatched = true;
        break;
      case 'LEFT':
        if (noseOffset > 0.6) poseMatched = true;
        break;
      case 'UP':
        if (verticalDelta < 0.03) poseMatched = true;
        break;
      case 'DOWN':
        if (verticalDelta > 0.1) poseMatched = true;
        break;
    }

    this.poseMatched = poseMatched;
    if (!poseMatched) return;

    // A face that is too far away or partly out of frame can't be measured: say so, rather than count it.
    if (!faceRegions(landmarks, this.video.videoWidth, this.video.videoHeight)) {
      this.updateInstructionBanner('Move a little closer and keep your <b>whole face</b> in the frame');
      return;
    }
    // The pulse wait counts from here, so time before the camera or model was ready doesn't count.
    if (this.currentStage === 'CENTER' && !this.centerStartedAt) this.centerStartedAt = performance.now();
    this.stageFramesCount++;

    if (this.stageFramesCount < SCAN_CONFIG.FRAMES_PER_STAGE) {
      const progressPercent = Math.round((this.stageFramesCount / SCAN_CONFIG.FRAMES_PER_STAGE) * 100);
      this.updateInstructionBanner(`Capturing <b>${this.currentStage}</b> pose... (${progressPercent}%)`);
      return;
    }

    // The pulse can only be read while the head is still, so the centre pose
    // waits (up to a limit) for a steady reading before the head turns.
    if (this.currentStage === 'CENTER' && !this.pulse.locked) {
      const waited = performance.now() - this.centerStartedAt;
      if (waited < SCAN_CONFIG.PULSE_MAX_WAIT_MS) {
        const secondsLeft = Math.ceil((SCAN_CONFIG.PULSE_MAX_WAIT_MS - waited) / 1000);
        this.updateInstructionBanner(`Hold still, reading your pulse... (${secondsLeft}s)`);
        return;
      }
      this.logPulseNotFound();
    }
    this.advanceToNextStage();
  }

  /** Why the pulse wasn't confirmed, for anyone checking the console. */
  private logPulseNotFound() {
    const samples = this.pulse.samples;
    const seconds = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
    const rate = seconds > 0 ? (samples.length - 1) / seconds : 0;
    const best = estimatePulse(samples, 0, -Infinity, -Infinity);
    console.warn(
      `Pulse not confirmed: ${samples.length} colour samples over ${seconds.toFixed(1)} s (${rate.toFixed(1)} per second), ` +
        `best peak ${best.bpm} BPM, SNR ${best.snr.toFixed(1)} dB, prominence ${best.prominence.toFixed(1)} dB.`
    );
  }

  /**
   * Ranks the captured frames by quality, restarts once if too few are usable,
   * then combines the best frames of every pose (trimmed median) into the
   * frozen scan result.
   */
  private evaluateScan() {
    const stageFrames = (['CENTER', 'RIGHT', 'LEFT', 'UP', 'DOWN'] as const).map((s) => this.stageFrameBuckets[s]);
    const goodFrames = stageFrames.flat().filter((f) => f.quality >= SCAN_CONFIG.FRAME_QUALITY_THRESHOLD).length;
    console.log(`Scan Evaluation - Good Frames Found: ${goodFrames}`);

    // If good frames are critically low, restart the whole process (once)
    if (goodFrames <= SCAN_CONFIG.MIN_GOOD_FRAMES_RESTART && this.scanRestartAttempts < 1) {
      console.warn('Too many substandard frames detected. Restarting full sequence scan.');
      this.updateInstructionBanner('Low lighting or erratic motion detected. <b>Restarting Scan...</b>');
      setTimeout(() => this.startSequenceScan(), 2000);
      this.scanRestartAttempts++;
      return;
    }

    const combined = aggregateScan(stageFrames, SCAN_CONFIG.TOP_FRAMES_PER_STAGE, SCAN_CONFIG.FRAME_QUALITY_THRESHOLD);
    if (!combined) {
      this.updateInstructionBanner('No usable frames were captured. Please try again in brighter, even light.');
      return;
    }

    // The table, the session and the chat always get this same result.
    this.scanResult = this.buildScanResult(combined);
    this.updateDermUI(this.scanResult);
    this.updateInstructionBanner('✅ Face Scan Complete! Review your metrics on the left, then click <b>Continue to Health Consultation</b> below.');
    console.log('Scan results:', this.scanResult);

    // Save metrics to session immediately so they're secured, and keep the scan in the user's history.
    this.saveMetricsToSession();
    const { lighting, ...metrics } = this.scanResult;
    void saveScanToHistory(metrics);

    // Add pulse animation to the proceed button so it's prominent
    const reportBtn = document.getElementById('get-report-btn');
    if (reportBtn) {
      reportBtn.classList.add('pulse-highlight');
    }
  }

  private buildScanResult(m: FrameMeasures): ScanResult {
    const composite = deriveCompositeMetrics(m);
    const result: ScanResult = {
      version: SKIN_METRICS_VERSION,
      health: 0,
      glow: composite.glow,
      hydration: composite.hydration,
      melanin: m.melanin,
      erythema: m.erythema,
      oiliness: m.oiliness,
      pores: m.pores,
      texture: m.texture,
      wrinkles: m.wrinkles,
      fatigue: m.fatigue,
      darkCircles: m.darkCircles,
      heartRate: this.pulse.locked?.bpm ?? 0,
      perfusion: this.pulse.locked?.perfusion ?? 0,
      yellowness: m.yellowness,
      imageQuality: m.quality,
      acne: m.acne,
      uvDamage: composite.uvDamage,
      elasticity: composite.elasticity,
      pigmentation: m.pigmentation,
      lighting: m.lighting,
    };
    result.health = skinHealthScore(result);
    return result;
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
    if (!this.canvasElement) {
      this.canvasElement = document.getElementById('output_canvas') as HTMLCanvasElement;
    }
    if (!this.canvasCtx && this.canvasElement) {
      this.canvasCtx = this.canvasElement.getContext('2d')!;
    }

    if (!this.canvasElement || !this.canvasCtx) return;
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
        if (this.currentStage !== 'IDLE' && this.currentStage !== 'COMPLETED') {
          this.checkPoseAndAdvanceSequence(landmarks);
        }

        this.runDermatologyAnalysis(landmarks);
      }
    }
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
  private analysisCanvas: HTMLCanvasElement | null = null;

  /**
   * Per video frame, during a scan: a cheap skin-colour sample for the pulse
   * (centre pose only), and the full skin analysis for the first
   * FRAMES_PER_STAGE frames of each pose. Analysing every frame would slow the
   * camera down below the frame rate the pulse needs.
   */
  private runDermatologyAnalysis(landmarks: any[]) {
    if (this.isProcessing) return;
    const scanning = this.currentStage !== 'IDLE' && this.currentStage !== 'COMPLETED';
    if (!scanning) return;
    const readingPulse = this.currentStage === 'CENTER' && !this.pulse.locked && this.centerStartedAt > 0;
    const bucket = this.stageFrameBuckets[this.currentStage];
    const collecting = this.poseMatched && this.stageFramesCount > 0 && bucket.length < SCAN_CONFIG.FRAMES_PER_STAGE;
    if (!readingPulse && !collecting) return;
    this.isProcessing = true;

    try {
      const source =
        this.runningMode === 'IMAGE' ? (document.getElementById('test-image') as HTMLImageElement) : this.video;
      if (!source) return;
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      if (!width || !height) return;
      const regions = faceRegions(landmarks, width, height);
      if (!regions) return;

      if (!this.analysisCanvas) this.analysisCanvas = document.createElement('canvas');
      const canvas = this.analysisCanvas;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, width, height);

      if (readingPulse) {
        const patches = [regions.forehead, regions.rightCheek, regions.leftCheek].map((r) =>
          ctx.getImageData(r.x, r.y, r.width, r.height)
        );
        this.trackPulse(skinColour(patches));
      }
      if (collecting) {
        const analysis = analyzeFrame(ctx.getImageData(0, 0, width, height), landmarks);
        if (analysis) bucket.push(analysis.measures);
      }
    } catch (error: any) {
      console.error('Error in dermatology frame analysis:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Feeds the skin's colour into the pulse tracker. Only during the still centre
   * pose: turning the head ruins the signal.
   */
  private trackPulse(colour: { r: number; g: number; b: number }) {
    const pulse = this.pulse.add({ t: performance.now(), ...colour });
    if (!pulse) return;
    const samples = this.pulse.samples;
    const seconds = (samples[samples.length - 1].t - samples[0].t) / 1000;
    console.log(
      `Pulse locked: ${pulse.bpm} BPM (SNR ${pulse.snr.toFixed(1)} dB, prominence ${pulse.prominence.toFixed(1)} dB, ` +
        `${((samples.length - 1) / seconds).toFixed(1)} samples per second)`
    );
  }

  private updateDermUI(data: ScanResult) {
    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };
    const setBadge = (id: string, text: string, tone: 'normal' | 'fair' | 'high' | 'low') => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<span class="status-badge status-${tone}">${text}</span>`;
    };

    // Every graded metric gets its status from the same rules the chat and report use.
    const tones = { good: 'normal', fair: 'fair', concern: 'high' } as const;
    const readings = new Map(interpretSkin(data).map((r) => [r.key, r]));
    const showReading = (key: keyof SkinMetrics, valueId: string, statusId: string, value: string) => {
      setText(valueId, Number.isFinite(data[key]) ? value : 'Not measured');
      const reading = readings.get(key);
      if (reading) setBadge(statusId, reading.status, tones[reading.level]);
    };

    // ═══ ALL METRICS (Fixed — Always Shown) ═══

    // Skin Health Score
    setText('val-health', `${Math.round(data.health)}/100`);
    const health = healthLevel(data.health);
    setBadge('stat-health', { good: 'Good', fair: 'Fair', concern: 'Needs care' }[health], tones[health]);

    // Heart Rate & Perfusion (only when a steady pulse was read during the centre pose)
    if (data.heartRate > 0) {
      setText('val-heartrate', `${data.heartRate} BPM`);
      if (data.heartRate > 100) setBadge('stat-heartrate', 'Elevated', 'high');
      else if (data.heartRate < 50) setBadge('stat-heartrate', 'Low', 'low');
      else setBadge('stat-heartrate', 'Normal', 'normal');
      setText('val-perfusion', `${data.perfusion}/100`);
      setBadge('stat-perfusion', data.perfusion >= 30 ? 'Good' : 'Weak', data.perfusion >= 30 ? 'normal' : 'fair');
    } else {
      setText('val-heartrate', 'Not measured');
      setBadge('stat-heartrate', 'Hold still', 'fair');
      setText('val-perfusion', 'Not measured');
      setBadge('stat-perfusion', 'No pulse', 'fair');
    }

    showReading('glow', 'val-luminance', 'stat-luminance', `${Math.round(data.glow)}/100`);
    showReading('hydration', 'val-hydration', 'stat-hydration', `${Math.round(data.hydration)}/100`);
    showReading('oiliness', 'val-oiliness', 'stat-oiliness', `${data.oiliness.toFixed(1)}%`);
    showReading('pores', 'val-pores', 'stat-pores', `${data.pores.toFixed(1)}%`);
    showReading('pigmentation', 'val-melanin', 'stat-melanin', `${Math.round(data.pigmentation)}/100`);
    showReading('erythema', 'val-erythema', 'stat-erythema', data.erythema.toFixed(1));
    showReading('texture', 'val-texture', 'stat-texture', `${Math.round(data.texture)}/100`);
    showReading('wrinkles', 'val-wrinkles', 'stat-wrinkles', `${Math.round(data.wrinkles)}/100`);
    showReading('darkCircles', 'val-dark-circles', 'stat-dark-circles', `${Math.round(data.darkCircles)}%`);
    showReading('fatigue', 'val-fatigue', 'stat-fatigue', data.fatigue.toFixed(3));
    showReading('yellowness', 'val-yellowness', 'stat-yellowness', `${data.yellowness.toFixed(1)}°`);
    showReading('acne', 'val-acne', 'stat-acne', `${data.acne.toFixed(1)}%`);
    showReading('uvDamage', 'val-uv', 'stat-uv', `${Math.round(data.uvDamage)}/100`);
    showReading('elasticity', 'val-elasticity', 'stat-elasticity', `${Math.round(data.elasticity)}/100`);

    // ═══ DIAGNOSTICS ═══

    setText('val-image-quality', `${Math.round(data.imageQuality)}/100`);
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
