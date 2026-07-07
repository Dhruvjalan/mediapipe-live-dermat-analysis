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
  /**
   * Safely extracts a Region of Interest (ROI) from the frame
   * using MediaPipe landmarks and OpenCV.js.
   */
  private extractRoi(frame: any, landmarks: any, region: string): any {
    const l10 = landmarks[10];
    const centerX = Math.floor(l10.x * frame.cols);
    const centerY = Math.floor(l10.y * frame.rows);

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

    let frame: any, balanced: any, processed: any, extractedRoi: any, roi: any;

    try {
      const videoElement = this.video;
      if (!videoElement) return;

      let tempCanvas = document.getElementById('derm-buffer') as HTMLCanvasElement;
      if (!tempCanvas) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.id = 'derm-buffer';
        tempCanvas.style.display = 'none';
        document.body.appendChild(tempCanvas);
      }
      tempCanvas.width = videoElement.videoWidth;
      tempCanvas.height = videoElement.videoHeight;
      let ctx = tempCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(videoElement, 0, 0);

      frame = cv.imread('derm-buffer');
      balanced = DermatologyEngine.grayWorldWhiteBalance(frame);
      processed = DermatologyEngine.claheEnhance(balanced);

      extractedRoi = this.extractRoi(processed, landmarks, 'forehead');
      roi = extractedRoi.clone();

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

      if (quality.quality_ok) {
        const hemoglobin = DermatologyEngine.getHemoglobinIndex(roi);

        // --- rPPG Temporal Processing ---
        const now = performance.now();
        this.rppgBuffer.push(hemoglobin);
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

        const results = {
          luminance: DermatologyEngine.getLuminanceVariance(roi),
          erythema: DermatologyEngine.getErythemaIndex(roi),
          poreDensity: DermatologyEngine.getBlackHatPoreDensity(roi),
          melanin: DermatologyEngine.getMelaninIndex(roi),
          yellowness: DermatologyEngine.getYellownessIndex(roi),
          hemoglobin: hemoglobin,
          fatigueEAR: DermatologyEngine.getEyeAspectRatio(eyeLandmarks),
          heartRate: this.lastHeartRate,
        };
        this.updateDermUI(results);
      }
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

      this.isProcessing = false;
    }
  }

  private updateDermUI(data: {
    luminance: number;
    erythema: number;
    poreDensity: number;
    melanin: number;
    yellowness: number;
    hemoglobin: number;
    fatigueEAR: number;
    heartRate: number;
  }) {
    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };

    const setStatus = (id: string, value: number, lowThresh: number, highThresh: number) => {
      const el = document.getElementById(id);
      if (!el) return;

      if (value > highThresh) {
        el.innerHTML = `<span class="status-badge status-high">Elevated</span>`;
      } else if (value < lowThresh) {
        el.innerHTML = `<span class="status-badge status-low">Low</span>`;
      } else {
        el.innerHTML = `<span class="status-badge status-normal">Normal</span>`;
      }
    };

    const setInverseStatus = (id: string, value: number, lowThresh: number) => {
      const el = document.getElementById(id);
      if (!el) return;

      if (value < lowThresh) {
        el.innerHTML = `<span class="status-badge status-high">Fatigued</span>`;
      } else {
        el.innerHTML = `<span class="status-badge status-normal">Awake</span>`;
      }
    };

    setText('val-erythema', data.erythema.toFixed(1));
    setText('val-luminance', Math.round(data.luminance).toLocaleString());
    setText('val-melanin', data.melanin.toFixed(2));
    setText('val-pores', data.poreDensity.toFixed(1) + '%');
    setText('val-yellowness', data.yellowness.toFixed(1));
    setText('val-hemoglobin', Math.round(data.hemoglobin).toString());
    setText('val-fatigue', data.fatigueEAR.toFixed(3));

    // Heart Rate Display Logic
    if (data.heartRate === 0) {
      setText('val-heartrate', 'Calibrating...');
      const statEl = document.getElementById('stat-heartrate');
      if (statEl) statEl.innerHTML = `<span class="status-badge status-normal">Buffering</span>`;
    } else {
      setText('val-heartrate', Math.round(data.heartRate).toString() + ' BPM');
      setStatus('stat-heartrate', data.heartRate, 60, 100); // Standard resting HR thresholds
    }

    setStatus('stat-erythema', data.erythema, 90, 150);
    setStatus('stat-luminance', data.luminance, 1000, 3500);
    setStatus('stat-melanin', data.melanin, 5, 25);
    setStatus('stat-pores', data.poreDensity, 2, 10);
    setStatus('stat-yellowness', data.yellowness, 110, 140);
    setStatus('stat-hemoglobin', data.hemoglobin, 50, 150);
    setInverseStatus('stat-fatigue', data.fatigueEAR, 0.2);
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
