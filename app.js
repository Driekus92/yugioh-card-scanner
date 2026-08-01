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
const scanPreview = document.getElementById('scanPreview');
const scanPreviewCode = document.getElementById('scanPreviewCode');
const homeScreen = document.querySelector('.home-screen');
const scannerScreen = document.querySelector('.scanner-screen');
const entriesPanel = document.querySelector('.entries-panel');
const entriesTableBody = document.querySelector('#entriesTable tbody');
const scanListBack = document.getElementById('scanListBack');

let stream = null;
let entries = JSON.parse(localStorage.getItem('ygoscanner_entries') || '[]');
const DEBUG_UI = false;

const OCR_NAME_PROFILE = {
  scale: 2,
  contrast: 0.45,
  whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '’-:,.()"
};

const OCR_SET_CODE_PROFILE = {
  scale: 3,
  contrast: 0.2,
  whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'
};

function logMessage(message) {
  if (status) {
    status.textContent = message;
  }
}

function updateResult(text) {
  if (scanResult) {
    scanResult.textContent = text;
  }
}

function compareSetCodes(codeA, codeB) {
  const parse = code => {
    const match = /^([A-Z0-9]{2,4})-(\d{3})$/.exec(code || '');
    return match ? [match[1], Number(match[2])] : [String(code || ''), 0];
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
  const normalized = (text || '').toUpperCase();
  return normalized.includes('1ST EDITION') || normalized.includes('FIRST EDITION') ? '1st Edition' : 'Other';
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
        name: entry.name || 'Unknown',
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
    if (entry.image && !(map[key].image || '')) {
      map[key].image = entry.image;
    }
    if ((entry.rawText || '').length > (map[key].rawText || '').length) {
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
  if (!entriesTableBody) return;
  entriesTableBody.innerHTML = groupedEntries.map((entry, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${entry.setCode}</td>
      <td>${entry.name || 'Unknown'}</td>
      <td>${entry.setName || ''}</td>
      <td>${entry.rarity || ''}</td>
      <td>${entry.edition}</td>
      <td>${entry.count}</td>
      <td>${entry.lastScannedAt}</td>
    </tr>
  `).join('');
}

function normalizeSetCodeCandidate(code) {
  let normalized = (code || '')
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

function isValidSetCode(code) {
  return /^[A-Z0-9]{2,6}-[A-Z0-9]{2,5}$/.test(code || '');
}

function buildSetCodeVariants(code) {
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

function extractSetCodes(text) {
  const cleaned = (text || '')
    .toUpperCase()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[^A-Z0-9-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const candidates = new Set();
  const directMatches = cleaned.match(/[A-Z0-9]{2,6}-[A-Z0-9]{2,5}/g) || [];
  directMatches.forEach(match => candidates.add(normalizeSetCodeCandidate(match)));

  cleaned.split(/\s+/).forEach(token => {
    const match = token.match(/^([A-Z0-9]{2,6})(\d{3,4})$/);
    if (match) {
      candidates.add(normalizeSetCodeCandidate(`${match[1]}-${match[2]}`));
    }
  });

  return [...candidates].filter(isValidSetCode);
}

function normalizeCardName(name) {
  if (!name) return '';
  try {
    let cleaned = name.normalize('NFD').replace(/\p{M}/gu, '');
    cleaned = cleaned.replace(/[\-'\:.,]/g, ' ');
    cleaned = cleaned.replace(/[^\p{L}\p{N} ]+/gu, '');
    return cleaned.replace(/\s+/g, ' ').trim().toLowerCase();
  } catch (error) {
    return name.replace(/[\-'\:.,]/g, ' ').replace(/[^A-Za-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
}

function levenshteinDistance(a, b) {
  const left = a ? a.length : 0;
  const right = b ? b.length : 0;
  if (left === 0) return right;
  if (right === 0) return left;
  const matrix = Array.from({ length: left + 1 }, () => new Array(right + 1));
  for (let i = 0; i <= left; i++) matrix[i][0] = i;
  for (let j = 0; j <= right; j++) matrix[0][j] = j;
  for (let i = 1; i <= left; i++) {
    const charA = a.charAt(i - 1);
    for (let j = 1; j <= right; j++) {
      const charB = b.charAt(j - 1);
      const cost = charA === charB ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[left][right];
}

function compareNames(a, b) {
  const left = normalizeCardName(a || '');
  const right = normalizeCardName(b || '');
  if (left === right) return { exact: true, fuzzy: false, distance: 0, similarity: 1 };
  const distance = levenshteinDistance(left, right);
  const maxLen = Math.max(left.length, right.length) || 1;
  const similarity = 1 - distance / maxLen;
  return { exact: false, fuzzy: similarity >= 0.75, distance, similarity };
}

function createCanvas(width, height) {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  return tempCanvas;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function preprocessCanvas(canvas, profile) {
  const width = Math.round(canvas.width * (profile.scale || 1));
  const height = Math.round(canvas.height * (profile.scale || 1));
  const outputCanvas = createCanvas(width, height);
  const ctx = outputCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const gain = 1 + (profile.contrast || 0);
  for (let index = 0; index < data.length; index += 4) {
    const gray = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
    const adjusted = clamp(128 + (gray - 128) * gain, 0, 255);
    data[index] = adjusted;
    data[index + 1] = adjusted;
    data[index + 2] = adjusted;
  }
  ctx.putImageData(imageData, 0, 0);
  return outputCanvas;
}

async function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const imageUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(imageUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error('Image load failed'));
    };
    img.src = imageUrl;
  });
}

function getCaptureRegions(image) {
  const width = image.width;
  const height = image.height;
  return {
    name: {
      x: Math.round(width * 0.08),
      y: Math.round(height * 0.06),
      width: Math.round(width * 0.84),
      height: Math.round(height * 0.18)
    },
    setCode: {
      x: Math.round(width * 0.58),
      y: Math.round(height * 0.72),
      width: Math.round(width * 0.34),
      height: Math.round(height * 0.12)
    }
  };
}

function cropRegion(image, region) {
  const canvas = createCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  return canvas;
}

async function readCardName(image) {
  const regions = getCaptureRegions(image);
  const cropped = cropRegion(image, regions.name);
  const processed = preprocessCanvas(cropped, OCR_NAME_PROFILE);
  const result = await Tesseract.recognize(processed, 'eng', {
    tessedit_char_whitelist: OCR_NAME_PROFILE.whitelist,
    tessedit_pageseg_mode: 7
  });
  const text = (result.data.text || '').trim();
  return text.replace(/[\r\n]+/g, ' ').replace(/[^A-Za-z0-9\u00C0-\u024F'’\-:\,\.\(\) ]+/g, '').replace(/\s+/g, ' ').trim();
}

async function readSetCode(image) {
  const regions = getCaptureRegions(image);
  const cropped = cropRegion(image, regions.setCode);
  const processed = preprocessCanvas(cropped, OCR_SET_CODE_PROFILE);
  const result = await Tesseract.recognize(processed, 'eng', {
    tessedit_char_whitelist: OCR_SET_CODE_PROFILE.whitelist,
    tessedit_pageseg_mode: 7
  });
  const text = (result.data.text || '').toUpperCase();
  const codes = extractSetCodes(text);
  return { text: text.trim(), codes };
}

async function fetchCardsByName(name) {
  if (!name) return [];
  const endpoint = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) return [];
    const json = await response.json();
    return Array.isArray(json && json.data) ? json.data : [];
  } catch (error) {
    console.warn('Card lookup failed', error);
    return [];
  }
}

function findBestLocalMatch(codes, card) {
  const printings = card.card_sets || [];
  let bestMatch = null;

  for (const code of codes) {
    const variants = buildSetCodeVariants(code);
    for (const printing of printings) {
      const normalizedPrintingCode = normalizeSetCodeCandidate(printing.set_code || '');
      for (const variant of variants) {
        const normalizedVariant = normalizeSetCodeCandidate(variant);
        if (!normalizedPrintingCode || !normalizedVariant) continue;
        if (normalizedVariant === normalizedPrintingCode) {
          const score = 2;
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { printing, score, code };
          }
          break;
        }
        if (normalizedVariant.includes(normalizedPrintingCode) || normalizedPrintingCode.includes(normalizedVariant)) {
          const score = 1;
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { printing, score, code };
          }
        }
      }
      if (bestMatch && bestMatch.printing === printing) {
        break;
      }
    }
  }

  return bestMatch;
}

function showScanPreview(code) {
  if (!scanPreview || !scanPreviewCode) return;
  scanPreviewCode.textContent = code;
  scanPreview.classList.add('active');
}

function hideScanPreview() {
  if (!scanPreview) return;
  scanPreview.classList.remove('active');
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
}

function exitFullscreenMode() {
  document.body.classList.remove('fullscreen-camera');
  document.body.style.overflow = '';
  document.body.style.touchAction = '';
  document.body.style.overscrollBehavior = '';
  if (captureBtn) captureBtn.disabled = false;
}

async function closeCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  stream = null;
  if (video) {
    video.srcObject = null;
  }
  exitFullscreenMode();
  showHomeScreen();
  hideScanPreview();
  logMessage('Camera closed.');
}

async function recognizeImage(blob) {
  logMessage('Capturing...');
  updateResult('Scanning card...');

  try {
    const image = await loadImage(blob);
    logMessage('Reading card name...');
    const detectedName = await readCardName(image);
    if (!detectedName) {
      updateResult('No card name detected. Try a clearer photo.');
      logMessage('No card name detected.');
      return;
    }

    logMessage('Searching database...');
    const cards = await fetchCardsByName(detectedName);
    if (!cards.length) {
      updateResult('No matching card found by name.');
      logMessage('No matching card found.');
      return;
    }

    logMessage('Reading set code...');
    const { text: rawSetText, codes } = await readSetCode(image);
    if (!codes.length) {
      updateResult('No set code detected. Align the code inside the guide.');
      logMessage('No set code detected.');
      return;
    }

    logMessage('Matching...');
    let bestMatch = null;
    for (const card of cards) {
      const nameComparison = compareNames(detectedName, card.name || '');
      const localMatch = findBestLocalMatch(codes, card);
      if (!localMatch) continue;
      const score = localMatch.score + (nameComparison.exact ? 2 : nameComparison.fuzzy ? 1 : 0);
      if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && (nameComparison.similarity || 0) > bestMatch.similarity)) {
        bestMatch = {
          card,
          printing: localMatch.printing,
          score,
          similarity: nameComparison.similarity || 0,
          rawSetText
        };
      }
    }

    if (!bestMatch) {
      updateResult('No matching set code found locally.');
      logMessage('No matching set code found.');
      return;
    }

    const edition = detectEdition(rawSetText);
    const card = bestMatch.card;
    const printing = bestMatch.printing || {};
    const matchedSetCode = printing.set_code || '';
    const cardInfo = {
      name: card.name || 'Unknown',
      setName: printing.set_name || '',
      rarity: printing.set_rarity || '',
      image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || ''
    };

    updateResult(`${matchedSetCode} — ${cardInfo.name || 'Unknown'} (${cardInfo.setName || edition})`);
    addEntry(matchedSetCode, cardInfo.name, rawSetText, edition, cardInfo.setName, cardInfo.rarity, cardInfo.image, 'high');
    showScanPreview(matchedSetCode);
    logMessage('Saved.');
  } catch (error) {
    console.error(error);
    updateResult('OCR failed. Use a clear, well-lit photo of the card.');
    logMessage('OCR failed.');
  }
}

async function openCamera() {
  showScannerScreen();
  const secure = window.isSecureContext || location.protocol === 'http:' && location.hostname === 'localhost';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !secure) {
    logMessage('Camera unavailable here. Opening the upload picker instead.');
    if (fileInput) {
      fileInput.click();
    }
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    if (video) {
      video.srcObject = stream;
      await video.play();
    }
    enterFullscreenMode();
    hideScanPreview();
    logMessage('Camera open. Place the card inside the frame and tap Scan.');
  } catch (error) {
    console.error(error);
    logMessage('Unable to open the camera. Opening the upload picker instead.');
    if (fileInput) {
      fileInput.click();
    }
  }
}

async function scanCard() {
  const canCaptureVideo = !!(video && video.readyState >= 2 && video.videoWidth && video.videoHeight);
  if (stream || canCaptureVideo) {
    canvas.width = video.videoWidth || video.clientWidth;
    canvas.height = video.videoHeight || video.clientHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve, reject) => {
      canvas.toBlob(async blob => {
        if (!blob) {
          reject(new Error('Unable to capture image.'));
          return;
        }
        try {
          await recognizeImage(blob);
          resolve();
        } catch (error) {
          console.error(error);
          reject(error);
        }
      }, 'image/png');
    });
  }

  if (canvas.width && canvas.height) {
    logMessage('Scanning the last captured image...');
    return new Promise((resolve, reject) => {
      canvas.toBlob(async blob => {
        if (!blob) {
          reject(new Error('Unable to scan the existing image.'));
          return;
        }
        try {
          await recognizeImage(blob);
          resolve();
        } catch (error) {
          console.error(error);
          reject(error);
        }
      }, 'image/png');
    });
  }

  if (fileInput) {
    logMessage('No camera image available. Choose an image to scan.');
    fileInput.click();
    return null;
  }

  logMessage('Open the camera first or upload an image.');
  return null;
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
        if (!blob) return;
        try {
          await recognizeImage(blob);
        } catch (error) {
          console.error(error);
          updateResult('OCR failed on uploaded image.');
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
        name: entry.name || 'Unknown',
        setName: entry.setName || '',
        rarity: entry.rarity || '',
        lastScannedAt: entry.scannedAt
      };
    }
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
  logMessage('CSV downloaded.');
}

function clearSheet() {
  if (!confirm('Clear all scanned entries from the sheet?')) return;
  entries = [];
  saveEntries();
  renderEntries();
  updateResult('Sheet cleared.');
  logMessage('All entries removed.');
}

window.addEventListener('resize', () => hideScanPreview());
window.addEventListener('orientationchange', () => setTimeout(hideScanPreview, 150));
if (video) {
  video.addEventListener('loadedmetadata', () => hideScanPreview());
  video.addEventListener('playing', () => hideScanPreview());
}
if (openCameraBtn) openCameraBtn.addEventListener('click', openCamera);
if (scanListBtn) scanListBtn.addEventListener('click', showEntriesPanel);
if (captureBtn) captureBtn.addEventListener('click', scanCard);
if (scanBtn) scanBtn.addEventListener('click', scanCard);
if (closeCameraBtn) closeCameraBtn.addEventListener('click', closeCamera);
if (uploadBtn) uploadBtn.addEventListener('click', () => fileInput.click());
if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      handleFileUpload(fileInput.files[0]);
    }
  });
}
if (exportBtn) exportBtn.addEventListener('click', exportCsv);
if (clearBtn) clearBtn.addEventListener('click', clearSheet);
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
