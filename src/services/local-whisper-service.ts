/**
 * Client-Side Whisper Service — Uses Hugging Face Transformers.js (@xenova/transformers)
 * to transcribe speech 100% locally in the browser with 0 API calls and $0 server cost.
 */

import { pipeline, env } from '@xenova/transformers';

// Configure transformers for browser environment
env.allowLocalModels = false; // load from HuggingFace CDN on first run
env.useBrowserCache = true; // cache ONNX model in IndexedDB for instant subsequent loads

let transcriberPromise: Promise<any> | null = null;

/**
 * Lazy load and cache the ONNX Whisper model (whisper-tiny.en ~39MB)
 */
export async function getTranscriber(onProgress?: (progress: number) => void) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true,
      progress_callback: (info: any) => {
        if (info.status === 'progress' && typeof info.progress === 'number' && onProgress) {
          onProgress(info.progress);
        }
      },
    });
  }
  return transcriberPromise;
}

/**
 * Preload the local Whisper model into browser cache ahead of time.
 */
export function preloadLocalWhisper() {
  getTranscriber().catch((err) => {
    console.warn('Whisper preload silent error:', err);
  });
}

/**
 * Convert recorded audio Blob (webm/wav/mp4) into 16kHz mono Float32Array PCM required by Whisper.
 */
export async function audioBlobToFloat32Array(audioBlob: Blob): Promise<Float32Array> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  // 1. Decode audio with standard AudioContext
  const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioCtxClass();
  let decodedBuffer: AudioBuffer;

  try {
    decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }

  const targetSampleRate = 16000;
  const originalSampleRate = decodedBuffer.sampleRate;

  let pcm: Float32Array;
  // If already 16kHz, return mono channel data
  if (originalSampleRate === targetSampleRate) {
    pcm = decodedBuffer.getChannelData(0);
  } else {
    // 2. Resample to 16,000 Hz using OfflineAudioContext (Web Audio API standard)
    const numberOfFrames = Math.ceil(decodedBuffer.duration * targetSampleRate);
    const OfflineCtxClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtxClass(1, numberOfFrames > 0 ? numberOfFrames : 1, targetSampleRate);

    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    const resampledBuffer = await offlineCtx.startRendering();
    pcm = resampledBuffer.getChannelData(0);
  }

  // Peak normalize gain to boost quiet earphone/headset mic recordings
  let maxAbs = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]);
    if (abs > maxAbs) maxAbs = abs;
  }
  if (maxAbs > 0.001 && maxAbs < 0.7) {
    const scale = 0.8 / maxAbs;
    const normalized = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      normalized[i] = pcm[i] * scale;
    }
    return normalized;
  }

  return pcm;
}

/**
 * Transcribe recorded audio completely client-side using WebAssembly / ONNX.
 */
export async function transcribeAudioClientSide(
  audioBlob: Blob,
  onStatusUpdate?: (status: string) => void
): Promise<string> {
  if (onStatusUpdate) onStatusUpdate('Loading local Whisper AI model...');

  const transcriber = await getTranscriber((progress) => {
    if (onStatusUpdate) onStatusUpdate(`Downloading local Whisper AI: ${Math.round(progress)}%`);
  });

  if (onStatusUpdate) onStatusUpdate('Transcribing speech locally (0 API calls)...');

  const float32Audio = await audioBlobToFloat32Array(audioBlob);

  const output = await transcriber(float32Audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'english',
    task: 'transcribe',
  });

  const resultText = Array.isArray(output) ? output.map((o: any) => o.text).join(' ') : output?.text || '';
  return resultText.trim();
}
