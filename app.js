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
    .replace(/([A-Z]{2,5})\s+(\d{3,4})\b/g, '$1-$2')
    .replace(/([A-Z]{2,5})(\d{3,4})\b/g, '$1-$2')
    .trim();

  const regex = /\b([A-Z0-9]+(?:-[A-Z0-9]+)*)-(\d{3,4})\b/g;
  const codes = [];
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    const prefix = match[1];
    const number = match[2];
    if (prefix && number) {
      codes.push(`${prefix}-${number}`);
    }
  }

  return [...new Set(codes)];
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

async function cropBottomAreaBlob(blob) {
  const img = await loadImage(blob);
  const cropWidth = Math.max(220, Math.round(img.width * 0.8));
  const cropHeight = Math.max(140, Math.round(img.height * 0.22));
  const x = Math.max(0, Math.round((img.width - cropWidth) / 2));
  const y = Math.max(0, img.height - cropHeight - 10);

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
}

async function cropTopTitleBlob(blob) {
  const img = await loadImage(blob);
  const cropWidth = Math.max(200, Math.round(img.width * 0.75));
  const cropHeight = Math.max(90, Math.round(img.height * 0.13));
  const x = Math.max(0, Math.round((img.width - cropWidth) / 2));
  const y = Math.max(0, Math.round(img.height * 0.02));

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropWidth;
  tempCanvas.height = cropHeight;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
}

async function recognizeImage(blob) {
  logMessage('Recognizing text, this may take a moment...');
  updateResult('Scanning image for set code...');

  try {
    const setCropBlob = await cropBottomAreaBlob(blob);
    const titleCropBlob = await cropTopTitleBlob(blob);

    const [setCropResult, titleCropResult] = await Promise.all([
      Tesseract.recognize(setCropBlob, 'eng', {
        logger: m => {
          if (m.status && m.progress !== undefined) {
            const percent = Math.round(m.progress * 100 * 0.5);
            logMessage(`${m.status} (${percent}%)`);
          }
        }
      }),
      Tesseract.recognize(titleCropBlob, 'eng', {
        logger: m => {
          if (m.status && m.progress !== undefined) {
            const percent = Math.round(50 + m.progress * 100 * 0.5);
            logMessage(`${m.status} (${percent}%)`);
          }
        }
      })
    ]);

    const setText = setCropResult.data.text || '';
    const titleText = titleCropResult.data.text || '';
    const codes = extractSetCodes(setText);
    let fullText = `${titleText}\n${setText}`;
    let cardName = guessCardName(titleText) || guessCardName(fullText);

    if (codes.length === 0) {
      const fullResult = await Tesseract.recognize(blob, 'eng', {
        logger: m => {
          if (m.status && m.progress !== undefined) {
            const percent = Math.round(m.progress * 100);
            logMessage(`${m.status} (${percent}%)`);
          }
        }
      });
      const collectedText = fullResult.data.text || '';
      fullText = `${titleText}\n${setText}\n${collectedText}`;
      codes.push(...extractSetCodes(collectedText));
      cardName = cardName || guessCardName(collectedText);
    }

    if (codes.length === 0) {
      updateResult('No set code detected. Try another scan or upload a clearer image.');
      logMessage(`No valid set code found. OCR text: ${fullText.slice(0, 120).replace(/\n/g, ' ')}`);
      return;
    }

    const setCode = codes[0];
    const edition = detectEdition(fullText);
    updateResult(`Detected set code: ${setCode}${cardName ? ' for ' + cardName : ''} (${edition})`);
    logMessage('Set code found and added to the sheet.');
    addEntry(setCode, cardName, fullText, edition);
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
    captureBtn.disabled = false;
    logMessage('Camera open. Align the card and tap Scan Card.');
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
