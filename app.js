(function initialiseScanner() {
  'use strict';

  const Core = window.YgoScannerCore;
  const Excel = window.YgoExcel;
  const STORAGE_KEY = 'ygoscanner_entries';
  const STORAGE_META_KEY = 'ygoscanner_entries_saved_at';
  const INDEXED_DB_NAME = 'ygoscanner';
  const INDEXED_DB_STORE = 'state';
  const INDEXED_DB_KEY = 'entries';
  const INDEXED_DB_VERSION = 1;
  const API_BASE = 'https://db.ygoprodeck.com/api/v7';
  const CARD_RATIO = 59 / 86;

  const elements = {
    openCameraBtn: document.getElementById('openCameraBtn'),
    scanListBtn: document.getElementById('scanListBtn'),
    exportBtn: document.getElementById('exportBtn'),
    clearBtn: document.getElementById('clearBtn'),
    fileInput: document.getElementById('fileInput'),
    video: document.getElementById('video'),
    canvas: document.getElementById('canvas'),
    capturedPreview: document.getElementById('capturedPreview'),
    scanBtn: document.getElementById('scanBtn'),
    uploadBtn: document.getElementById('uploadBtn'),
    closeCameraBtn: document.getElementById('closeCameraBtn'),
    homeScreen: document.querySelector('.home-screen'),
    scannerScreen: document.querySelector('.scanner-screen'),
    entriesPanel: document.querySelector('.entries-panel'),
    entriesTableBody: document.querySelector('#entriesTable tbody'),
    scanListBack: document.getElementById('scanListBack'),
    guideWindow: document.querySelector('.guide-window'),
    scanStageBadge: document.getElementById('scanStageBadge'),
    scanResult: document.getElementById('scanResult'),
    status: document.getElementById('status'),
    homeStatus: document.getElementById('homeStatus'),
    cameraStatusOverlay: document.getElementById('cameraStatusOverlay'),
    cameraStatusText: document.getElementById('cameraStatusText'),
    scanProgress: document.getElementById('scanProgress'),
    scanProgressText: document.getElementById('scanProgressText'),
    scanCount: document.getElementById('scanCount'),
    cameraDebugOverlay: document.getElementById('cameraDebugOverlay'),
    cameraDebugBody: document.getElementById('cameraDebugBody'),
    debugInfo: document.getElementById('debugInfo'),
    debugInfoBody: document.getElementById('debugInfoBody'),
    ocrNamePreview: document.getElementById('ocrNamePreview'),
    manualSetModal: document.getElementById('manualSetModal'),
    manualSetDescription: document.getElementById('manualSetDescription'),
    manualSetInput: document.getElementById('manualSetInput'),
    manualSetError: document.getElementById('manualSetError'),
    manualSetConfirm: document.getElementById('manualSetConfirm'),
    manualSetCancel: document.getElementById('manualSetCancel')
  };

  let stream = null;
  let entries = loadStoredEntries();
  let persistenceHydrationPromise = null;
  let persistenceWriteChain = Promise.resolve();
  let sessionScanCount = 0;
  let isScanning = false;
  let activeRunId = 0;
  let pendingManualMatch = null;
  let activeFetchController = null;
  let ocrWorkerPromise = null;
  let resolvedOcrWorker = null;
  let ocrProgressRange = { start: 10, end: 40 };
  const apiCache = new Map();
  const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
  const debugState = {};

  class ScanCancelledError extends Error {
    constructor() {
      super('Scan geannuleerd');
      this.name = 'ScanCancelledError';
    }
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
    }
  }

  function loadStoredEntries() {
    if (!Core) return [];
    try {
      const primaryPayload = localStorage.getItem(STORAGE_KEY);
      const primaryEntries = Core.loadEntriesPayload(primaryPayload);
      if (primaryEntries.length) return primaryEntries;

      const backupPayload = localStorage.getItem(`${STORAGE_KEY}_backup`);
      return Core.loadEntriesPayload(backupPayload);
    } catch (error) {
      console.warn('Opgeslagen scanlijst kon niet worden geladen.', error);
      return [];
    }
  }

  function openPersistenceDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const request = window.indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(INDEXED_DB_STORE)) {
            db.createObjectStore(INDEXED_DB_STORE);
          }
        };
        request.onsuccess = () => finish(request.result);
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch (error) {
        finish(null);
      }
    });
  }

  async function readIndexedDbState() {
    const db = await openPersistenceDb();
    if (!db) return null;
    return new Promise(resolve => {
      let transaction;
      try {
        transaction = db.transaction(INDEXED_DB_STORE, 'readonly');
        const request = transaction.objectStore(INDEXED_DB_STORE).get(INDEXED_DB_KEY);
        request.onsuccess = () => {
          const value = request.result;
          db.close();
          resolve(value && typeof value === 'object' ? value : null);
        };
        request.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch (error) {
        try { db.close(); } catch (closeError) { /* noop */ }
        resolve(null);
      }
    });
  }

  async function writeIndexedDbState(payload, savedAt) {
    const db = await openPersistenceDb();
    if (!db) return false;
    return new Promise(resolve => {
      let transaction;
      try {
        transaction = db.transaction(INDEXED_DB_STORE, 'readwrite');
        transaction.objectStore(INDEXED_DB_STORE).put({ payload, savedAt }, INDEXED_DB_KEY);
        transaction.oncomplete = () => {
          db.close();
          resolve(true);
        };
        transaction.onerror = () => {
          db.close();
          resolve(false);
        };
        transaction.onabort = () => {
          db.close();
          resolve(false);
        };
      } catch (error) {
        try { db.close(); } catch (closeError) { /* noop */ }
        resolve(false);
      }
    });
  }

  async function hydratePersistentEntries() {
    if (!Core || persistenceHydrationPromise) return persistenceHydrationPromise;
    persistenceHydrationPromise = (async () => {
      try {
        const stored = await readIndexedDbState();
        if (!stored || typeof stored.payload !== 'string') return;
        const indexedEntries = Core.loadEntriesPayload(stored.payload);
        if (!indexedEntries.length) return;
        const localSavedAt = Number(localStorage.getItem(STORAGE_META_KEY) || 0);
        const indexedSavedAt = Number(stored.savedAt || 0);
        const canRestoreNewerState = indexedSavedAt > localSavedAt;
        const canRecoverWithoutLocalTimestamp = localSavedAt === 0 && indexedEntries.length > entries.length;
        if (canRestoreNewerState || canRecoverWithoutLocalTimestamp) {
          entries = indexedEntries;
          try {
            localStorage.setItem(STORAGE_KEY, Core.serializeState({ version: Core.STATE_VERSION, entries }));
            localStorage.setItem(`${STORAGE_KEY}_backup`, Core.serializeState({ version: Core.STATE_VERSION, entries }));
            localStorage.setItem(STORAGE_META_KEY, String(indexedSavedAt || Date.now()));
          } catch (error) {
            console.warn('IndexedDB-scanlijst kon niet naar localStorage worden teruggezet.', error);
          }
          renderEntries();
          const total = totalCardCount();
          setHomeStatus(`${total} kaart${total === 1 ? '' : 'en'} hersteld uit de blijvende opslag.`);
        }
      } catch (error) {
        console.warn('Blijvende scanlijst kon niet worden geladen.', error);
      }
    })();
    return persistenceHydrationPromise;
  }

  function saveEntries() {
    let payload = '';
    let savedAt = Date.now();
    try {
      payload = Core
        ? Core.serializeState({ version: Core.STATE_VERSION, entries })
        : JSON.stringify({ version: 1, entries });
      localStorage.setItem(STORAGE_KEY, payload);
      localStorage.setItem(`${STORAGE_KEY}_backup`, payload);
      localStorage.setItem(STORAGE_META_KEY, String(savedAt));
    } catch (error) {
      console.warn('Scanlijst kon niet volledig in localStorage worden opgeslagen.', error);
      setStatusDetail('De kaart is herkend; de blijvende opslag neemt het over. Exporteer de lijst zodra je klaar bent.');
      return false;
    }

    persistenceWriteChain = persistenceWriteChain
      .catch(() => {})
      .then(() => writeIndexedDbState(payload, savedAt))
      .catch(error => {
        console.warn('Scanlijst kon niet in IndexedDB worden opgeslagen.', error);
      });
    return true;
  }

  function totalCardCount() {
    return entries.reduce((total, entry) => total + Math.max(1, Number(entry.quantity) || 1), 0);
  }

  function setStatusDetail(message) {
    if (elements.status) elements.status.textContent = message;
  }

  function setHomeStatus(message) {
    if (elements.homeStatus) elements.homeStatus.textContent = message || '';
  }

  function setProgress(value) {
    const safeValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (elements.scanProgress) {
      elements.scanProgress.value = safeValue;
      elements.scanProgress.setAttribute('aria-valuenow', String(safeValue));
    }
    if (elements.scanProgressText) elements.scanProgressText.textContent = `${safeValue}%`;
  }

  function setScanStage(message, tone = 'info', progress, detail) {
    if (typeof progress === 'number') setProgress(progress);
    if (elements.scanStageBadge) {
      elements.scanStageBadge.textContent = message;
      elements.scanStageBadge.className = `scan-stage-badge ${tone}`;
    }
    if (elements.cameraStatusText) elements.cameraStatusText.textContent = message;
    if (elements.cameraStatusOverlay) elements.cameraStatusOverlay.className = `camera-status-overlay ${tone}`;
    if (detail) setStatusDetail(detail);
  }

  function setResult(message) {
    if (elements.scanResult) elements.scanResult.textContent = message;
  }

  function setGuideTone(tone) {
    if (!elements.guideWindow) return;
    elements.guideWindow.classList.remove('success', 'error');
    if (tone === 'success' || tone === 'error') elements.guideWindow.classList.add(tone);
  }

  function updateScanCounter() {
    if (!elements.scanCount) return;
    const total = totalCardCount();
    const sessionLabel = sessionScanCount === 1 ? '1 deze sessie' : `${sessionScanCount} deze sessie`;
    const totalLabel = total === 1 ? '1 kaart totaal' : `${total} kaarten totaal`;
    elements.scanCount.textContent = `${sessionLabel} · ${totalLabel}`;
  }

  function updateDebug(patch) {
    if (!debugEnabled) return;
    Object.assign(debugState, patch);
    renderDebug();
  }

  function renderDebugRows(container) {
    if (!container) return;
    container.replaceChildren();
    Object.entries(debugState).forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = container === elements.cameraDebugBody ? 'camera-debug-row' : 'debug-info-row';
      const key = document.createElement('span');
      key.className = container === elements.cameraDebugBody ? 'camera-debug-label' : 'debug-info-label';
      key.textContent = label;
      const output = document.createElement('span');
      output.className = container === elements.cameraDebugBody ? 'camera-debug-value' : 'debug-info-value';
      output.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
      row.append(key, output);
      container.appendChild(row);
    });
  }

  function renderDebug() {
    renderDebugRows(elements.cameraDebugBody);
    renderDebugRows(elements.debugInfoBody);
  }

  function resetDebug() {
    Object.keys(debugState).forEach(key => delete debugState[key]);
    updateDebug({
      'Foto': '—',
      'Naam-OCR': '—',
      'Naamkandidaten': '—',
      'API-zoekopdracht': '—',
      'Setcode-OCR': '—',
      'Setcodekandidaten': '—',
      'Gekozen kaart': '—',
      'Reden': '—'
    });
  }

  function createCanvas(width, height) {
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(width));
    output.height = Math.max(1, Math.round(height));
    return output;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function cropCanvas(source, region) {
    const x = clamp(Math.round(region.x), 0, Math.max(0, source.width - 1));
    const y = clamp(Math.round(region.y), 0, Math.max(0, source.height - 1));
    const width = clamp(Math.round(region.width), 1, source.width - x);
    const height = clamp(Math.round(region.height), 1, source.height - y);
    const output = createCanvas(width, height);
    output.getContext('2d', { alpha: false }).drawImage(source, x, y, width, height, 0, 0, width, height);
    return output;
  }

  function cropFraction(source, x, y, width, height) {
    return cropCanvas(source, {
      x: source.width * x,
      y: source.height * y,
      width: source.width * width,
      height: source.height * height
    });
  }

  function getGuideCropRegion(frameCanvas) {
    if (!elements.video || !elements.guideWindow || !elements.video.videoWidth || !elements.video.videoHeight) {
      return null;
    }
    const videoRect = elements.video.getBoundingClientRect();
    const guideRect = elements.guideWindow.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height || !guideRect.width || !guideRect.height) return null;

    // CSS uses object-fit: cover, so the larger scale controls what part of the source is visible.
    const scale = Math.max(videoRect.width / frameCanvas.width, videoRect.height / frameCanvas.height);
    const renderedWidth = frameCanvas.width * scale;
    const renderedHeight = frameCanvas.height * scale;
    const offsetX = (videoRect.width - renderedWidth) / 2;
    const offsetY = (videoRect.height - renderedHeight) / 2;
    const sourceX = (guideRect.left - videoRect.left - offsetX) / scale;
    const sourceY = (guideRect.top - videoRect.top - offsetY) / scale;
    const sourceWidth = guideRect.width / scale;
    const sourceHeight = guideRect.height / scale;

    if (sourceWidth < 80 || sourceHeight < 120) return null;
    return {
      x: clamp(sourceX, 0, frameCanvas.width - 1),
      y: clamp(sourceY, 0, frameCanvas.height - 1),
      width: clamp(sourceWidth, 1, frameCanvas.width - sourceX),
      height: clamp(sourceHeight, 1, frameCanvas.height - sourceY)
    };
  }

  function centreCropToCard(source) {
    const sourceRatio = source.width / source.height;
    let width = source.width;
    let height = source.height;
    if (sourceRatio > CARD_RATIO) width = height * CARD_RATIO;
    else height = width / CARD_RATIO;
    return cropCanvas(source, {
      x: (source.width - width) / 2,
      y: (source.height - height) / 2,
      width,
      height
    });
  }

  function percentileFromHistogram(histogram, total, fraction) {
    const target = total * fraction;
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return fraction < 0.5 ? 0 : 255;
  }

  function otsuThreshold(histogram, total) {
    let weightedTotal = 0;
    for (let value = 0; value < 256; value += 1) weightedTotal += value * histogram[value];
    let backgroundWeight = 0;
    let backgroundSum = 0;
    let bestVariance = -1;
    let threshold = 128;
    for (let value = 0; value < 256; value += 1) {
      backgroundWeight += histogram[value];
      if (!backgroundWeight) continue;
      const foregroundWeight = total - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += value * histogram[value];
      const backgroundMean = backgroundSum / backgroundWeight;
      const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        threshold = value;
      }
    }
    return threshold;
  }

  function preprocessTextCanvas(source, options = {}) {
    const targetWidth = options.targetWidth || 1400;
    const scale = clamp(targetWidth / Math.max(1, source.width), 2, 5);
    const innerWidth = Math.max(1, Math.round(source.width * scale));
    const innerHeight = Math.max(1, Math.round(source.height * scale));
    const working = createCanvas(innerWidth, innerHeight);
    const context = working.getContext('2d', { alpha: false, willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, innerWidth, innerHeight);
    const imageData = context.getImageData(0, 0, innerWidth, innerHeight);
    const data = imageData.data;
    const histogram = new Uint32Array(256);
    let luminanceTotal = 0;

    for (let index = 0; index < data.length; index += 4) {
      const luminance = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
      histogram[luminance] += 1;
      luminanceTotal += luminance;
    }
    const pixels = data.length / 4;
    const low = percentileFromHistogram(histogram, pixels, 0.02);
    const high = Math.max(low + 20, percentileFromHistogram(histogram, pixels, 0.98));
    const invert = luminanceTotal / Math.max(1, pixels) < 105;
    const stretchedHistogram = new Uint32Array(256);

    for (let index = 0; index < data.length; index += 4) {
      const luminance = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
      let adjusted = clamp(Math.round(((luminance - low) * 255) / (high - low)), 0, 255);
      if (invert) adjusted = 255 - adjusted;
      data[index] = adjusted;
      data[index + 1] = adjusted;
      data[index + 2] = adjusted;
      data[index + 3] = 255;
      stretchedHistogram[adjusted] += 1;
    }

    if (options.binary) {
      const threshold = otsuThreshold(stretchedHistogram, pixels);
      for (let index = 0; index < data.length; index += 4) {
        const value = data[index] > threshold ? 255 : 0;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
      }
    }
    context.putImageData(imageData, 0, 0);

    const padding = 24;
    const output = createCanvas(innerWidth + padding * 2, innerHeight + padding * 2);
    const outputContext = output.getContext('2d', { alpha: false });
    outputContext.fillStyle = '#ffffff';
    outputContext.fillRect(0, 0, output.width, output.height);
    outputContext.drawImage(working, padding, padding);
    return output;
  }

  function handleOcrProgress(message) {
    if (!message || typeof message.progress !== 'number') return;
    const span = ocrProgressRange.end - ocrProgressRange.start;
    setProgress(ocrProgressRange.start + span * message.progress);
  }

  async function getOcrWorker() {
    if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
      throw new Error('De OCR-module kon niet worden geladen. Controleer de internetverbinding en laad de app opnieuw.');
    }
    if (!ocrWorkerPromise) {
      setScanStage('Tekstherkenning laden', 'info', 10, 'De OCR-module wordt eenmalig voorbereid. De eerste scan kan iets langer duren.');
      ocrWorkerPromise = window.Tesseract.createWorker('eng', 1, { logger: handleOcrProgress })
        .then(worker => {
          resolvedOcrWorker = worker;
          return worker;
        })
        .catch(error => {
          ocrWorkerPromise = null;
          resolvedOcrWorker = null;
          throw error;
        });
    }
    return ocrWorkerPromise;
  }

  async function runOcr(image, parameters, range) {
    ocrProgressRange = range;
    const worker = await getOcrWorker();
    await worker.setParameters(parameters);
    return worker.recognize(image);
  }

  async function readCardName(cardCanvas) {
    const region = cropFraction(cardCanvas, 0.045, 0.025, 0.82, 0.115);
    const processed = preprocessTextCanvas(region, { targetWidth: 1500, binary: false });
    if (elements.ocrNamePreview) elements.ocrNamePreview.src = processed.toDataURL('image/png');
    const result = await runOcr(processed, {
      tessedit_pageseg_mode: '7',
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '&-:,.()",
      preserve_interword_spaces: '1'
    }, { start: 15, end: 45 });
    const rawText = String(result && result.data && result.data.text || '').trim();
    const candidates = Core ? Core.extractNameCandidates(rawText) : [rawText].filter(Boolean);
    updateDebug({
      'Naam-OCR': rawText || 'geen tekst',
      'Naamkandidaten': candidates.join(' | ') || 'geen',
      'Naam-confidence': Math.round(Number(result && result.data && result.data.confidence) || 0)
    });
    return { rawText, candidates };
  }

  function buildSetCodeOcrVariants(cardCanvas) {
    // De set-code staat bij Yu-Gi-Oh!-kaarten doorgaans laag en rechts.
    // We scannen daarom meerdere overlappende zones in het onderste kwart,
    // met één bredere fallback voor uitzonderlijke layouts.
    const regions = [
      { x: 0.50, y: 0.76, width: 0.47, height: 0.11, targetWidth: 2200, binary: false, psm: '7' },
      { x: 0.57, y: 0.80, width: 0.40, height: 0.10, targetWidth: 2400, binary: true, psm: '7' },
      { x: 0.40, y: 0.78, width: 0.57, height: 0.15, targetWidth: 2200, binary: false, psm: '11' },
      { x: 0.62, y: 0.74, width: 0.35, height: 0.18, targetWidth: 2200, binary: false, psm: '6' },
      { x: 0.46, y: 0.83, width: 0.50, height: 0.09, targetWidth: 2400, binary: true, psm: '7' },
      { x: 0.20, y: 0.75, width: 0.77, height: 0.22, targetWidth: 2000, binary: false, psm: '11' }
    ];
    return regions.map(region => ({
      image: preprocessTextCanvas(
        cropFraction(cardCanvas, region.x, region.y, region.width, region.height),
        { targetWidth: region.targetWidth, binary: region.binary }
      ),
      psm: region.psm || (region.binary ? '7' : '6')
    }));
  }

  function rankSetCodeCandidates(candidates, expectedSetCodes) {
    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const normalized = Core ? Core.normalizeSetCode(candidate) : String(candidate || '').trim().toUpperCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      let bestSimilarity = 0;
      let exact = false;
      for (const expected of expectedSetCodes) {
        if (!Core) continue;
        const comparison = Core.compareSetCodeCandidate(normalized, expected);
        if (comparison.score > bestSimilarity) bestSimilarity = comparison.score;
        if (comparison.exact) exact = true;
      }
      unique.push({ code: normalized, bestSimilarity, exact });
    }
    unique.sort((left, right) => (
      Number(right.exact) - Number(left.exact)
      || right.bestSimilarity - left.bestSimilarity
      || left.code.localeCompare(right.code, 'en')
    ));
    return unique.map(item => item.code);
  }

  async function readSetCode(cardCanvas, referenceCards = []) {
    const variants = buildSetCodeOcrVariants(cardCanvas);
    const expectedSetCodes = [];
    const expectedSeen = new Set();
    for (const card of referenceCards) {
      const printings = Array.isArray(card && card.card_sets) ? card.card_sets : [];
      for (const printing of printings) {
        const value = Core ? Core.normalizeSetCode(printing.set_code || printing.setCode || '') : '';
        if (value && !expectedSeen.has(value)) {
          expectedSeen.add(value);
          expectedSetCodes.push(value);
        }
      }
    }

    const rawParts = [];
    const candidatePool = [];
    let confidenceTotal = 0;
    let confidenceCount = 0;
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      const start = 62 + Math.round(index * 24 / variants.length);
      const end = Math.min(86, 62 + Math.round((index + 1) * 24 / variants.length));
      const result = await runOcr(variant.image, {
        tessedit_pageseg_mode: variant.psm,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
        preserve_interword_spaces: '1'
      }, { start, end });
      const raw = String(result && result.data && result.data.text || '').trim().toUpperCase();
      if (raw) rawParts.push(raw);
      const confidence = Number(result && result.data && result.data.confidence);
      if (Number.isFinite(confidence)) {
        confidenceTotal += confidence;
        confidenceCount += 1;
      }
      if (Core && raw) candidatePool.push(...Core.extractSetCodeCandidates(raw));
    }

    const rawText = rawParts.join(' | ');
    const candidates = rankSetCodeCandidates(candidatePool, expectedSetCodes);
    updateDebug({
      'Setcode-OCR': rawText || 'geen tekst',
      'Setcode-kandidaten': candidates.join(' | ') || 'geen',
      'Setcode-confidence': confidenceCount ? Math.round(confidenceTotal / confidenceCount) : 0,
      'Setcode-scans': variants.length,
      'Bekende setcodes na naam': expectedSetCodes.length
    });
    return { rawText, candidates };
  }

  function assertActiveRun(runId) {
    if (runId !== activeRunId) throw new ScanCancelledError();
  }

  async function fetchJson(url, runId) {
    const cacheKey = String(url);
    if (apiCache.has(cacheKey)) return apiCache.get(cacheKey);

    if (activeFetchController) activeFetchController.abort();
    const controller = new AbortController();
    activeFetchController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      assertActiveRun(runId);
      if (!response.ok) {
        if (response.status === 400 || response.status === 404) {
          apiCache.set(cacheKey, null);
          return null;
        }
        if (response.status === 429) throw new ApiError('De kaartdatabase krijgt te veel verzoeken. Wacht even en probeer opnieuw.', 429);
        throw new ApiError(`De kaartdatabase antwoordde met fout ${response.status}.`, response.status);
      }
      const json = await response.json();
      apiCache.set(cacheKey, json);
      return json;
    } catch (error) {
      if (error instanceof ScanCancelledError || error instanceof ApiError) throw error;
      if (error && error.name === 'AbortError') throw new ApiError('De kaartdatabase reageerde niet op tijd. Probeer opnieuw.', 0);
      throw new ApiError('Geen verbinding met de kaartdatabase. Controleer de internetverbinding.', 0);
    } finally {
      window.clearTimeout(timeout);
      if (activeFetchController === controller) activeFetchController = null;
    }
  }

  function uniqueCleanNames(candidates) {
    const output = [];
    const seen = new Set();
    candidates.forEach(candidate => {
      const cleaned = Core ? Core.cleanCardNameForApi(candidate) : String(candidate || '').trim();
      const key = cleaned.toLocaleLowerCase('en');
      if (cleaned.length >= 2 && !seen.has(key)) {
        seen.add(key);
        output.push(cleaned);
      }
    });
    return output;
  }

  function reducedNameTerm(name) {
    const words = String(name || '').split(/\s+/).filter(word => /[A-Za-z0-9]/.test(word));
    const useful = words.filter(word => word.replace(/[^A-Za-z0-9]/g, '').length >= 3);
    if (!useful.length) return '';
    if (useful.length > 1 && useful.join(' ') !== name) return useful.join(' ');
    if (useful.length > 1) {
      const pairs = useful.slice(0, -1).map((word, index) => `${word} ${useful[index + 1]}`);
      return pairs.sort((left, right) => right.length - left.length)[0];
    }
    return [...useful].sort((left, right) => right.length - left.length)[0];
  }

  function cardsFromResponse(json) {
    return json && Array.isArray(json.data) ? json.data : [];
  }

  async function fetchCardsByName(nameCandidates, runId) {
    const names = uniqueCleanNames(nameCandidates);
    if (!names.length) return { cards: [], query: '', error: null };
    const searches = [];
    const seen = new Set();
    const addSearch = (parameter, term) => {
      const cleaned = String(term || '').trim();
      const key = `${parameter}:${cleaned.toLocaleLowerCase('en')}`;
      if (cleaned.length >= 2 && !seen.has(key) && searches.length < 5) {
        seen.add(key);
        searches.push({ parameter, term: cleaned });
      }
    };

    addSearch('name', names[0]);
    names.slice(0, 2).forEach(name => addSearch('fname', name));
    names.slice(0, 2).forEach(name => addSearch('fname', reducedNameTerm(name)));

    let lastError = null;
    for (const search of searches) {
      assertActiveRun(runId);
      const parameters = new URLSearchParams({ [search.parameter]: search.term });
      if (search.parameter === 'fname') parameters.set('num', '100');
      const url = `${API_BASE}/cardinfo.php?${parameters.toString()}`;
      updateDebug({ 'API-zoekopdracht': `${search.parameter}=${search.term}` });
      try {
        const json = await fetchJson(url, runId);
        const cards = cardsFromResponse(json);
        if (cards.length) return { cards, query: `${search.parameter}=${search.term}`, error: null };
      } catch (error) {
        lastError = error;
        if (error.status === 429 || error.status >= 500 || error.status === 0) break;
      }
    }
    return { cards: [], query: searches.map(item => `${item.parameter}=${item.term}`).join(', '), error: lastError };
  }

  function printingRecordFromResponse(json) {
    if (!json) return null;
    if (Array.isArray(json)) return json[0] || null;
    if (Array.isArray(json.data)) return json.data[0] || null;
    return typeof json === 'object' ? json : null;
  }

  async function fetchPrintingBySetCode(setCode, runId) {
    const normalized = Core ? Core.normalizeSetCode(setCode) : String(setCode || '').trim().toUpperCase();
    if (!normalized || !normalized.includes('-')) return null;
    const parameters = new URLSearchParams({ setcode: normalized });
    const json = await fetchJson(`${API_BASE}/cardsetsinfo.php?${parameters.toString()}`, runId);
    const record = printingRecordFromResponse(json);
    if (!record || !record.name || !(record.set_code || record.setCode)) return null;
    const printing = {
      set_code: record.set_code || record.setCode,
      set_name: record.set_name || record.setName || '',
      set_rarity: record.set_rarity || record.setRarity || '',
      set_price: record.set_price || record.setPrice || ''
    };
    return {
      card: { name: record.name, card_sets: [printing], card_images: [] },
      printing,
      setCodeMatched: true,
      confidence: 'high',
      confidenceScore: 1,
      reason: 'exacte set-code gevonden via de setdatabase'
    };
  }

  function bestNameScore(nameCandidates, officialName) {
    if (!Core || !nameCandidates.length) return 0;
    return nameCandidates.reduce((best, candidate) => {
      const comparison = Core.compareCardNames(candidate, officialName);
      return Math.max(best, Number(comparison.score) || 0);
    }, 0);
  }

  async function directSetCodeFallback(setCandidates, nameCandidates, runId) {
    for (const candidate of setCandidates.slice(0, 3)) {
      try {
        const match = await fetchPrintingBySetCode(candidate, runId);
        if (!match) continue;
        const nameScore = bestNameScore(nameCandidates, match.card.name || '');
        if (!nameCandidates.length || nameScore >= 0.62) return match;
      } catch (error) {
        if (error instanceof ScanCancelledError || (error instanceof ApiError && error.status !== 400)) throw error;
      }
    }
    return null;
  }

  function addEntryFromMatch(match, rawText) {
    const card = match.card || {};
    const printing = match.printing || {};
    const name = String(card.name || 'Onbekende kaart').trim();
    const setCode = Core
      ? Core.normalizeSetCode(printing.set_code || printing.setCode || '')
      : String(printing.set_code || printing.setCode || '').trim().toUpperCase();
    if (!setCode) throw new Error('De gekozen kaartdruk heeft geen set-code.');
    const normalizedName = Core ? Core.normalizeCardName(name) : name.toLocaleLowerCase('en');
    const now = new Date().toISOString();
    const existing = entries.find(entry => (
      String(entry.setCode || '').toUpperCase() === setCode
      && (Core ? Core.normalizeCardName(entry.name || '') : String(entry.name || '').toLocaleLowerCase('en')) === normalizedName
    ));

    if (existing) {
      existing.quantity = Math.max(1, Number(existing.quantity) || 1) + 1;
      existing.scannedAt = now;
      existing.setName = printing.set_name || printing.setName || existing.setName || '';
      existing.rarity = printing.set_rarity || printing.setRarity || existing.rarity || '';
      existing.confidence = match.confidence || existing.confidence || 'high';
      existing.rawText = rawText || existing.rawText || '';
    } else {
      entries.unshift({
        name,
        setCode,
        value: '',
        setName: printing.set_name || printing.setName || '',
        rarity: printing.set_rarity || printing.setRarity || '',
        edition: 'Onbekend',
        quantity: 1,
        scannedAt: now,
        scannedDate: now,
        rawText: rawText || '',
        image: '',
        confidence: match.confidence || 'high'
      });
    }
    saveEntries();
    sessionScanCount += 1;
    renderEntries();
    updateScanCounter();
    const total = totalCardCount();
    setHomeStatus(`${total} kaart${total === 1 ? '' : 'en'} klaar voor Excel-export.`);
    updateDebug({
      'Gekozen kaart': `${name} — ${setCode}`,
      'Reden': match.reason || 'naam en set-code komen overeen'
    });
    return { name, setCode };
  }

  function completeSuccessfulScan(match, rawText) {
    const saved = addEntryFromMatch(match, rawText);
    setGuideTone('success');
    setResult(`${saved.name} — ${saved.setCode}`);
    setScanStage(`Opgeslagen: ${saved.name}`, 'success', 100, `Set-code ${saved.setCode}. De kaart staat in de scanlijst.`);
    setScanButtonMode('resume', 'Volgende kaart');
  }

  function showManualSetModal(context, message) {
    pendingManualMatch = context;
    if (!elements.manualSetModal || !elements.manualSetInput) {
      throw new Error('De set-code moet handmatig worden ingevuld, maar het invoervenster ontbreekt.');
    }
    const suggested = context.setCandidates && context.setCandidates[0] || '';
    elements.manualSetInput.value = suggested;
    elements.manualSetInput.setAttribute('aria-invalid', 'false');
    if (elements.manualSetError) elements.manualSetError.textContent = '';
    if (elements.manualSetDescription) {
      const name = context.nameCandidates && context.nameCandidates[0];
      elements.manualSetDescription.textContent = message || (
        name
          ? `Kaartnaam gelezen als “${name}”. Controleer de set-code op de foto en vul hem hieronder in.`
          : 'De set-code kon niet betrouwbaar worden gelezen. Controleer de foto en vul de code hieronder in.'
      );
    }
    elements.manualSetModal.classList.remove('hidden');
    if (elements.scanBtn) elements.scanBtn.disabled = true;
    window.requestAnimationFrame(() => {
      elements.manualSetInput.focus();
      elements.manualSetInput.select();
    });
  }

  function hideManualSetModal() {
    if (elements.manualSetModal) elements.manualSetModal.classList.add('hidden');
    if (elements.manualSetInput) {
      elements.manualSetInput.value = '';
      elements.manualSetInput.setAttribute('aria-invalid', 'false');
    }
    if (elements.manualSetError) elements.manualSetError.textContent = '';
  }

  function showManualError(message) {
    if (elements.manualSetError) elements.manualSetError.textContent = message;
    if (elements.manualSetInput) {
      elements.manualSetInput.setAttribute('aria-invalid', 'true');
      elements.manualSetInput.focus();
    }
  }

  async function confirmManualSetCode() {
    if (!pendingManualMatch || isScanning) return;
    const input = String(elements.manualSetInput && elements.manualSetInput.value || '').trim();
    const candidates = Core ? Core.extractSetCodeCandidates(input) : [];
    if (!candidates.length) {
      showManualError('Vul een volledige set-code in, bijvoorbeeld LOB-001 of RA01-EN001.');
      return;
    }

    isScanning = true;
    if (elements.manualSetConfirm) elements.manualSetConfirm.disabled = true;
    if (elements.manualSetCancel) elements.manualSetCancel.disabled = true;
    if (elements.uploadBtn) elements.uploadBtn.disabled = true;
    const runId = activeRunId;
    try {
      setScanStage('Set-code controleren', 'info', 92, 'De handmatig ingevoerde code wordt gecontroleerd in YGOPRODeck.');
      let match = null;
      if (pendingManualMatch.cards && pendingManualMatch.cards.length) {
        const localMatch = Core.selectBestCardPrinting(
          pendingManualMatch.nameCandidates,
          candidates.join(' '),
          pendingManualMatch.cards
        );
        if (localMatch && localMatch.setCodeMatched) match = localMatch;
      }
      if (!match) match = await fetchPrintingBySetCode(candidates[0], runId);
      assertActiveRun(runId);
      if (!match) {
        showManualError('Deze set-code is niet gevonden. Controleer letters, cijfers en het streepje.');
        setScanStage('Set-code niet gevonden', 'error', 88);
        return;
      }
      hideManualSetModal();
      pendingManualMatch = null;
      completeSuccessfulScan(match, input);
    } catch (error) {
      if (!(error instanceof ScanCancelledError)) {
        showManualError(error.message || 'De set-code kon niet worden gecontroleerd.');
        setScanStage('Controleren mislukt', 'error', 88);
      }
    } finally {
      isScanning = false;
      if (elements.manualSetConfirm) elements.manualSetConfirm.disabled = false;
      if (elements.manualSetCancel) elements.manualSetCancel.disabled = false;
      if (elements.uploadBtn) elements.uploadBtn.disabled = false;
      if (!pendingManualMatch && elements.scanBtn) elements.scanBtn.disabled = false;
    }
  }

  function cancelManualSetCode() {
    if (isScanning) return;
    pendingManualMatch = null;
    hideManualSetModal();
    setGuideTone('error');
    setScanStage('Niet opgeslagen', 'error', 0, 'Maak een nieuwe foto om de kaart opnieuw te proberen.');
    setScanButtonMode('resume', stream ? 'Nieuwe foto' : 'Andere foto kiezen');
    if (elements.scanBtn) elements.scanBtn.focus();
  }

  async function recogniseCard(cardCanvas, runId) {
    resetDebug();
    updateDebug({ 'Foto': `${cardCanvas.width} × ${cardCanvas.height}` });
    setResult('De foto wordt verwerkt…');
    setGuideTone(null);

    setScanStage('Kaartnaam lezen', 'info', 12, 'Stap 1 van 3: tekstherkenning van de kaartnaam.');
    const nameResult = await readCardName(cardCanvas);
    assertActiveRun(runId);

    setScanStage('Kaart opzoeken', 'info', 50, 'Stap 2 van 3: zoeken in de YGOPRODeck-database.');
    const lookup = await fetchCardsByName(nameResult.candidates, runId);
    assertActiveRun(runId);

    const referenceCards = Array.isArray(lookup.cards) ? lookup.cards : [];
    const ambiguousName = referenceCards.length > 1;
    const printingChoices = referenceCards.reduce((total, card) => (
      total + (Array.isArray(card && card.card_sets) ? card.card_sets.length : 0)
    ), 0);
    setScanStage(
      'Set-code lezen',
      'info',
      60,
      ambiguousName
        ? 'De kaartnaam geeft meerdere mogelijkheden; de set-code bepaalt nu de juiste kaart.'
        : printingChoices > 1
          ? 'De kaartnaam is gevonden; de set-code bepaalt nu de juiste kaartdruk.'
          : 'De kaartnaam is gevonden; de set-code wordt gecontroleerd voor een betrouwbare scan.'
    );
    const setCodeResult = await readSetCode(cardCanvas, referenceCards);
    assertActiveRun(runId);

    setScanStage('Resultaat controleren', 'info', 90, 'Kaartnaam en set-code worden met elkaar vergeleken.');
    let match = null;
    if (lookup.cards.length) {
      match = Core.selectBestCardPrinting(nameResult.candidates, setCodeResult.rawText, lookup.cards);
      if (match && match.setCodeMatched && match.confidence !== 'low') {
        completeSuccessfulScan(match, `${nameResult.rawText}\n${setCodeResult.rawText}`);
        return { pending: false };
      }
    }

    if (setCodeResult.candidates.length) {
      const directMatch = await directSetCodeFallback(setCodeResult.candidates, nameResult.candidates, runId);
      assertActiveRun(runId);
      if (directMatch) {
        completeSuccessfulScan(directMatch, `${nameResult.rawText}\n${setCodeResult.rawText}`);
        return { pending: false };
      }
    }

    if (lookup.error) throw lookup.error;

    if (!nameResult.candidates.length && !setCodeResult.candidates.length) {
      throw new Error('Er is geen kaartnaam of set-code gelezen. Zorg voor scherp licht en vul het hele kader met de kaart.');
    }

    const context = {
      cards: lookup.cards,
      nameCandidates: nameResult.candidates,
      setCandidates: setCodeResult.candidates,
      rawNameText: nameResult.rawText,
      rawSetText: setCodeResult.rawText
    };
    setGuideTone('error');
    setScanStage('Set-code controleren', 'info', 88, 'Controleer de set-code handmatig om de juiste kaartdruk op te slaan.');
    showManualSetModal(
      context,
      lookup.cards.length
        ? undefined
        : 'De kaartnaam leverde geen zekere databasehit op. Vul de set-code exact in; die kan de kaart alsnog uniek vinden.'
    );
    return { pending: true };
  }

  function setFrozenPreview(frameCanvas, visible) {
    if (!elements.capturedPreview) return;
    if (visible && frameCanvas) {
      elements.capturedPreview.src = frameCanvas.toDataURL('image/jpeg', 0.9);
      elements.capturedPreview.classList.remove('hidden');
    } else {
      elements.capturedPreview.classList.add('hidden');
      elements.capturedPreview.removeAttribute('src');
    }
  }

  function setScanButtonMode(mode, label) {
    if (!elements.scanBtn) return;
    elements.scanBtn.dataset.mode = mode;
    elements.scanBtn.textContent = label || (mode === 'capture' ? 'Foto maken en scannen' : 'Volgende kaart');
    elements.scanBtn.disabled = mode === 'capture' && !stream;
  }

  async function prepareNextCapture() {
    hideManualSetModal();
    pendingManualMatch = null;
    setFrozenPreview(null, false);
    setGuideTone(null);
    setProgress(0);
    if (stream && elements.video) {
      try {
        await elements.video.play();
      } catch (error) {
        console.warn('Cameravoorbeeld kon niet worden hervat.', error);
      }
      setScanStage('Camera gereed', 'info', 0, 'Leg de volledige kaart binnen het kader en maak één foto.');
      setScanButtonMode('capture', 'Foto maken en scannen');
    } else {
      setScanStage('Kies een foto', 'info', 0, 'Maak of kies een duidelijke foto waarop de volledige kaart zichtbaar is.');
      setScanButtonMode('capture', 'Foto kiezen');
      if (elements.fileInput) elements.fileInput.click();
    }
  }

  function captureVideoFrame() {
    if (!elements.video || !elements.video.videoWidth || !elements.video.videoHeight) {
      throw new Error('Het camerabeeld is nog niet gereed. Wacht een moment en probeer opnieuw.');
    }
    const frame = elements.canvas || createCanvas(elements.video.videoWidth, elements.video.videoHeight);
    frame.width = elements.video.videoWidth;
    frame.height = elements.video.videoHeight;
    frame.getContext('2d', { alpha: false }).drawImage(elements.video, 0, 0, frame.width, frame.height);
    return frame;
  }

  async function scanCard() {
    if (isScanning) return;
    if (elements.scanBtn && elements.scanBtn.dataset.mode === 'resume') {
      await prepareNextCapture();
      return;
    }
    if (!stream) {
      if (elements.fileInput) elements.fileInput.click();
      return;
    }

    isScanning = true;
    const runId = ++activeRunId;
    if (elements.scanBtn) elements.scanBtn.disabled = true;
    if (elements.uploadBtn) elements.uploadBtn.disabled = true;
    resetDebug();
    try {
      setScanStage('Foto vastleggen', 'info', 4, 'Het livebeeld wordt nu bevroren; alleen deze foto wordt gelezen.');
      const frame = captureVideoFrame();
      if (elements.video) elements.video.pause();
      setFrozenPreview(frame, true);
      const guideRegion = getGuideCropRegion(frame);
      if (!guideRegion) throw new Error('Het kaartkader kon niet aan de foto worden gekoppeld. Draai het toestel of open de camera opnieuw.');
      const cardCanvas = cropCanvas(frame, guideRegion);
      updateDebug({
        'Volledige foto': `${frame.width} × ${frame.height}`,
        'Kaartuitsnede': `${Math.round(guideRegion.x)}, ${Math.round(guideRegion.y)}, ${Math.round(guideRegion.width)} × ${Math.round(guideRegion.height)}`
      });
      const outcome = await recogniseCard(cardCanvas, runId);
      if (!outcome.pending && elements.scanBtn) elements.scanBtn.disabled = false;
    } catch (error) {
      if (!(error instanceof ScanCancelledError)) {
        console.error(error);
        setGuideTone('error');
        setResult(error.message || 'De kaart kon niet worden herkend.');
        setScanStage('Scan mislukt', 'error', 0, error.message || 'Maak een nieuwe, scherpe foto.');
        setScanButtonMode('resume', 'Nieuwe foto');
      }
    } finally {
      isScanning = false;
      if (elements.uploadBtn) elements.uploadBtn.disabled = false;
      if (!pendingManualMatch && elements.scanBtn) elements.scanBtn.disabled = false;
    }
  }

  async function decodeImageFile(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        // Fall through to the broadly supported Image element path.
      }
    }
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('De gekozen foto kon niet worden geopend.'));
      };
      image.src = objectUrl;
    });
  }

  async function handleFileUpload(file) {
    if (!file) return;
    if (isScanning) {
      if (elements.fileInput) elements.fileInput.value = '';
      return;
    }
    showScannerScreen();
    isScanning = true;
    const runId = ++activeRunId;
    if (elements.scanBtn) elements.scanBtn.disabled = true;
    if (elements.uploadBtn) elements.uploadBtn.disabled = true;
    try {
      if (!String(file.type || '').startsWith('image/')) throw new Error('Kies een foto in JPG-, PNG-, HEIC- of WebP-formaat.');
      setScanStage('Foto openen', 'info', 3, 'De gekozen foto wordt voorbereid.');
      const image = await decodeImageFile(file);
      assertActiveRun(runId);
      const frame = elements.canvas || createCanvas(image.width, image.height);
      frame.width = image.width;
      frame.height = image.height;
      frame.getContext('2d', { alpha: false }).drawImage(image, 0, 0, frame.width, frame.height);
      if (typeof image.close === 'function') image.close();
      setFrozenPreview(frame, true);
      const cardCanvas = centreCropToCard(frame);
      const outcome = await recogniseCard(cardCanvas, runId);
      if (!outcome.pending && elements.scanBtn) elements.scanBtn.disabled = false;
    } catch (error) {
      if (!(error instanceof ScanCancelledError)) {
        console.error(error);
        setGuideTone('error');
        setResult(error.message || 'De foto kon niet worden gescand.');
        setScanStage('Scan mislukt', 'error', 0, error.message || 'Kies een andere foto.');
        setScanButtonMode('resume', 'Andere foto kiezen');
      }
    } finally {
      isScanning = false;
      if (elements.fileInput) elements.fileInput.value = '';
      if (elements.uploadBtn) elements.uploadBtn.disabled = false;
      if (!pendingManualMatch && elements.scanBtn) elements.scanBtn.disabled = false;
    }
  }

  function showHomeScreen() {
    if (elements.homeScreen) elements.homeScreen.classList.remove('hidden');
    if (elements.scannerScreen) elements.scannerScreen.classList.add('hidden');
    if (elements.entriesPanel) elements.entriesPanel.classList.add('hidden');
  }

  function showScannerScreen() {
    if (elements.homeScreen) elements.homeScreen.classList.add('hidden');
    if (elements.scannerScreen) elements.scannerScreen.classList.remove('hidden');
    if (elements.entriesPanel) elements.entriesPanel.classList.add('hidden');
  }

  function showEntriesPanel() {
    if (elements.homeScreen) elements.homeScreen.classList.add('hidden');
    if (elements.scannerScreen) elements.scannerScreen.classList.add('hidden');
    if (elements.entriesPanel) elements.entriesPanel.classList.remove('hidden');
    renderEntries();
  }

  function enterFullscreenCamera() {
    showScannerScreen();
    document.body.classList.add('fullscreen-camera');
    setScanButtonMode('capture', 'Foto maken en scannen');
  }

  function exitFullscreenCamera() {
    document.body.classList.remove('fullscreen-camera');
  }

  function cameraErrorMessage(error) {
    if (!window.isSecureContext && window.location.hostname !== 'localhost') {
      return 'De camera vereist HTTPS of localhost. Gebruik voorlopig “Foto maken of kiezen”.';
    }
    if (!error) return 'De camera kon niet worden geopend. Gebruik “Foto maken of kiezen”.';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Cameratoegang is geblokkeerd. Sta de camera toe in de browserinstellingen of kies een foto.';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'Er is geen camera gevonden. Kies een bestaande foto.';
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'De camera wordt mogelijk door een andere app gebruikt. Sluit die app of kies een foto.';
    }
    return 'De camera kon niet worden geopend. Gebruik “Foto maken of kiezen”.';
  }

  async function openCamera() {
    showScannerScreen();
    setScanStage('Camera starten', 'info', 0, 'Geef cameratoegang wanneer de browser daarom vraagt.');
    setResult('Camera wordt gestart…');
    const secure = window.isSecureContext || (location.protocol === 'http:' && location.hostname === 'localhost');
    if (!secure || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const message = cameraErrorMessage(null);
      setResult(message);
      setScanStage('Foto kiezen', 'error', 0, message);
      setScanButtonMode('capture', 'Foto kiezen');
      return;
    }

    try {
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      const track = stream.getVideoTracks()[0];
      if (track && typeof track.getCapabilities === 'function') {
        const capabilities = track.getCapabilities();
        if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
          track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
      }
      elements.video.srcObject = stream;
      await elements.video.play();
      enterFullscreenCamera();
      setFrozenPreview(null, false);
      setGuideTone(null);
      setResult('Leg de volledige kaart binnen het kader.');
      setScanStage('Camera gereed', 'info', 0, 'Tik één keer op “Foto maken en scannen”.');
    } catch (error) {
      console.warn('Camera kon niet worden geopend.', error);
      stream = null;
      const message = cameraErrorMessage(error);
      setResult(message);
      setScanStage('Foto kiezen', 'error', 0, message);
      setScanButtonMode('capture', 'Foto kiezen');
    }
  }

  async function closeCamera() {
    activeRunId += 1;
    if (activeFetchController) activeFetchController.abort();
    pendingManualMatch = null;
    hideManualSetModal();
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    if (elements.video) elements.video.srcObject = null;
    isScanning = false;
    setFrozenPreview(null, false);
    exitFullscreenCamera();
    showHomeScreen();
    setGuideTone(null);
    setScanStage('Camera gesloten', 'info', 0, 'De opgeslagen scans blijven in de lijst staan.');
  }

  function formatScannedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('nl-NL', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(date);
  }

  function appendCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = String(value === null || value === undefined ? '' : value);
    row.appendChild(cell);
  }

  function renderEntries() {
    if (!elements.entriesTableBody) return;
    elements.entriesTableBody.replaceChildren();
    const sorted = [...entries].sort((left, right) => String(right.scannedAt || '').localeCompare(String(left.scannedAt || '')));
    if (!sorted.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'empty-list';
      cell.textContent = 'Nog geen kaarten gescand.';
      row.appendChild(cell);
      elements.entriesTableBody.appendChild(row);
    } else {
      sorted.forEach((entry, index) => {
        const row = document.createElement('tr');
        appendCell(row, index + 1);
        appendCell(row, entry.name || 'Onbekende kaart');
        appendCell(row, entry.setCode || '');
        appendCell(row, Math.max(1, Number(entry.quantity) || 1));
        appendCell(row, formatScannedAt(entry.scannedAt));
        elements.entriesTableBody.appendChild(row);
      });
    }
    if (elements.exportBtn) elements.exportBtn.disabled = totalCardCount() === 0;
    updateScanCounter();
  }

  function exportExcel() {
    if (!entries.length || !totalCardCount()) {
      setStatusDetail('Er zijn nog geen kaarten om te exporteren.');
      setHomeStatus('Er zijn nog geen kaarten om te exporteren.');
      return;
    }
    if (!Excel || typeof Excel.downloadWorkbook !== 'function') {
      setStatusDetail('De Excel-module kon niet worden geladen. Laad de app opnieuw.');
      setHomeStatus('De Excel-module kon niet worden geladen. Laad de app opnieuw.');
      return;
    }
    try {
      const date = new Date().toISOString().slice(0, 10);
      Excel.downloadWorkbook(entries, `yugioh-kaarten-${date}.xlsx`);
      setStatusDetail('Het Excel-bestand is gedownload. De kolom Waarde is leeg en kan later worden ingevuld.');
      setHomeStatus('Excel gedownload met Kaartnaam, Set-code en een lege kolom Waarde.');
    } catch (error) {
      console.error(error);
      setStatusDetail(error.message || 'Excel-export is mislukt.');
      setHomeStatus(error.message || 'Excel-export is mislukt.');
    }
  }

  function clearEntries() {
    if (!entries.length) return;
    if (!window.confirm('Alle gescande kaarten definitief uit deze browser wissen?')) return;
    entries = [];
    saveEntries();
    renderEntries();
    setResult('De scanlijst is gewist.');
    setStatusDetail('Alle opgeslagen scans zijn verwijderd.');
    setHomeStatus('De scanlijst is gewist.');
  }

  function handleManualModalKeydown(event) {
    if (!elements.manualSetModal || elements.manualSetModal.classList.contains('hidden')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelManualSetCode();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [elements.manualSetInput, elements.manualSetConfirm, elements.manualSetCancel]
      .filter(element => element && !element.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function bindEvents() {
    if (elements.openCameraBtn) elements.openCameraBtn.addEventListener('click', openCamera);
    if (elements.scanListBtn) elements.scanListBtn.addEventListener('click', showEntriesPanel);
    if (elements.exportBtn) elements.exportBtn.addEventListener('click', exportExcel);
    if (elements.clearBtn) elements.clearBtn.addEventListener('click', clearEntries);
    if (elements.scanBtn) elements.scanBtn.addEventListener('click', scanCard);
    if (elements.uploadBtn) elements.uploadBtn.addEventListener('click', () => elements.fileInput && elements.fileInput.click());
    if (elements.closeCameraBtn) elements.closeCameraBtn.addEventListener('click', closeCamera);
    if (elements.scanListBack) elements.scanListBack.addEventListener('click', showHomeScreen);
    if (elements.fileInput) {
      elements.fileInput.addEventListener('change', () => {
        const file = elements.fileInput.files && elements.fileInput.files[0];
        if (file) handleFileUpload(file);
      });
    }
    if (elements.manualSetConfirm) elements.manualSetConfirm.addEventListener('click', confirmManualSetCode);
    if (elements.manualSetCancel) elements.manualSetCancel.addEventListener('click', cancelManualSetCode);
    if (elements.manualSetInput) {
      elements.manualSetInput.addEventListener('input', () => {
        elements.manualSetInput.setAttribute('aria-invalid', 'false');
        if (elements.manualSetError) elements.manualSetError.textContent = '';
      });
      elements.manualSetInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          confirmManualSetCode();
        }
      });
    }
    document.addEventListener('keydown', handleManualModalKeydown);
    window.addEventListener('beforeunload', () => {
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (resolvedOcrWorker) resolvedOcrWorker.terminate().catch(() => {});
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.warn('Offline app-shell kon niet worden geactiveerd.', error);
    }
  }

  function start() {
    if (!Core) {
      setResult('De herkenningsmodule ontbreekt. Laad de app opnieuw.');
      setScanStage('App onvolledig geladen', 'error', 0);
      if (elements.openCameraBtn) elements.openCameraBtn.disabled = true;
    }
    if (!debugEnabled) {
      if (elements.cameraDebugOverlay) elements.cameraDebugOverlay.style.display = 'none';
      if (elements.debugInfo) elements.debugInfo.style.display = 'none';
    } else {
      if (elements.cameraDebugOverlay) elements.cameraDebugOverlay.setAttribute('aria-hidden', 'false');
      resetDebug();
    }
    bindEvents();
    renderEntries();
    hydratePersistentEntries();
    if (totalCardCount()) setHomeStatus(`${totalCardCount()} kaart${totalCardCount() === 1 ? '' : 'en'} klaar voor Excel-export.`);
    setScanButtonMode('capture', 'Foto maken en scannen');
    setScanStage('Camera gereed', 'info', 0, 'Open de scanner of kies een foto.');
    registerServiceWorker();
  }

  start();
}());
