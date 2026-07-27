const openCameraBtn = document.getElementById('openCameraBtn');
const scanListBtn = document.getElementById('scanListBtn');
const captureBtn = document.getElementById('captureBtn');
const uploadBtn = document.getElementById('uploadBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const fileInput = document.getElementById('fileInput');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const scanResult = document.getElementById('scanResult');
const status = document.getElementById('status');
const scanBtn = document.getElementById('scanBtn');
const closeCameraBtn = document.getElementById('closeCameraBtn');
const guideWindow = document.querySelector('.guide-window');
const scanIndicator = document.querySelector('.ocr-debug-rect');
const nameRect = document.querySelector('.name-ocr-rect');
const scanPreview = document.getElementById('scanPreview');
const scanPreviewCode = document.getElementById('scanPreviewCode');
const ocrCropPreviewCanvas = document.getElementById('ocrCropPreviewCanvas');
const homeScreen = document.querySelector('.home-screen');
const scannerScreen = document.querySelector('.scanner-screen');
const entriesPanel = document.querySelector('.entries-panel');
const entriesTableBody = document.querySelector('#entriesTable tbody');
const scanListBack = document.getElementById('scanListBack');

let stream = null;
let entries = JSON.parse(localStorage.getItem('ygoscanner_entries') || '[]');
const DEBUG_NAME_OCR = true; // set to true to show the name-crop debug rectangle
// Debug flags for OCR preview and comparison
const DEBUG_OCR_PREVIEW = false; // set to true to show cropped images sent to OCR
const DEBUG_OCR_COMPARE_PROCESSED = false; // set to true to run OCR on raw + processed crops for comparison
const DEBUG_OCR_SKIP_ENHANCE = false; // set to true to skip enhanceCroppedCanvas() (for comparison)

// The visible OCR overlay is the single source of truth for the crop.

function logMessage(message) {
  status.textContent = message;
}

function updateResult(text) {
  scanResult.textContent = text;
}

function compareSetCodes(codeA, codeB) {
  const parse = code => {
    const match = /^([A-Z0-9]{2,4})-(\d{3})$/.exec(code);
    return match ? [match[1], Number(match[2])] : [code, 0];
  };
  const [prefixA, numA] = parse(codeA);
  const [prefixB, numB] = parse(codeB);
  if (prefixA < prefixB) return -1;
  if (prefixA > prefixB) return 1;
  return numA - numB;
}

function sortEntries() {
  entries.sort((a, b) => {
    const prefixCompare = compareSetCodes(a.setCode, b.setCode);
    return prefixCompare !== 0 ? prefixCompare : a.scannedAt.localeCompare(b.scannedAt);
  });
}

function detectEdition(text) {
  const normalized = text.toUpperCase();
  if (normalized.includes('1ST EDITION') || normalized.includes('FIRST EDITION')) {
    return '1st Edition';
  }
  return 'Other';
}

function saveEntries() {
  sortEntries();
  localStorage.setItem('ygoscanner_entries', JSON.stringify(entries));
}

function addEntry(setCode, name, rawText, edition, setName, rarity, image, confidence) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const entry = {
    setCode,
    name: name || 'Unknown',
    setName: setName || '',
    rarity: rarity || '',
    image: image || '',
    edition: edition || 'Other',
    rawText: rawText || '',
    scannedAt: now,
    scannedDate: now,
    confidence: confidence || 'low'
  };
  entries.unshift(entry);
  saveEntries();
  renderEntries();
}

function groupEntries() {
  const grouped = entries.reduce((map, entry) => {
    const edition = entry.edition || 'Other';
    const key = `${entry.setCode}|${edition}`;
    if (!map[key]) {
      map[key] = {
        setCode: entry.setCode,
        edition,
        name: entry.name || entry.cardName || 'Unknown',
        setName: entry.setName || '',
        rarity: entry.rarity || '',
        image: entry.image || '',
        rawText: entry.rawText,
        count: 0,
        lastScannedAt: entry.scannedAt,
      };
    }
    map[key].count += 1;
    if (entry.name && entry.name !== 'Unknown' && entry.name.length > (map[key].name || '').length) {
      map[key].name = entry.name;
    }
    if (entry.setName && entry.setName.length > (map[key].setName || '').length) {
      map[key].setName = entry.setName;
    }
    if (entry.rarity && entry.rarity.length > (map[key].rarity || '').length) {
      map[key].rarity = entry.rarity;
    }
    if (entry.image && (map[key].image || '').length === 0) {
      map[key].image = entry.image;
    }
    if (entry.rawText.length > map[key].rawText.length) {
      map[key].rawText = entry.rawText;
    }
    if (entry.scannedAt > map[key].lastScannedAt) {
      map[key].lastScannedAt = entry.scannedAt;
    }
    return map;
  }, {});

  return Object.values(grouped).sort((a, b) => {
    const prefixCompare = compareSetCodes(a.setCode, b.setCode);
    if (prefixCompare !== 0) return prefixCompare;
    if (a.edition < b.edition) return -1;
    if (a.edition > b.edition) return 1;
    return a.lastScannedAt.localeCompare(b.lastScannedAt);
  });
}

function renderEntries() {
  const groupedEntries = groupEntries();
  entriesTableBody.innerHTML = groupedEntries.map((entry, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${entry.setCode}</td>
      <td>${entry.name || entry.cardName || 'Unknown'}</td>
      <td>${entry.setName || ''}</td>
      <td>${entry.rarity || ''}</td>
      <td>${entry.edition}</td>
      <td>${entry.count}</td>
      <td>${entry.lastScannedAt}</td>
    </tr>
  `).join('');
}

function extractSetCodes(text) {
  const normalized = text
    .toUpperCase()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[\/\\]/g, '-')
    .replace(/\s*[-–—]\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/([A-Z0-9]{2,6})\s+(\d{3,4})\b/g, '$1-$2')
    .replace(/([A-Z0-9]{2,6})(\d{3,4})\b/g, '$1-$2')
    .trim();

  const regex = /\b([A-Z0-9]{2,6}-[A-Z0-9]{2,5})\b/g;
  const codes = [];
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    const code = match[1];
    if (code) {
      codes.push(code);
    }
  }

  return [...new Set(codes)];
}

const setCodeValidationCache = {};

function normalizeSetCodeCandidate(code) {
  let normalized = code
    .toUpperCase()
    .replace(/[-–—]/g, '-')
    .replace(/[\/\\]/g, '-')
    .replace(/[^A-Z0-9-]/g, '');

  if (!normalized.includes('-')) {
    const brokenMatch = normalized.match(/^([A-Z0-9]+?)(\d{3,4})$/);
    if (brokenMatch) {
      normalized = `${brokenMatch[1]}-${brokenMatch[2]}`;
    }
  }

  const parts = normalized.split('-', 2);
  if (parts.length === 2) {
    const prefix = parts[0];
    const suffix = parts[1]
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/S/g, '5')
      .replace(/Z/g, '2');

    normalized = `${prefix}-${suffix}`;
  }

  return normalized.replace(/[^A-Z0-9-]/g, '');
}

function generateSetCodeVariants(code) {
  const normalized = normalizeSetCodeCandidate(code);
  const variants = new Set([normalized]);
  const parts = normalized.split('-', 2);

  if (parts.length === 2) {
    const [prefix, suffix] = parts;
    const fixedSuffix = suffix
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/S/g, '5')
      .replace(/Z/g, '2');

    variants.add(`${prefix}-${fixedSuffix}`);

    if (/^\d{1,4}$/.test(fixedSuffix)) {
      variants.add(`${prefix}-${fixedSuffix.padStart(3, '0')}`);
    }
  }

  return [...variants].filter(isValidSetCode);
}

async function validateSetCodeWithApi(code) {
  if (setCodeValidationCache[code] !== undefined) {
    return setCodeValidationCache[code];
  }

  const endpoint = `https://db.ygoprodeck.com/api/v7/cardinfo.php?setcode=${encodeURIComponent(code)}`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      setCodeValidationCache[code] = false;
      return false;
    }

    const json = await response.json();
    const valid = Boolean(json && Array.isArray(json.data) && json.data.length > 0);
    setCodeValidationCache[code] = valid;
    return valid;
  } catch (error) {
    console.warn('Set code validation API failed for', code, error);
    setCodeValidationCache[code] = false;
    return false;
  }
}

async function fetchCardInfo(code, detectedName) {
  const norm = normalizeSetCodeCandidate(code);

  function normalizeApiSetCode(s) {
    if (!s) return '';
    return s.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  }

  // Helper to query the API for a specific variant and collect matches
  async function queryVariant(variant) {
    const endpoint = `https://db.ygoprodeck.com/api/v7/cardinfo.php?setcode=${encodeURIComponent(variant)}`;
    try {
      const response = await fetch(endpoint);
      if (!response.ok) return null;
      const json = await response.json();
      if (!json || !Array.isArray(json.data) || !json.data.length) return null;

      const exactMatches = [];
      const containsMatches = [];

      for (const card of json.data) {
        const sets = card.card_sets || [];
        for (const s of sets) {
          const apiCode = normalizeApiSetCode(s.set_code);
          if (apiCode === variant.toUpperCase()) {
            exactMatches.push({ card, matched: s, matchedCode: s.set_code });
          } else if (apiCode.includes(variant.toUpperCase())) {
            containsMatches.push({ card, matched: s, matchedCode: s.set_code });
          }
        }
      }

      return { cards: json.data, exactMatches, containsMatches };
    } catch (e) {
      console.warn('fetchCardInfo query failed for', variant, e);
      return null;
    }
  }

  // 1) Try an exact search for the normalized candidate first
  const exactResult = await queryVariant(norm);
  if (exactResult) {
    // If we have exact matches (set_code equality)
    if (exactResult.exactMatches && exactResult.exactMatches.length) {
      // If a detectedName was provided, prefer a card whose name matches (normalized exact first, then fuzzy)
      if (detectedName) {
        let bestFuzzy = null;
        for (const e of exactResult.exactMatches) {
          const cardName = (e.card && e.card.name) || '';
          const cmp = compareNames(detectedName, cardName);
          if (cmp.exact) {
            console.log('fetchCardInfo: exact set_code and exact name match for', norm, e.matchedCode);
            logMessage('Database lookup: exact match (name confirmed)');
            const card = e.card;
            const matched = e.matched || {};
            return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'exact-name', matchedCode: e.matchedCode, confidence: 'high' };
          }
          if (cmp.fuzzy) {
            if (!bestFuzzy || cmp.similarity > bestFuzzy.similarity) {
              bestFuzzy = { e, similarity: cmp.similarity };
            }
          }
        }
        if (bestFuzzy) {
          const e = bestFuzzy.e;
          console.log('fetchCardInfo: exact set_code and fuzzy name match for', norm, e.matchedCode);
          logMessage('Database lookup: fuzzy name match (confirmed)');
          const card = e.card;
          const matched = e.matched || {};
          return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'exact-fuzzy-name', matchedCode: e.matchedCode, confidence: 'high' };
        }
      }

      // No name provided or no name match – return first exact match with medium confidence
      const first = exactResult.exactMatches[0];
      console.log('fetchCardInfo: exact set_code match for', norm, first.matchedCode);
      logMessage('Database lookup: exact match');
      const card = first.card;
      const matched = first.matched || {};
      return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'exact', matchedCode: first.matchedCode, confidence: 'medium' };
    }
    // If API returned data but no exact set_code equality, keep note and continue to normalized attempts
    console.log('fetchCardInfo: API returned results for', norm, 'but no exact set_code equality');
  }

  // 2) Try normalized/alternative variants (common OCR corrections)
  const variants = generateSetCodeVariants(norm).filter(v => v !== norm);
  for (const variant of variants) {
    const r = await queryVariant(variant);
    if (!r) continue;
    if (r.exactMatches && r.exactMatches.length) {
      // normalized variant exact match – treat as medium confidence (name match only raises to medium here per policy)
      const first = r.exactMatches[0];
      console.log('fetchCardInfo: normalized exact match for', variant, first.matchedCode);
      logMessage('Database lookup: normalized match');
      const card = first.card;
      const matched = first.matched || {};
      return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'normalized', matchedCode: first.matchedCode, confidence: 'medium' };
    }
    // contains-match fallback
    if (r.containsMatches && r.containsMatches.length) {
      const first = r.containsMatches[0];
      console.log('fetchCardInfo: normalized contains-match for', variant, first.matchedCode);
      logMessage('Database lookup: normalized match (contains)');
      const card = first.card;
      const matched = first.matched || {};
      return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'normalized', matchedCode: first.matchedCode, confidence: 'medium' };
    }
  }

  // 3) No match found — do not fail the scan; return minimal info and indicate none
  console.log('fetchCardInfo: no database match for', norm);
  logMessage('Database lookup: no database match');
  return { name: 'Unknown', setName: '', rarity: '', image: '', matchType: 'none', matchedCode: '', confidence: 'low' };
}

async function fetchCardsByName(name) {
  if (!name) return null;
  const endpointExact = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
  try {
    let response = await fetch(endpointExact);
    if (response.ok) {
      const json = await response.json();
      if (json && Array.isArray(json.data) && json.data.length) return json.data;
    }
  } catch (e) {
    console.warn('fetchCardsByName exact failed for', name, e);
  }

  // Try fuzzy name search (fname) as fallback
  const endpointFuzzy = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`;
  try {
    const response = await fetch(endpointFuzzy);
    if (!response.ok) return null;
    const json = await response.json();
    if (json && Array.isArray(json.data) && json.data.length) return json.data;
  } catch (e) {
    console.warn('fetchCardsByName fuzzy failed for', name, e);
  }
  return null;
}

async function findBestSetCode(candidates) {
  for (const candidate of candidates) {
    const variants = generateSetCodeVariants(candidate);
    for (const variant of variants) {
      if (await validateSetCodeWithApi(variant)) {
        return variant;
      }
    }
  }
  return null;
}

function guessCardName(text) {
  const disallowed = ['DECK', 'SET', 'CARD', 'YU-GI-OH', 'MONSTER', 'SPELL', 'TRAP', 'ATTACK', 'DEFENSE', 'LEVEL', 'ATK', 'DEF', 'LP'];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const candidates = lines.filter(line => {
    if (line.length < 3 || line.length > 40) return false;
    if (/^[0-9]+$/.test(line)) return false;
    if (/\b[A-Z0-9]{2,4}-\d{3,4}\b/.test(line.toUpperCase())) return false;
    const upper = line.toUpperCase();
    return !disallowed.some(token => upper.includes(token));
  });
  return candidates.length ? candidates[0] : '';
}

function normalizeCardName(name) {
  if (!name) return '';
  // Remove diacritics, punctuation (- ' : . ,) and collapse spaces, lowercase
  try {
    let s = name.normalize('NFD').replace(/\p{M}/gu, '');
    s = s.replace(/[\-\'\:.,]/g, ' ');
    s = s.replace(/[^\p{L}\p{N} ]+/gu, '');
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s;
  } catch (e) {
    // Fallback if Unicode properties not supported
    let s = name;
    s = s.replace(/[\-\'\:.,]/g, ' ');
    s = s.replace(/[^A-Za-z0-9 ]+/g, '');
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s;
  }
}

function levenshteinDistance(a, b) {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: an + 1 }, () => new Array(bn + 1));
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    const ai = a.charAt(i - 1);
    for (let j = 1; j <= bn; j++) {
      const bj = b.charAt(j - 1);
      const cost = ai === bj ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[an][bn];
}

function compareNames(a, b) {
  const na = normalizeCardName(a || '');
  const nb = normalizeCardName(b || '');
  if (na === nb) return { exact: true, fuzzy: false, distance: 0, similarity: 1 };
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  const similarity = 1 - dist / maxLen;
  const fuzzy = similarity >= 0.75; // threshold
  return { exact: false, fuzzy, distance: dist, similarity };
}


async function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = URL.createObjectURL(blob);
  });
}

function setScanIndicatorSuccess(active) {
  if (!scanIndicator) return;
  scanIndicator.classList.toggle('scan-success', active);
}

function showScanPreview(code) {
  if (!scanPreview || !scanPreviewCode) return;
  scanPreviewCode.textContent = code;
  scanPreview.classList.add('active');
}

// Show OCR preview images in the camera guide for debugging
function showOcrPreview(rawUrl, processedUrl) {
  try {
    let container = document.getElementById('ocrPreviewContainer');
    if (!container) {
      const guide = document.querySelector('.camera-guide');
      container = document.createElement('div');
      container.id = 'ocrPreviewContainer';
      container.style.position = 'absolute';
      container.style.right = '8px';
      container.style.bottom = '8px';
      container.style.zIndex = '9999';
      container.style.display = 'flex';
      container.style.gap = '6px';
      guide.appendChild(container);
    }

    // helper to create/update preview box
    const upsert = (id, url, label) => {
      let box = document.getElementById(id);
      if (!box) {
        box = document.createElement('div');
        box.id = id;
        box.style.background = 'rgba(0,0,0,0.6)';
        box.style.color = '#fff';
        box.style.padding = '4px';
        box.style.borderRadius = '6px';
        box.style.width = '96px';
        box.style.textAlign = 'center';
        box.style.fontSize = '10px';
        const img = document.createElement('img');
        img.style.width = '88px';
        img.style.height = '56px';
        img.style.objectFit = 'cover';
        img.id = id + '-img';
        const lbl = document.createElement('div');
        lbl.id = id + '-lbl';
        lbl.style.marginTop = '4px';
        box.appendChild(img);
        box.appendChild(lbl);
        container.appendChild(box);
      }
      const img = document.getElementById(id + '-img');
      const lbl = document.getElementById(id + '-lbl');
      if (url) img.src = url; else img.src = '';
      lbl.textContent = label || '';
    };

    upsert('ocrPreviewRaw', rawUrl || '', 'Raw');
    upsert('ocrPreviewProc', processedUrl || '', 'Processed');
  } catch (e) {
    console.warn('showOcrPreview failed', e);
  }
}

function hideScanPreview() {
  if (!scanPreview) return;
  scanPreview.classList.remove('active');
}

function resetScanIndicator() {
  setScanIndicatorSuccess(false);
  hideScanPreview();
}

function isValidSetCode(code) {
  return /^[A-Z0-9]{2,6}-[A-Z0-9]{2,5}$/.test(code);
}

function getVideoDisplayMetrics() {
  if (!video || !video.videoWidth || !video.videoHeight) return null;

  const videoRect = video.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height) return null;

  const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
  const sourceVisibleWidth = videoRect.width / scale;
  const sourceVisibleHeight = videoRect.height / scale;
  const offsetX = Math.max(0, (video.videoWidth - sourceVisibleWidth) / 2);
  const offsetY = Math.max(0, (video.videoHeight - sourceVisibleHeight) / 2);

  return {
    videoRect,
    scale,
    sourceVisibleWidth,
    sourceVisibleHeight,
    offsetX,
    offsetY
  };
}

function getGuideCropRect() {
  const rect = scanIndicator;
  if (!rect || !video || !video.videoWidth || !video.videoHeight) return null;

  const metrics = getVideoDisplayMetrics();
  if (!metrics) return null;

  const overlayRect = rect.getBoundingClientRect();
  if (!overlayRect.width || !overlayRect.height) return null;

  const relLeft = overlayRect.left - metrics.videoRect.left;
  const relTop = overlayRect.top - metrics.videoRect.top;
  const relWidth = overlayRect.width;
  const relHeight = overlayRect.height;

  const x = Math.max(0, Math.min(video.videoWidth, Math.round((relLeft / metrics.videoRect.width) * metrics.sourceVisibleWidth + metrics.offsetX)));
  const y = Math.max(0, Math.min(video.videoHeight, Math.round((relTop / metrics.videoRect.height) * metrics.sourceVisibleHeight + metrics.offsetY)));
  const width = Math.max(1, Math.min(video.videoWidth - x, Math.round((relWidth / metrics.videoRect.width) * metrics.sourceVisibleWidth)));
  const height = Math.max(1, Math.min(video.videoHeight - y, Math.round((relHeight / metrics.videoRect.height) * metrics.sourceVisibleHeight)));

  return { x, y, width, height, overlayRect };
}

async function cropCardBlob(blob) {
  const img = await loadImage(blob);
  const guideArea = getGuideCropRect();
  const cropWidth = guideArea ? guideArea.width : img.width;
  const cropHeight = guideArea ? guideArea.height : img.height;
  const x = guideArea ? guideArea.x : 0;
  const y = guideArea ? guideArea.y : 0;

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
}

function updateOcrCropOverlay() {
  if (!scanIndicator) return;
  scanIndicator.style.display = 'flex';
  scanIndicator.style.position = 'absolute';
  scanIndicator.style.border = '2px solid rgba(255, 255, 255, 0.95)';
  scanIndicator.style.borderRadius = '12px';
  scanIndicator.style.pointerEvents = 'none';
  scanIndicator.textContent = 'OCR crop';
}

function showHomeScreen() {
  if (homeScreen) homeScreen.classList.remove('hidden');
  if (scannerScreen) scannerScreen.classList.add('hidden');
  if (entriesPanel) entriesPanel.classList.add('hidden');
}

function showScannerScreen() {
  if (homeScreen) homeScreen.classList.add('hidden');
  if (scannerScreen) scannerScreen.classList.remove('hidden');
  if (entriesPanel) entriesPanel.classList.add('hidden');
}

function showEntriesPanel() {
  if (homeScreen) homeScreen.classList.add('hidden');
  if (scannerScreen) scannerScreen.classList.add('hidden');
  if (entriesPanel) entriesPanel.classList.remove('hidden');
}

function enterFullscreenMode() {
  showScannerScreen();
  document.body.classList.add('fullscreen-camera');
  document.body.style.overflow = 'hidden';
  document.body.style.touchAction = 'none';
  document.body.style.overscrollBehavior = 'none';
  if (scanBtn) scanBtn.disabled = false;
  if (captureBtn) captureBtn.disabled = true;
  if (nameRect) nameRect.classList.toggle('active', DEBUG_NAME_OCR);
}

function exitFullscreenMode() {
  document.body.classList.remove('fullscreen-camera');
  document.body.style.overflow = '';
  document.body.style.touchAction = '';
  document.body.style.overscrollBehavior = '';
  if (captureBtn) captureBtn.disabled = false;
  if (nameRect) nameRect.classList.remove('active');
}

async function closeCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  stream = null;
  video.srcObject = null;
  exitFullscreenMode();
  showHomeScreen();
  resetScanIndicator();
  logMessage('Camera closed.');
}

function enhanceCroppedCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const contrast = 70;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    const contrasted = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
    const threshold = contrasted > 140 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = threshold;
  }

  ctx.putImageData(imageData, 0, 0);
}

function preprocessNameCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const contrast = 80;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    const contrasted = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
    data[i] = data[i + 1] = data[i + 2] = contrasted;
  }

  ctx.putImageData(imageData, 0, 0);

  // Apply a light threshold to improve OCR on text
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const threshold = 120;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    const t = v > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = t;
  }
  ctx.putImageData(img, 0, 0);
}

async function cropNameBlob(blob) {
  const img = await loadImage(blob);
  const guideArea = getGuideCropRect();
  const cardX = guideArea ? guideArea.x : 0;
  const cardY = guideArea ? guideArea.y : 0;
  const cardWidth = guideArea ? guideArea.width : img.width;
  const cardHeight = guideArea ? guideArea.height : img.height;

  const cropX = Math.min(img.width - 1, Math.max(0, Math.round(cardX + cardWidth * 0.05)));
  const cropY = Math.min(img.height - 1, Math.max(0, Math.round(cardY + cardHeight * 0.04)));
  const cropWidth = Math.min(img.width - cropX, Math.round(cardWidth * 0.90));
  const cropHeight = Math.min(img.height - cropY, Math.max(30, Math.round(cardHeight * 0.12)));

  console.log('[DEBUG] name crop geometry', {
    sourceImageSize: { width: img.width, height: img.height },
    guideArea,
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight }
  });

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  preprocessNameCanvas(tempCanvas);
  console.log('[DEBUG] name crop image sent to OCR', { width: tempCanvas.width, height: tempCanvas.height });

  return new Promise(resolve => {
    tempCanvas.toBlob(blob => {
      console.log('[DEBUG] name crop blob ready', blob ? { size: blob.size, type: blob.type } : null);
      resolve(blob);
    }, 'image/png');
  });
}

async function extractNameFromBlob(blob) {
  try {
    const nameBlob = await cropNameBlob(blob);
    if (!nameBlob) return '';
    console.log('[DEBUG] running name OCR');
    const ocr = await Tesseract.recognize(nameBlob, 'eng', {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '’-:,.()",
      tessedit_pageseg_mode: 7,
    });
    let text = (ocr.data.text || '').trim();
    text = text.replace(/[\r\n]+/g, ' ');
    text = text.replace(/[^A-Za-z0-9\u00C0-\u024F'’\-:\,\.\(\) ]+/g, '');
    text = text.replace(/\s+/g, ' ').trim();
    console.log('[DEBUG] name OCR result:', text || '(empty)');
    return text;
  } catch (e) {
    console.warn('Name OCR failed', e);
    return '';
  }
}

async function cropSetCodeBlob(blob) {
  const img = await loadImage(blob);
  const guideArea = getGuideCropRect();
  const cardX = guideArea ? guideArea.x : 0;
  const cardY = guideArea ? guideArea.y : 0;
  const cardWidth = guideArea ? guideArea.width : img.width;
  const cardHeight = guideArea ? guideArea.height : img.height;
  const cropRect = getGuideCropRect();
  const cropWidthPx = cropRect ? cropRect.width : Math.max(220, Math.round(cardWidth * 0.42));
  const cropHeightPx = cropRect ? cropRect.height : Math.max(80, Math.round(cardHeight * 0.14));
  const x = cropRect ? cropRect.x : Math.min(img.width - cropWidthPx, Math.max(0, Math.round(cardX + cardWidth * 0.60)));
  const y = cropRect ? cropRect.y : Math.min(img.height - cropHeightPx, Math.max(0, Math.round(cardY + cardHeight * 0.62)));

  console.log('[DEBUG] set-code crop geometry', {
    sourceImageSize: { width: img.width, height: img.height },
    guideArea,
    cropRect,
    crop: { x, y, width: cropWidthPx, height: cropHeightPx }
  });

  // Raw canvas (unprocessed)
  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = cropWidthPx;
  rawCanvas.height = cropHeightPx;
  const rawCtx = rawCanvas.getContext('2d');
  rawCtx.drawImage(img, x, y, cropWidthPx, cropHeightPx, 0, 0, cropWidthPx, cropHeightPx);

  console.log('[DEBUG] set-code crop image sent to OCR', { width: cropWidthPx, height: cropHeightPx });

  if (ocrCropPreviewCanvas) {
    const previewCtx = ocrCropPreviewCanvas.getContext('2d');
    ocrCropPreviewCanvas.width = cropWidthPx;
    ocrCropPreviewCanvas.height = cropHeightPx;
    previewCtx.clearRect(0, 0, ocrCropPreviewCanvas.width, ocrCropPreviewCanvas.height);
    previewCtx.drawImage(rawCanvas, 0, 0, cropWidthPx, cropHeightPx, 0, 0, ocrCropPreviewCanvas.width, ocrCropPreviewCanvas.height);
    console.log('[DEBUG] set-code crop preview drawn', { width: cropWidthPx, height: cropHeightPx });
  }

  // Processed canvas (may be enhanced)
  const procCanvas = document.createElement('canvas');
  procCanvas.width = cropWidthPx;
  procCanvas.height = cropHeightPx;
  const procCtx = procCanvas.getContext('2d');
  procCtx.drawImage(rawCanvas, 0, 0);
  if (!DEBUG_OCR_SKIP_ENHANCE) {
    enhanceCroppedCanvas(procCanvas);
  }

  // Convert canvases to blobs
  const rawBlob = await new Promise(resolve => {
    rawCanvas.toBlob(blob => {
      console.log('[DEBUG] raw set-code crop blob ready', blob ? { size: blob.size, type: blob.type } : null);
      resolve(blob);
    }, 'image/png');
  });
  const procBlob = await new Promise(resolve => {
    procCanvas.toBlob(blob => {
      console.log('[DEBUG] processed set-code crop blob ready', blob ? { size: blob.size, type: blob.type } : null);
      resolve(blob);
    }, 'image/png');
  });

  // Show preview images if enabled
  if (DEBUG_OCR_PREVIEW) {
    try {
      const rawUrl = URL.createObjectURL(rawBlob);
      const procUrl = URL.createObjectURL(procBlob);
      showOcrPreview(rawUrl, procUrl);
      // Revoke URLs after a short delay to allow image load (keep lightweight)
      setTimeout(() => {
        try { URL.revokeObjectURL(rawUrl); } catch (e) {}
        try { URL.revokeObjectURL(procUrl); } catch (e) {}
      }, 5000);
    } catch (e) {
      console.warn('OCR preview failed', e);
    }
  }

  // Return both blobs when comparison requested, otherwise return processed blob
  if (DEBUG_OCR_COMPARE_PROCESSED) return { rawBlob, processedBlob: procBlob };
  return procBlob;
}

async function recognizeImage(blob) {
  logMessage('Recognizing text, this may take a moment...');
  updateResult('Scanning the card name area first...');
  console.log('=== RECOGNITION PIPELINE START ===');

  try {
    console.log('[1/9] Captured image received');

    console.log('[2/9] Cropping card name area');
    const nameCropBlob = await cropNameBlob(blob);

    console.log('[3/9] OCR card name');
    console.log('[DEBUG] sending name crop to Tesseract', nameCropBlob ? { size: nameCropBlob.size, type: nameCropBlob.type } : null);
    const nameOcrResult = await Tesseract.recognize(nameCropBlob, 'eng', {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '’-:,.()",
      tessedit_pageseg_mode: 7,
      logger: m => {
        if (m.status && m.progress !== undefined) {
          const percent = Math.round(m.progress * 100);
          logMessage(`${m.status} (${percent}%)`);
        }
      }
    });

    let detectedName = (nameOcrResult.data.text || '').trim();
    detectedName = detectedName.replace(/[\r\n]+/g, ' ');
    detectedName = detectedName.replace(/[^A-Za-z0-9\u00C0-\u024F'’\-:\,\.\(\) ]+/g, '');
    detectedName = detectedName.replace(/\s+/g, ' ').trim();

    console.log('[DEBUG] name OCR result:', detectedName || '(none)');
    console.log('[4/9] Card name OCR result:', detectedName || '(none)');
    if (!detectedName) {
      updateResult('No card name detected. Try a clearer photo.');
      logMessage('Name OCR did not return a usable card name.');
      return;
    }

    console.log('[5/9] Searching YGOPRODeck by card name');
    const nameResults = await fetchCardsByName(detectedName);
    console.log('[6/9] Name search returned', nameResults ? nameResults.length : 0, 'printings');
    console.log('[DEBUG] name search result count', nameResults ? nameResults.length : 0);
    if (nameResults && nameResults.length) {
      console.log('[DEBUG] name search sample', nameResults.slice(0, 5).map(card => ({
        name: card.name,
        setCodes: (card.card_sets || []).slice(0, 3).map(s => s.set_code)
      })));
    }

    if (!nameResults || !nameResults.length) {
      updateResult('No matching card found by name.');
      logMessage('Card name lookup returned no results.');
      return;
    }

    console.log('[7/9] Cropping set code area');
    const cropResult = await cropSetCodeBlob(blob);
    let rawCropBlob = null;
    let procCropBlob = null;
    if (cropResult && cropResult.rawBlob !== undefined) {
      rawCropBlob = cropResult.rawBlob;
      procCropBlob = cropResult.processedBlob;
    } else {
      procCropBlob = cropResult;
    }

    const tesseractOpts = {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
      tessedit_pageseg_mode: 7,
      preserve_interword_spaces: '0',
      logger: m => {
        if (m.status && m.progress !== undefined) {
          const percent = Math.round(m.progress * 100);
          logMessage(`${m.status} (${percent}%)`);
        }
      }
    };

    console.log('[8/9] OCR set code');
    console.log('[DEBUG] sending set-code crop to Tesseract', procCropBlob ? { size: procCropBlob.size, type: procCropBlob.type } : null);
    const ocrResult = await Tesseract.recognize(procCropBlob, 'eng', tesseractOpts);
    const setText = (ocrResult.data.text || '').toUpperCase();
    const rawText = setText.trim();
    const codes = extractSetCodes(setText);
    console.log('[DEBUG] set-code OCR result:', rawText || '(none)');
    console.log('[8/9] OCR set code result:', rawText || '(none)');
    console.log('[8/9] Extracted set code candidates:', codes);

    if (codes.length === 0) {
      updateResult('No set code detected. Align the card so the bottom-right code is inside the box.');
      logMessage(`No valid set code found. OCR text: ${rawText.replace(/\n/g, ' ')}`);
      return;
    }

    console.log('[9/9] Comparing detected set code with returned printings');
    const bestMatch = await findBestSetCode(codes);
    console.log('[DEBUG] best set-code candidate', bestMatch || '(none)');
    if (!bestMatch) {
      updateResult('No valid set code match found. Try a clearer scan.');
      logMessage(`OCR text found but no database match: ${rawText.replace(/\n/g, ' ')}`);
      setScanIndicatorSuccess(false);
      return;
    }

    const edition = detectEdition(rawText);
    logMessage('Set code found and validated against database. Fetching card info...');
    setScanIndicatorSuccess(true);
    showScanPreview(bestMatch);

    const variants = generateSetCodeVariants(bestMatch);
    let matchedEntry = null;
    let bestNameOnly = null;

    for (const card of nameResults) {
      const cardName = card.name || '';
      const nameCmp = compareNames(detectedName, cardName);
      if (nameCmp.exact) {
        bestNameOnly = { card, similarity: 1, exact: true };
      } else if (nameCmp.fuzzy) {
        if (!bestNameOnly || nameCmp.similarity > bestNameOnly.similarity) {
          bestNameOnly = { card, similarity: nameCmp.similarity, exact: false };
        }
      }

      if (!nameCmp.exact && !nameCmp.fuzzy) continue;

      const sets = card.card_sets || [];
      for (const s of sets) {
        const apiCode = (s.set_code || '').toUpperCase();
        for (const v of variants) {
          if (apiCode === v.toUpperCase()) {
            matchedEntry = { card, matched: s, nameCmp };
            break;
          }
        }
        if (matchedEntry) break;
      }
      if (matchedEntry) break;
    }

    let cardInfo = null;
    if (matchedEntry) {
      const card = matchedEntry.card;
      const matched = matchedEntry.matched || {};
      cardInfo = { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'name+set', confidence: 'high' };
      console.log('Matched card by name + set code');
      logMessage('Lookup path: name + set (high confidence)');
    } else if (bestNameOnly) {
      const card = bestNameOnly.card;
      const matched = (card.card_sets && card.card_sets[0]) || null;
      cardInfo = { name: card.name || 'Unknown', setName: matched ? matched.set_name : '', rarity: matched ? matched.set_rarity : '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'name-only', confidence: 'medium' };
      console.log('Matched card by name only');
      logMessage('Lookup path: name-only (medium confidence)');
    } else {
      cardInfo = await fetchCardInfo(bestMatch, detectedName);
    }

    console.log('[DEBUG] final database match', {
      bestMatch,
      cardInfo,
      detectedName,
      rawSetCodeText: rawText,
      matchedPrinting: matchedEntry ? {
        name: matchedEntry.card && matchedEntry.card.name,
        setCode: matchedEntry.matched && matchedEntry.matched.set_code,
        setName: matchedEntry.matched && matchedEntry.matched.set_name,
        rarity: matchedEntry.matched && matchedEntry.matched.set_rarity
      } : null
    });
    updateResult(`Detected ${bestMatch} — ${cardInfo.name || 'Unknown'} (${cardInfo.setName || edition})`);
    addEntry(bestMatch, cardInfo.name || 'Unknown', rawText, edition, cardInfo.setName, cardInfo.rarity, cardInfo.image, cardInfo.confidence || 'low');
    console.log('=== RECOGNITION PIPELINE COMPLETE ===');
  } catch (error) {
    console.error(error);
    updateResult('OCR failed. Use a clear, well-lit photo of the card.');
    logMessage('An error occurred during text recognition.');
  }
}

async function openCamera() {
  const secure = window.isSecureContext || location.protocol === 'http:' && location.hostname === 'localhost';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !secure) {
    logMessage('Camera unavailable here. Opening the upload picker instead.');
    fileInput.click();
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment'
      },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    enterFullscreenMode();
    resetScanIndicator();
    requestAnimationFrame(() => updateOcrCropOverlay());
    logMessage('Camera open. Place the card inside the frame and tap Scan.');
  } catch (error) {
    console.error(error);
    logMessage('Unable to open the camera. Opening the upload picker instead.');
    fileInput.click();
  }
}

async function scanCard() {
  if (!stream) {
    logMessage('Open the camera first or upload an image.');
    return;
  }

  console.log('scanCard: button pressed');

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  console.log('[DEBUG] captured image resolution', { width: canvas.width, height: canvas.height });
  console.log('scanCard: image drawn to canvas');

  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (blob) {
        console.log('scanCard: image captured (blob)');
        try {
          await recognizeImage(blob);
          resolve();
        } catch (e) {
          alert(e.message || 'Unknown error');
          console.error('scanCard: recognizeImage error', e);
          reject(e);
        }
      } else {
        console.error('scanCard: unable to capture image blob');
        reject(new Error('Unable to capture image.'));
      }
    }, 'image/png');
  });
}

function handleFileUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const img = new Image();
    img.onload = async () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      canvas.toBlob(async blob => {
        if (blob) {
          console.log('handleFileUpload: image uploaded (blob)');
          try {
            await recognizeImage(blob);
          } catch (e) {
            console.error('handleFileUpload: recognizeImage error', e);
            updateResult('OCR failed on uploaded image.');
          }
        }
      }, 'image/png');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function exportCsv() {
  if (!entries.length) {
    logMessage('No saved entries to export.');
    return;
  }
  const grouped = entries.reduce((map, entry) => {
    const key = entry.setCode;
    if (!map[key]) {
      map[key] = {
        setCode: entry.setCode,
        name: entry.name || entry.cardName || 'Unknown',
        setName: entry.setName || '',
        rarity: entry.rarity || '',
        lastScannedAt: entry.scannedAt
      };
    }
    // prefer longer/more informative values
    if (entry.name && entry.name.length > (map[key].name || '').length) map[key].name = entry.name;
    if (entry.setName && entry.setName.length > (map[key].setName || '').length) map[key].setName = entry.setName;
    if (entry.rarity && entry.rarity.length > (map[key].rarity || '').length) map[key].rarity = entry.rarity;
    if (entry.scannedAt > map[key].lastScannedAt) map[key].lastScannedAt = entry.scannedAt;
    return map;
  }, {});

  const uniqueEntries = Object.values(grouped).sort((a, b) => {
    const prefixCompare = compareSetCodes(a.setCode, b.setCode);
    if (prefixCompare !== 0) return prefixCompare;
    return (a.lastScannedAt || '').localeCompare(b.lastScannedAt || '');
  });

  const header = ['Set Code', 'Card Name', 'Set Name', 'Rarity', 'Scan Date'];
  const rows = uniqueEntries.map(entry => [
    entry.setCode,
    (entry.name || '').replace(/"/g, '""'),
    (entry.setName || '').replace(/"/g, '""'),
    (entry.rarity || '').replace(/"/g, '""'),
    entry.lastScannedAt || ''
  ]);

  const csv = [header, ...rows].map(row => row.map(value => `"${value}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'yugioh-setcodes.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  logMessage('CSV downloaded. Open it in Excel or Numbers.');
}

function clearSheet() {
  if (!confirm('Clear all scanned entries from the sheet?')) return;
  entries = [];
  saveEntries();
  renderEntries();
  updateResult('Sheet cleared.');
  logMessage('All entries removed.');
}

window.addEventListener('resize', () => updateOcrCropOverlay());
window.addEventListener('orientationchange', () => setTimeout(updateOcrCropOverlay, 150));
video.addEventListener('loadedmetadata', () => updateOcrCropOverlay());
video.addEventListener('playing', () => updateOcrCropOverlay());
openCameraBtn.addEventListener('click', openCamera);
if (scanListBtn) scanListBtn.addEventListener('click', showEntriesPanel);
captureBtn.addEventListener('click', scanCard);
if (scanBtn) scanBtn.addEventListener('click', scanCard);
if (closeCameraBtn) closeCameraBtn.addEventListener('click', closeCamera);
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    handleFileUpload(fileInput.files[0]);
  }
});
exportBtn.addEventListener('click', exportCsv);
clearBtn.addEventListener('click', clearSheet);
if (scanListBack) scanListBack.addEventListener('click', showHomeScreen);

sortEntries();
renderEntries();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js');
      console.log('Service worker registered');
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  });
}
