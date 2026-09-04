(function (root, factory) {
  'use strict';

  var api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.YgoExcel = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var DEFAULT_FILENAME = 'yugioh-kaarten.xlsx';
  var MAX_EXCEL_ROWS = 1048576;
  var MAX_DATA_ROWS = MAX_EXCEL_ROWS - 1;
  var MAX_CELL_LENGTH = 32767;
  var ZIP_UTF8_FLAG = 0x0800;
  var ZIP_STORE_METHOD = 0;
  var DOS_TIME = 0;
  var DOS_DATE = 0x0021;
  var CRC_TABLE = null;

  function createWorkbookBlob(entries) {
    var BlobConstructor = root && root.Blob;
    if (typeof BlobConstructor !== 'function') {
      throw new Error('Excel-export is niet beschikbaar: deze omgeving ondersteunt geen Blob-bestanden.');
    }

    return new BlobConstructor([createWorkbookBytes(entries)], { type: XLSX_MIME });
  }

  function downloadWorkbook(entries, filename) {
    var documentObject = root && root.document;
    var urlApi = root && (root.URL || root.webkitURL);

    if (!documentObject || !urlApi || typeof urlApi.createObjectURL !== 'function') {
      throw new Error('Excel downloaden is alleen beschikbaar in een ondersteunde browser.');
    }

    var safeFilename = normalizeFilename(filename);
    var blob = createWorkbookBlob(entries);

    if (root.navigator && typeof root.navigator.msSaveOrOpenBlob === 'function') {
      root.navigator.msSaveOrOpenBlob(blob, safeFilename);
      return blob;
    }

    var link = documentObject.createElement('a');
    var objectUrl = urlApi.createObjectURL(blob);
    var parent = documentObject.body || documentObject.documentElement;

    link.href = objectUrl;
    link.download = safeFilename;
    link.rel = 'noopener';
    link.style.display = 'none';

    try {
      parent.appendChild(link);
      link.click();
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
      var revoke = function () {
        urlApi.revokeObjectURL(objectUrl);
      };
      if (root && typeof root.setTimeout === 'function') {
        root.setTimeout(revoke, 1000);
      } else {
        revoke();
      }
    }

    return blob;
  }

  function createWorkbookBytes(entries) {
    var normalized = normalizeEntries(entries);
    var files = [
      {
        name: '[Content_Types].xml',
        content: buildContentTypesXml()
      },
      {
        name: '_rels/.rels',
        content: buildPackageRelationshipsXml()
      },
      {
        name: 'xl/workbook.xml',
        content: buildWorkbookXml()
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: buildWorkbookRelationshipsXml()
      },
      {
        name: 'xl/styles.xml',
        content: buildStylesXml()
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: buildWorksheetXml(normalized.entries, normalized.rowCount)
      }
    ];

    return createStoredZip(files);
  }

  function normalizeEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError('Ongeldige invoer: verwacht een lijst met kaarten.');
    }

    var normalizedEntries = [];
    var rowCount = 0;

    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      var position = index + 1;

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('Ongeldige kaart op positie ' + position + ': verwacht een kaartobject.');
      }

      var preferredName = entry.cardName;
      if (preferredName === null || preferredName === undefined ||
          (typeof preferredName === 'string' && preferredName.trim() === '')) {
        preferredName = entry.name;
      }

      var cardName = normalizeRequiredText(preferredName, 'kaartnaam', position);
      var setCode = normalizeRequiredText(entry.setCode, 'set-code', position);
      var value = normalizeOptionalNumber(entry.value, position);
      var quantity = normalizeQuantity(entry.quantity, position);

      if (rowCount + quantity > MAX_DATA_ROWS) {
        throw new RangeError(
          'Te veel kaarten voor één Excel-werkblad: maximaal ' + MAX_DATA_ROWS + ' kaarten zijn toegestaan.'
        );
      }

      normalizedEntries.push({
        cardName: cardName,
        setCode: setCode,
        value: value,
        quantity: quantity
      });
      rowCount += quantity;
    }

    return {
      entries: normalizedEntries,
      rowCount: rowCount
    };
  }

  function normalizeRequiredText(value, fieldName, position) {
    if (value === null || value === undefined) {
      throw new TypeError('Ongeldige kaart op positie ' + position + ': ' + fieldName + ' ontbreekt.');
    }

    var valueType = typeof value;
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'bigint') {
      throw new TypeError('Ongeldige kaart op positie ' + position + ': ' + fieldName + ' moet tekst zijn.');
    }

    var text = sanitizeXmlText(String(value).trim());
    if (!text) {
      throw new TypeError('Ongeldige kaart op positie ' + position + ': ' + fieldName + ' ontbreekt.');
    }
    if (text.length > MAX_CELL_LENGTH) {
      throw new RangeError(
        'Ongeldige kaart op positie ' + position + ': ' + fieldName + ' is langer dan ' + MAX_CELL_LENGTH + ' tekens.'
      );
    }

    return text;
  }

  function normalizeQuantity(value, position) {
    if (value === null || value === undefined || value === '') {
      return 1;
    }

    var quantity;
    if (typeof value === 'number') {
      quantity = value;
    } else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
      quantity = Number(value.trim());
    } else {
      quantity = NaN;
    }

    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
      throw new TypeError(
        'Ongeldige hoeveelheid bij kaart ' + position + ': quantity moet een positief geheel getal zijn.'
      );
    }

    return quantity;
  }

  function normalizeOptionalNumber(value, position) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    var numberValue = null;
    if (typeof value === 'number') {
      numberValue = value;
    } else if (typeof value === 'string') {
      var trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      numberValue = parseLocalizedNumber(trimmed);
    }

    if (!Number.isFinite(numberValue)) {
      throw new TypeError(
        'Ongeldige waarde bij kaart ' + position + ': gebruik een geldig getal of laat het veld leeg.'
      );
    }

    return Object.is(numberValue, -0) ? 0 : numberValue;
  }

  function parseLocalizedNumber(text) {
    var compact = text.replace(/[\u00A0\u202F\s]/g, '');
    var normalized;

    if (/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(compact)) {
      normalized = compact.replace(',', '.');
    } else if (/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
      normalized = compact.replace(/\./g, '').replace(',', '.');
    } else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
      normalized = compact.replace(/,/g, '');
    } else {
      return NaN;
    }

    var result = Number(normalized);
    return Number.isFinite(result) ? result : NaN;
  }

  function normalizeFilename(filename) {
    if (filename === null || filename === undefined || filename === '') {
      return DEFAULT_FILENAME;
    }
    if (typeof filename !== 'string') {
      throw new TypeError('Ongeldige bestandsnaam: verwacht tekst.');
    }

    var safe = filename
      .trim()
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/[. ]+$/g, '');

    if (!safe || safe.toLowerCase() === '.xlsx') {
      return DEFAULT_FILENAME;
    }
    if (!/\.xlsx$/i.test(safe)) {
      safe += '.xlsx';
    }

    if (safe.length > 200) {
      safe = safe.slice(0, 195).replace(/[. ]+$/g, '') + '.xlsx';
    }

    return safe;
  }

  function buildContentTypesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>';
  }

  function buildPackageRelationshipsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
  }

  function buildWorkbookXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr date1904="0"/>' +
      '<bookViews><workbookView activeTab="0" firstSheet="0"/></bookViews>' +
      '<sheets><sheet name="Kaarten" sheetId="1" state="visible" r:id="rId1"/></sheets>' +
      '</workbook>';
  }

  function buildWorkbookRelationshipsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
  }

  function buildStylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF0A4D90"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9C4"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/>' +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>';
  }

  function buildWorksheetXml(entries, dataRowCount) {
    var lastRow = dataRowCount + 1;
    var rows = [
      '<row r="1" spans="1:3" ht="24" customHeight="1">',
      inlineStringCell('A1', 'Kaartnaam', 1),
      inlineStringCell('B1', 'Set-code', 1),
      inlineStringCell('C1', 'Waarde', 1),
      '</row>'
    ];
    var rowNumber = 2;

    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      for (var copy = 0; copy < entry.quantity; copy += 1) {
        rows.push(
          '<row r="' + rowNumber + '" spans="1:3">',
          inlineStringCell('A' + rowNumber, entry.cardName, 0),
          inlineStringCell('B' + rowNumber, entry.setCode, 3),
          numericOrBlankCell('C' + rowNumber, entry.value),
          '</row>'
        );
        rowNumber += 1;
      }
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:C' + lastRow + '"/>' +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' +
      '<col min="1" max="1" width="36" customWidth="1"/>' +
      '<col min="2" max="2" width="20" customWidth="1"/>' +
      '<col min="3" max="3" width="14" customWidth="1"/>' +
      '</cols>' +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      '<autoFilter ref="A1:C' + lastRow + '"/>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>';
  }

  function inlineStringCell(reference, value, styleId) {
    var style = styleId ? ' s="' + styleId + '"' : '';
    return '<c r="' + reference + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' +
      escapeXml(value) +
      '</t></is></c>';
  }

  function numericOrBlankCell(reference, value) {
    if (value === null) {
      return '<c r="' + reference + '" s="2"/>';
    }
    return '<c r="' + reference + '" s="2"><v>' + numberToXml(value) + '</v></c>';
  }

  function numberToXml(value) {
    return String(value).replace('e', 'E');
  }

  function sanitizeXmlText(value) {
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  }

  function escapeXml(value) {
    return sanitizeXmlText(String(value))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function createStoredZip(files) {
    if (files.length > 0xffff) {
      throw new RangeError('Excel-export mislukt: het ZIP-bestand bevat te veel onderdelen.');
    }

    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var centralSize = 0;

    for (var index = 0; index < files.length; index += 1) {
      var file = files[index];
      var nameBytes = encodeUtf8(file.name);
      var dataBytes = encodeUtf8(file.content);
      var crc = crc32(dataBytes);

      assertZipSize(nameBytes.length, 'bestandsnaam');
      assertZipSize(dataBytes.length, file.name);
      assertZipSize(offset, 'ZIP-offset');

      if (nameBytes.length > 0xffff) {
        throw new RangeError('Excel-export mislukt: een interne bestandsnaam is te lang.');
      }

      var localHeader = buildLocalFileHeader(nameBytes, dataBytes.length, crc);
      var centralHeader = buildCentralDirectoryHeader(nameBytes, dataBytes.length, crc, offset);

      localParts.push(localHeader, dataBytes);
      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
      centralSize += centralHeader.length;
    }

    assertZipSize(offset, 'centrale ZIP-map');
    assertZipSize(centralSize, 'centrale ZIP-map');

    var endRecord = buildEndOfCentralDirectory(files.length, centralSize, offset);
    return concatenateBytes(localParts.concat(centralParts, [endRecord]));
  }

  function buildLocalFileHeader(nameBytes, dataSize, crc) {
    var header = new Uint8Array(30 + nameBytes.length);
    var view = new DataView(header.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, ZIP_UTF8_FLAG, true);
    view.setUint16(8, ZIP_STORE_METHOD, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, dataSize, true);
    view.setUint32(22, dataSize, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    return header;
  }

  function buildCentralDirectoryHeader(nameBytes, dataSize, crc, localOffset) {
    var header = new Uint8Array(46 + nameBytes.length);
    var view = new DataView(header.buffer);

    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, ZIP_UTF8_FLAG, true);
    view.setUint16(10, ZIP_STORE_METHOD, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, dataSize, true);
    view.setUint32(24, dataSize, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, localOffset, true);
    header.set(nameBytes, 46);

    return header;
  }

  function buildEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
    var record = new Uint8Array(22);
    var view = new DataView(record.buffer);

    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);

    return record;
  }

  function assertZipSize(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError('Excel-export is te groot voor ZIP: ' + label + ' overschrijdt de limiet.');
    }
  }

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = buildCrcTable();
    }

    var crc = 0xffffffff;
    for (var index = 0; index < bytes.length; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildCrcTable() {
    var table = new Uint32Array(256);
    for (var index = 0; index < 256; index += 1) {
      var value = index;
      for (var bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function encodeUtf8(value) {
    var stringValue = String(value);
    var TextEncoderConstructor = root && root.TextEncoder;
    if (typeof TextEncoderConstructor === 'function') {
      return new TextEncoderConstructor().encode(stringValue);
    }

    var bytes = [];
    for (var index = 0; index < stringValue.length; index += 1) {
      var codePoint = stringValue.charCodeAt(index);

      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        var low = stringValue.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >>> 6));
        bytes.push(0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        bytes.push(0xe0 | (codePoint >>> 12));
        bytes.push(0x80 | ((codePoint >>> 6) & 0x3f));
        bytes.push(0x80 | (codePoint & 0x3f));
      } else {
        bytes.push(0xf0 | (codePoint >>> 18));
        bytes.push(0x80 | ((codePoint >>> 12) & 0x3f));
        bytes.push(0x80 | ((codePoint >>> 6) & 0x3f));
        bytes.push(0x80 | (codePoint & 0x3f));
      }
    }

    return new Uint8Array(bytes);
  }

  function concatenateBytes(parts) {
    var totalLength = 0;
    for (var index = 0; index < parts.length; index += 1) {
      totalLength += parts[index].length;
    }

    if (!Number.isSafeInteger(totalLength) || totalLength > 0xffffffff) {
      throw new RangeError('Excel-export is te groot om als bestand op te bouwen.');
    }

    var result = new Uint8Array(totalLength);
    var offset = 0;
    for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
      result.set(parts[partIndex], offset);
      offset += parts[partIndex].length;
    }

    return result;
  }

  var publicApi = {
    createWorkbookBlob: createWorkbookBlob,
    downloadWorkbook: downloadWorkbook
  };

  return typeof Object.freeze === 'function' ? Object.freeze(publicApi) : publicApi;
});
