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
const homeScreen = document.querySelector('.home-screen');
const scannerScreen = document.querySelector('.scanner-screen');
const entriesPanel = document.querySelector('.entries-panel');
const entriesTableBody = document.querySelector('#entriesTable tbody');
const scanListBack = document.getElementById('scanListBack');

let stream = null;
let entries = JSON.parse(localStorage.getItem('ygoscanner_entries') || '[]');
const DEBUG_NAME_OCR = true; // set to true to show the name-crop debug rectangle

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
      // If a detectedName was provided, prefer a card whose name matches exactly (case-insensitive)
      if (detectedName) {
        const nameNorm = (detectedName || '').trim().toLowerCase();
        const nameMatch = exactResult.exactMatches.find(e => (e.card && e.card.name && e.card.name.trim().toLowerCase()) === nameNorm);
        if (nameMatch) {
          console.log('fetchCardInfo: exact set_code and name match for', norm, nameMatch.matchedCode);
          logMessage('Database lookup: exact match (name confirmed)');
          const card = nameMatch.card;
          const matched = nameMatch.matched || {};
          return { name: card.name || 'Unknown', setName: matched.set_name || '', rarity: matched.set_rarity || '', image: (card.card_images && card.card_images[0] && card.card_images[0].image_url) || '', matchType: 'exact', matchedCode: nameMatch.matchedCode, confidence: 'high' };
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

async function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
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

function getGuideCropRect() {
  if (!video.videoWidth || !video.videoHeight || !guideWindow) return null;
  const videoRect = video.getBoundingClientRect();
  const guideRect = guideWindow.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height) return null;

  const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
  const sourceVisibleWidth = videoRect.width / scale;
  const sourceVisibleHeight = videoRect.height / scale;
  const offsetX = Math.max(0, (video.videoWidth - sourceVisibleWidth) / 2);
  const offsetY = Math.max(0, (video.videoHeight - sourceVisibleHeight) / 2);

  const x = Math.round((guideRect.left - videoRect.left) / scale + offsetX);
  const y = Math.round((guideRect.top - videoRect.top) / scale + offsetY);
  const width = Math.round(guideRect.width / scale);
  const height = Math.round(guideRect.height / scale);

  return {
    x: Math.max(0, Math.min(video.videoWidth, x)),
    y: Math.max(0, Math.min(video.videoHeight, y)),
    width: Math.min(video.videoWidth - x, width),
    height: Math.min(video.videoHeight - y, height)
  };
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

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  preprocessNameCanvas(tempCanvas);

  return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
}

async function extractNameFromBlob(blob) {
  try {
    const nameBlob = await cropNameBlob(blob);
    if (!nameBlob) return '';
    const ocr = await Tesseract.recognize(nameBlob, 'eng', {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '’-:,.()",
      tessedit_pageseg_mode: 7,
    });
    let text = (ocr.data.text || '').trim();
    text = text.replace(/[\r\n]+/g, ' ');
    text = text.replace(/[^A-Za-z0-9\u00C0-\u024F'’\-:\,\.\(\) ]+/g, '');
    text = text.replace(/\s+/g, ' ').trim();
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

  const cropWidth = Math.max(180, Math.round(cardWidth * 0.30));
  const cropHeight = Math.max(60, Math.round(cardHeight * 0.07));
  const x = Math.min(img.width - cropWidth, Math.max(0, Math.round(cardX + cardWidth * 0.65)));
  const y = Math.min(img.height - cropHeight, Math.max(0, Math.round(cardY + cardHeight * 0.72)));

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  enhanceCroppedCanvas(tempCanvas);

  return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
}

async function recognizeImage(blob) {
  logMessage('Recognizing text, this may take a moment...');
  updateResult('Scanning the right-side set code area...');

  try {
    const codeCropBlob = await cropSetCodeBlob(blob);
    const ocrResult = await Tesseract.recognize(codeCropBlob, 'eng', {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
      tessedit_pageseg_mode: 7,
      preserve_interword_spaces: '0',
      logger: m => {
        if (m.status && m.progress !== undefined) {
          const percent = Math.round(m.progress * 100);
          logMessage(`${m.status} (${percent}%)`);
        }
      }
    });

    const setText = (ocrResult.data.text || '').toUpperCase();
    const rawText = setText.trim();
    const codes = extractSetCodes(setText);

    if (codes.length === 0) {
      updateResult('No set code detected. Align the card so the bottom-right code is inside the box.');
      logMessage(`No valid set code found. OCR text: ${rawText.replace(/\n/g, ' ')}`);
      return;
    }

    const bestMatch = await findBestSetCode(codes);
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

    // detectedName is not yet extracted from OCR; pass undefined for now.
    // Run name OCR on the captured full image to provide an optional detected card name
    const detectedName = await extractNameFromBlob(blob);
    if (detectedName) console.log('Detected name OCR:', detectedName);

    const cardInfo = await fetchCardInfo(bestMatch, detectedName || undefined);

    if (cardInfo.matchType === 'exact') {
      console.log('Lookup path: exact');
      logMessage('Lookup path: exact match');
    } else if (cardInfo.matchType === 'normalized') {
      console.log('Lookup path: normalized');
      logMessage('Lookup path: normalized match');
    } else {
      console.log('Lookup path: none');
      logMessage('Lookup path: no database match');
    }

    updateResult(`Detected ${bestMatch} — ${cardInfo.name || 'Unknown'} (${cardInfo.setName || edition})`);
    // Always save the scan; if no DB match, name will be 'Unknown' and other fields empty
    addEntry(bestMatch, cardInfo.name || 'Unknown', rawText, edition, cardInfo.setName, cardInfo.rarity, cardInfo.image, cardInfo.confidence || 'low');
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

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (blob) {
        await recognizeImage(blob);
        resolve();
      } else {
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
          await recognizeImage(blob);
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
