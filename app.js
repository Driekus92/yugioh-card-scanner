const openCameraBtn = document.getElementById('openCameraBtn');
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
const entriesTableBody = document.querySelector('#entriesTable tbody');

let stream = null;
let entries = JSON.parse(localStorage.getItem('ygoscanner_entries') || '[]');

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

function addEntry(setCode, cardName, rawText, edition) {
  const entry = {
    setCode,
    cardName: cardName || 'Unknown',
    edition: edition || 'Other',
    rawText: rawText || '',
    scannedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
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
        cardName: entry.cardName,
        rawText: entry.rawText,
        count: 0,
        lastScannedAt: entry.scannedAt,
      };
    }
    map[key].count += 1;
    if (entry.cardName !== 'Unknown' && entry.cardName.length > (map[key].cardName || '').length) {
      map[key].cardName = entry.cardName;
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
      <td>${entry.edition}</td>
      <td>${entry.count}</td>
      <td>${entry.cardName}</td>
      <td>${entry.rawText.replace(/\n/g, ' ').slice(0, 120)}</td>
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

function enterFullscreenMode() {
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
  video.srcObject = null;
  exitFullscreenMode();
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
  const y = Math.min(img.height - cropHeight, Math.max(0, Math.round(cardY + cardHeight * 0.75)));

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
      return;
    }

    const edition = detectEdition(rawText);
    updateResult(`Detected set code: ${bestMatch} (${edition})`);
    logMessage('Set code found and validated against database.');
    addEntry(bestMatch, 'Unknown', rawText, edition);
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
    const edition = entry.edition || 'Other';
    const key = `${entry.setCode}|${edition}`;
    if (!map[key]) {
      map[key] = {
        setCode: entry.setCode,
        edition,
        cardName: entry.cardName,
        rawText: entry.rawText,
        count: 0,
        lastScannedAt: entry.scannedAt
      };
    }
    map[key].count += 1;
    if (entry.cardName !== 'Unknown' && entry.cardName.length > (map[key].cardName || '').length) {
      map[key].cardName = entry.cardName;
    }
    if (entry.rawText.length > map[key].rawText.length) {
      map[key].rawText = entry.rawText;
    }
    if (entry.scannedAt > map[key].lastScannedAt) {
      map[key].lastScannedAt = entry.scannedAt;
    }
    return map;
  }, {});

  const uniqueEntries = Object.values(grouped).sort((a, b) => {
    const prefixCompare = compareSetCodes(a.setCode, b.setCode);
    if (prefixCompare !== 0) return prefixCompare;
    if (a.edition < b.edition) return -1;
    if (a.edition > b.edition) return 1;
    return a.lastScannedAt.localeCompare(b.lastScannedAt);
  });

  const header = ['Set Code', 'Edition', 'Quantity', 'Card Name', 'Raw Text', 'Last Scanned'];
  const rows = uniqueEntries.map(entry => [
    entry.setCode,
    entry.edition,
    entry.count,
    entry.cardName,
    entry.rawText.replace(/"/g, '""'),
    entry.lastScannedAt
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
