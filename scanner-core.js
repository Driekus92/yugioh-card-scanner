(function attachYgoScannerCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.YgoScannerCore = core;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createYgoScannerCore() {
  'use strict';

  const STATE_VERSION = 1;
  const MAX_STORED_ENTRIES = 10000;
  const MAX_ENTRY_QUANTITY = 1000;
  const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
  const OCR_DIGIT_GROUPS = [
    new Set(['0', 'O']),
    new Set(['1', 'I', 'L']),
    new Set(['2', 'Z']),
    new Set(['5', 'S']),
    new Set(['6', 'G']),
    new Set(['8', 'B'])
  ];
  const COMMON_LANGUAGE_MARKERS = new Set([
    'A', 'AE', 'DE', 'E', 'EN', 'ES', 'EU', 'FR', 'IT', 'JP', 'KR', 'NA', 'PT', 'SP'
  ]);

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function readOwn(record, keys) {
    if (!isRecord(record)) return undefined;
    for (const key of keys) {
      try {
        if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
      } catch (error) {
        return undefined;
      }
    }
    return undefined;
  }

  function safeText(value, maxLength, fallback) {
    if (typeof value !== 'string' && typeof value !== 'number') return fallback || '';
    let text;
    try {
      text = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    } catch (error) {
      return fallback || '';
    }
    return text.slice(0, maxLength);
  }

  function safeQuantity(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(MAX_ENTRY_QUANTITY, Math.max(1, Math.trunc(parsed)));
  }

  function safeValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return safeText(value, 80, '');
  }

  function safeImageUrl(value) {
    const text = safeText(value, 2048, '');
    if (!text) return '';
    try {
      const url = new URL(text);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function normalizeSetCode(value) {
    return safeText(value, 80, '')
      .toUpperCase()
      .replace(DASHES, '-')
      .replace(/[\/\\]/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/[^A-Z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function splitSetCode(value) {
    const normalized = normalizeSetCode(value);
    const match = /^([A-Z0-9]{2,8})-([A-Z0-9]{1,8})$/.exec(normalized);
    if (!match) return null;
    return { normalized, prefix: match[1], suffix: match[2] };
  }

  function trailingOcrNumber(suffix) {
    const actualDigits = /([0-9]{1,4})$/.exec(suffix);
    if (actualDigits) return actualDigits[1];
    const confusedDigits = /([0-9OILZSBG]{2,4})$/.exec(suffix);
    return confusedDigits ? confusedDigits[1] : '';
  }

  function looksLikeSetCode(value) {
    const parts = splitSetCode(value);
    if (!parts || !/[A-Z]/.test(parts.prefix)) return false;
    const number = trailingOcrNumber(parts.suffix);
    if (!number) return false;
    const marker = parts.suffix.slice(0, parts.suffix.length - number.length);
    return marker.length <= 3;
  }

  function undashedCandidateScore(candidate) {
    const parts = splitSetCode(candidate);
    if (!parts) return -Infinity;
    const number = trailingOcrNumber(parts.suffix);
    const marker = parts.suffix.slice(0, parts.suffix.length - number.length);
    let score = 0;
    if (number.length === 3) score += 12;
    else if (number.length === 4) score += 9;
    else if (number.length === 2) score += 5;
    else score += 2;
    if (!marker) score += 8;
    else if (COMMON_LANGUAGE_MARKERS.has(marker)) score += 10;
    else if (marker.length <= 2) score += 1;
    if (parts.prefix.length === 3 || parts.prefix.length === 4) score += 6;
    else if (parts.prefix.length >= 2 && parts.prefix.length <= 6) score += 2;
    return score;
  }

  function inferUndashedSetCodes(token) {
    const cleaned = safeText(token, 24, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length < 5 || cleaned.length > 16 || !/[A-Z]/.test(cleaned)) return [];

    const possibilities = [];
    for (let splitAt = 2; splitAt <= cleaned.length - 2; splitAt += 1) {
      const candidate = `${cleaned.slice(0, splitAt)}-${cleaned.slice(splitAt)}`;
      if (looksLikeSetCode(candidate)) {
        possibilities.push({ candidate, score: undashedCandidateScore(candidate), splitAt });
      }
    }
    possibilities.sort((left, right) => (
      right.score - left.score
      || left.splitAt - right.splitAt
      || left.candidate.localeCompare(right.candidate, 'en')
    ));
    return possibilities.map(item => item.candidate);
  }

  function extractSetCodeCandidates(text) {
    const prepared = safeText(text, 2000, '')
      .toUpperCase()
      .replace(DASHES, '-')
      .replace(/\s+[\/\\]\s+/g, ' ')
      .replace(/[\/\\]/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/[^A-Z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!prepared) return [];

    const candidates = [];
    const seen = new Set();
    const add = (candidate) => {
      const normalized = normalizeSetCode(candidate);
      if (!seen.has(normalized) && looksLikeSetCode(normalized)) {
        seen.add(normalized);
        candidates.push(normalized);
      }
    };

    // Herstel codes waarvan OCR de cijferreeks als losse tekens teruggeeft,
    // bijvoorbeeld "LOB-0 0 1" of "LOB - 0 0 1".
    const spacedSuffixPattern = /(?:^|\s)([A-Z0-9]{2,8})-\s*((?:[A-Z]|[0-9OILZSBG])(?:\s*(?:[A-Z]|[0-9OILZSBG])){1,3})(?=\s|$)/g;
    let spacedMatch;
    while ((spacedMatch = spacedSuffixPattern.exec(prepared)) !== null) {
      const suffix = spacedMatch[2].replace(/\s+/g, '');
      add(`${spacedMatch[1]}-${suffix}`);
    }

    const directPattern = /(?:^|\s)([A-Z0-9]{2,8}-[A-Z0-9]{1,8})(?=\s|$)/g;
    let match;
    while ((match = directPattern.exec(prepared)) !== null) add(match[1]);

    const tokens = prepared.split(/\s+/).filter(Boolean);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const prefix = tokens[index];
      const suffix = tokens[index + 1];
      const prefixIsPlausible = /^[A-Z0-9]{2,8}$/.test(prefix) && /[A-Z]/.test(prefix);
      const suffixIsPlausible = /^(?:[A-Z]{1,2})?[0-9OILZSBG]{2,4}$/.test(suffix);
      if (prefixIsPlausible && suffixIsPlausible) {
        add(`${tokens[index]}-${tokens[index + 1]}`);
      }
      if (
        index < tokens.length - 2
        && prefixIsPlausible
        && COMMON_LANGUAGE_MARKERS.has(tokens[index + 1])
        && /^[0-9OILZSBG]{2,4}$/.test(tokens[index + 2])
      ) {
        add(`${tokens[index]}-${tokens[index + 1]}${tokens[index + 2]}`);
      }

      // OCR splitst soms een code als "LOB - 0 0 1". Voeg losse cijfers/verwarrende
      // OCR-tekens weer samen tot een kandidaat voordat we hem vergelijken met de API.
      const splitPrefix = prefix.replace(/-$/, '');
      if (/^[A-Z0-9]{2,8}$/.test(splitPrefix) && /[A-Z]/.test(splitPrefix)) {
        for (let length = 2; length <= 4 && index + length < tokens.length; length += 1) {
          const pieces = tokens.slice(index + 1, index + 1 + length);
          if (pieces.every(piece => /^[0-9OILZSBG]$/.test(piece))) {
            add(`${splitPrefix}-${pieces.join('')}`);
          }
        }
      }
      if (/^[A-Z0-9]{2,8}$/.test(prefix) && /[A-Z]/.test(prefix) && suffix === '-' && index + 4 < tokens.length) {
        for (let length = 2; length <= 4; length += 1) {
          const pieces = tokens.slice(index + 2, index + 2 + length);
          if (pieces.length === length && pieces.every(piece => /^[0-9OILZSBG]$/.test(piece))) {
            add(`${prefix}-${pieces.join('')}`);
          }
        }
      }
    }

    for (const token of tokens) {
      if (!token || token.includes('-')) continue;
      for (const candidate of inferUndashedSetCodes(token)) add(candidate);
    }
    return candidates;
  }

  const OCR_PREFIX_GROUPS = [
    new Set(['O', '0', 'Q']),
    new Set(['S', '5', 'O']),
    new Set(['D', '0']),
    new Set(['B', '8']),
    new Set(['G', '6']),
    new Set(['Z', '2']),
    new Set(['I', '1', 'L']),
    new Set(['T', '7'])
  ];

  function sameOcrDigitGroup(left, right) {
    if (left === right) return true;
    return OCR_DIGIT_GROUPS.some(group => group.has(left) && group.has(right));
  }

  function sameOcrPrefixGroup(left, right) {
    if (left === right) return true;
    return OCR_PREFIX_GROUPS.some(group => group.has(left) && group.has(right));
  }

  function compareSetCodeCandidate(ocrCandidate, apiSetCode) {
    const candidate = splitSetCode(ocrCandidate);
    const api = splitSetCode(apiSetCode);
    const noMatch = {
      matched: false,
      exact: false,
      score: 0,
      corrections: [],
      candidate: candidate ? candidate.normalized : normalizeSetCode(ocrCandidate),
      setCode: api ? api.normalized : normalizeSetCode(apiSetCode)
    };
    if (!candidate || !api) return noMatch;
    if (candidate.normalized === api.normalized) {
      return { ...noMatch, matched: true, exact: true, score: 1 };
    }
    if (candidate.suffix.length !== api.suffix.length) {
      return noMatch;
    }

    const corrections = [];

    // OCR laat bij kleine setcodes soms één karakter weg of verwisselt één
    // letter, bijvoorbeeld "SDY-003" -> "OY-003". Vergelijk daarom het
    // prefix met maximaal één invoeging/verwijdering en maximaal één bekende
    // OCR-letterverwisseling. De suffix moet dezelfde lengte houden.
    if (candidate.prefix.length === api.prefix.length) {
      for (let index = 0; index < api.prefix.length; index += 1) {
        const from = candidate.prefix[index];
        const to = api.prefix[index];
        if (from === to) continue;
        if (!sameOcrPrefixGroup(from, to)) return noMatch;
        corrections.push({ section: 'prefix', index, from, to });
      }
    } else if (Math.abs(candidate.prefix.length - api.prefix.length) === 1) {
      const shorter = candidate.prefix.length < api.prefix.length ? candidate.prefix : api.prefix;
      const longer = candidate.prefix.length < api.prefix.length ? api.prefix : candidate.prefix;
      let bestAlignment = null;

      for (let skipped = 0; skipped < longer.length; skipped += 1) {
        let shortIndex = 0;
        let substitutions = 0;
        const alignment = [];
        let valid = true;
        for (let longIndex = 0; longIndex < longer.length; longIndex += 1) {
          if (longIndex === skipped) continue;
          if (shortIndex >= shorter.length) { valid = false; break; }
          const longChar = longer[longIndex];
          const shortChar = shorter[shortIndex];
          if (longChar !== shortChar) {
            if (!sameOcrPrefixGroup(longChar, shortChar)) { valid = false; break; }
            substitutions += 1;
            alignment.push({ section: 'prefix', index: longIndex, from: shortChar, to: longChar });
          }
          shortIndex += 1;
        }
        if (valid && shortIndex === shorter.length && substitutions <= 1) {
          const omitted = {
            section: 'prefix',
            index: skipped,
            from: candidate.prefix.length > api.prefix.length ? candidate.prefix[skipped] : '',
            to: api.prefix.length > candidate.prefix.length ? api.prefix[skipped] : ''
          };
          const score = substitutions;
          if (!bestAlignment || score < bestAlignment.substitutions) {
            bestAlignment = { substitutions, corrections: [omitted, ...alignment] };
          }
        }
      }

      if (!bestAlignment) return noMatch;
      corrections.push(...bestAlignment.corrections);
    } else {
      return noMatch;
    }

    const numericMatch = /[0-9]+$/.exec(api.suffix);
    if (!numericMatch) return noMatch;
    const numericStart = api.suffix.length - numericMatch[0].length;
    for (let index = 0; index < api.suffix.length; index += 1) {
      const from = candidate.suffix[index];
      const to = api.suffix[index];
      if (from === to) continue;
      if (index < numericStart || !sameOcrDigitGroup(from, to)) return noMatch;
      corrections.push({ section: 'number', index, from, to });
    }

    if (!corrections.length || corrections.length > 3) return noMatch;
    const penalty = corrections.reduce((sum, correction) => (
      sum + (correction.section === 'prefix'
        ? (correction.from && correction.to ? 0.10 : 0.14)
        : 0.06)
    ), 0);
    return {
      ...noMatch,
      matched: true,
      score: Math.max(0.7, Number((1 - penalty).toFixed(6))),
      corrections
    };
  }

  function normalizeCardName(value) {
    let text = safeText(value, 300, '');
    if (!text) return '';
    try {
      text = text.normalize('NFKD').replace(/\p{M}/gu, '');
    } catch (error) {
      // Older browsers still receive the ASCII-safe cleanup below.
    }
    text = text
      .replace(/[’`´]/g, "'")
      .replace(DASHES, '-')
      .replace(/&/g, ' and ')
      .replace(/[-'":;,.!?()[\]{}_/\\|@#$%^*+=~<>]/g, ' ');
    try {
      text = text.replace(/[^\p{L}\p{N} ]+/gu, ' ');
    } catch (error) {
      text = text.replace(/[^A-Za-z0-9 ]+/g, ' ');
    }
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function cleanCardNameForApi(value) {
    let text = safeText(value, 300, '');
    if (!text) return '';
    try {
      text = text.normalize('NFKC');
    } catch (error) {
      // Continue without Unicode normalization on older engines.
    }
    text = text
      .replace(/[’`´]/g, "'")
      .replace(DASHES, '-')
      .replace(/\s+/g, ' ')
      .trim();
    try {
      return text.replace(/[^\p{L}\p{N}\s'\-:,.()!?#&/@]/gu, ' ').replace(/\s+/g, ' ').trim();
    } catch (error) {
      return text.replace(/[^A-Za-z0-9\s'\-:,.()!?#&/@]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function levenshteinDistance(leftValue, rightValue) {
    const left = String(leftValue || '');
    const right = String(rightValue || '');
    if (!left.length) return right.length;
    if (!right.length) return left.length;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    let current = new Array(right.length + 1);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      current[0] = leftIndex;
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + cost
        );
      }
      const swap = previous;
      previous = current;
      current = swap;
    }
    return previous[right.length];
  }

  function editSimilarity(left, right) {
    const maxLength = Math.max(left.length, right.length);
    return maxLength ? 1 - levenshteinDistance(left, right) / maxLength : 1;
  }

  function exactTokenDice(leftTokens, rightTokens) {
    if (!leftTokens.length && !rightTokens.length) return 1;
    if (!leftTokens.length || !rightTokens.length) return 0;
    const remaining = rightTokens.slice();
    let intersection = 0;
    for (const token of leftTokens) {
      const index = remaining.indexOf(token);
      if (index >= 0) {
        intersection += 1;
        remaining.splice(index, 1);
      }
    }
    return (2 * intersection) / (leftTokens.length + rightTokens.length);
  }

  function directedTokenSimilarity(fromTokens, toTokens) {
    if (!fromTokens.length) return toTokens.length ? 0 : 1;
    if (!toTokens.length) return 0;
    let total = 0;
    for (const token of fromTokens) {
      let best = 0;
      for (const other of toTokens) best = Math.max(best, editSimilarity(token, other));
      total += best;
    }
    return total / fromTokens.length;
  }

  function tokenNameSimilarity(leftValue, rightValue) {
    const left = normalizeCardName(leftValue);
    const right = normalizeCardName(rightValue);
    const leftTokens = left ? left.split(' ') : [];
    const rightTokens = right ? right.split(' ') : [];
    const fuzzyAlignment = (
      directedTokenSimilarity(leftTokens, rightTokens)
      + directedTokenSimilarity(rightTokens, leftTokens)
    ) / 2;
    const exactDice = exactTokenDice(leftTokens, rightTokens);
    return Number((fuzzyAlignment * 0.7 + exactDice * 0.3).toFixed(6));
  }

  function compareCardNames(leftValue, rightValue) {
    const left = normalizeCardName(leftValue);
    const right = normalizeCardName(rightValue);
    if (!left || !right) {
      return { exact: false, score: 0, editSimilarity: 0, tokenSimilarity: 0, left, right };
    }
    if (left === right) {
      return { exact: true, score: 1, editSimilarity: 1, tokenSimilarity: 1, left, right };
    }
    const characterScore = editSimilarity(left, right);
    const tokenScore = tokenNameSimilarity(left, right);
    let score = characterScore * 0.72 + tokenScore * 0.28;
    if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 5) {
      score = Math.max(score, Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.94);
    }
    return {
      exact: false,
      score: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
      editSimilarity: Number(characterScore.toFixed(6)),
      tokenSimilarity: tokenScore,
      left,
      right
    };
  }

  function normalizeConfidence(value) {
    let confidence = Number(value);
    if (!Number.isFinite(confidence)) return 0;
    if (confidence > 1 && confidence <= 100) confidence /= 100;
    return Math.max(0, Math.min(1, confidence));
  }

  function prepareNameCandidates(input) {
    const values = Array.isArray(input) ? input : [input];
    const candidates = [];
    const seen = new Map();
    values.forEach((value, index) => {
      let text = value;
      let confidence = 0;
      if (isRecord(value)) {
        text = readOwn(value, ['text', 'name', 'lookupName', 'cleanedText', 'rawText']);
        confidence = normalizeConfidence(readOwn(value, ['confidence', 'score']));
      }
      const cleaned = cleanCardNameForApi(text);
      const normalized = normalizeCardName(cleaned);
      if (!normalized) return;
      const candidate = { text: cleaned, normalized, confidence, index };
      const existingIndex = seen.get(normalized);
      if (existingIndex === undefined) {
        seen.set(normalized, candidates.length);
        candidates.push(candidate);
      } else if (confidence > candidates[existingIndex].confidence) {
        candidates[existingIndex] = candidate;
      }
    });
    return candidates;
  }

  function extractNameCandidates(input) {
    const values = Array.isArray(input) ? input : [input];
    const expanded = [];
    for (const value of values) {
      if (typeof value === 'string') {
        const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length > 1) expanded.push(lines.join(' '));
        expanded.push(...lines);
      } else {
        expanded.push(value);
      }
    }
    return prepareNameCandidates(expanded).map(candidate => candidate.text);
  }

  function bestNameComparison(nameCandidates, cardName) {
    let best = null;
    for (const candidate of nameCandidates) {
      const comparison = compareCardNames(candidate.text, cardName);
      const item = { candidate, comparison };
      if (
        !best
        || comparison.score > best.comparison.score
        || (comparison.score === best.comparison.score && candidate.confidence > best.candidate.confidence)
        || (comparison.score === best.comparison.score
          && candidate.confidence === best.candidate.confidence
          && candidate.index < best.candidate.index)
      ) best = item;
    }
    return best || {
      candidate: null,
      comparison: compareCardNames('', cardName)
    };
  }

  function rankCardCandidates(nameCandidatesInput, cardsInput) {
    const candidates = prepareNameCandidates(nameCandidatesInput);
    const cards = Array.isArray(cardsInput) ? cardsInput : [];
    return cards.map((card, index) => {
      const cardName = safeText(readOwn(card, ['name']), 300, '');
      const best = bestNameComparison(candidates, cardName);
      return {
        card,
        cardIndex: index,
        cardName,
        candidate: best.candidate ? best.candidate.text : '',
        candidateIndex: best.candidate ? best.candidate.index : -1,
        score: best.comparison.score,
        comparison: best.comparison
      };
    }).sort((left, right) => (
      right.score - left.score
      || Number(right.comparison.exact) - Number(left.comparison.exact)
      || right.comparison.tokenSimilarity - left.comparison.tokenSimilarity
      || left.cardName.localeCompare(right.cardName, 'en')
      || left.cardIndex - right.cardIndex
    ));
  }

  function confidenceLabel(score) {
    if (score >= 0.82) return 'high';
    if (score >= 0.65) return 'medium';
    return 'low';
  }

  function bestSetComparison(setCandidates, apiSetCode) {
    let best = null;
    setCandidates.forEach((candidate, candidateIndex) => {
      const comparison = compareSetCodeCandidate(candidate, apiSetCode);
      if (!comparison.matched) return;
      const item = { candidate, candidateIndex, comparison };
      if (
        !best
        || comparison.score > best.comparison.score
        || (comparison.score === best.comparison.score && Number(comparison.exact) > Number(best.comparison.exact))
        || (comparison.score === best.comparison.score
          && comparison.exact === best.comparison.exact
          && candidateIndex < best.candidateIndex)
      ) best = item;
    });
    return best;
  }

  function selectBestCardPrinting(nameCandidatesInput, setOcrText, cardsInput) {
    const cards = Array.isArray(cardsInput) ? cardsInput : [];
    if (!cards.length) return null;
    const preparedNames = prepareNameCandidates(nameCandidatesInput);
    const rankedNames = rankCardCandidates(preparedNames, cards);
    const nameByCardIndex = new Map(rankedNames.map(item => [item.cardIndex, item]));
    const setCandidates = extractSetCodeCandidates(setOcrText);
    const matches = [];

    cards.forEach((card, cardIndex) => {
      const nameRank = nameByCardIndex.get(cardIndex);
      const printings = Array.isArray(readOwn(card, ['card_sets'])) ? card.card_sets : [];
      printings.forEach((printing, printingIndex) => {
        const setCode = safeText(readOwn(printing, ['set_code', 'setCode']), 80, '');
        const setMatch = bestSetComparison(setCandidates, setCode);
        if (!setMatch) return;
        const nameScore = nameRank ? nameRank.score : 0;
        const combinedScore = Number((setMatch.comparison.score * 0.85 + nameScore * 0.15).toFixed(6));
        matches.push({
          card,
          printing,
          cardIndex,
          printingIndex,
          nameRank,
          setMatch,
          combinedScore,
          normalizedSetCode: normalizeSetCode(setCode)
        });
      });
    });

    matches.sort((left, right) => (
      right.combinedScore - left.combinedScore
      || right.setMatch.comparison.score - left.setMatch.comparison.score
      || Number(right.setMatch.comparison.exact) - Number(left.setMatch.comparison.exact)
      || (right.nameRank ? right.nameRank.score : 0) - (left.nameRank ? left.nameRank.score : 0)
      || left.normalizedSetCode.localeCompare(right.normalizedSetCode, 'en')
      || safeText(readOwn(left.card, ['name']), 300, '').localeCompare(
        safeText(readOwn(right.card, ['name']), 300, ''),
        'en'
      )
      || left.cardIndex - right.cardIndex
      || left.printingIndex - right.printingIndex
    ));

    if (matches.length) {
      const best = matches[0];
      const nameScore = best.nameRank ? best.nameRank.score : 0;
      let confidenceScore = best.combinedScore;
      if (!preparedNames.length && best.setMatch.comparison.exact) confidenceScore = 0.92;
      if (nameScore && nameScore < 0.5) confidenceScore = Math.min(confidenceScore, 0.79);
      const setKind = best.setMatch.comparison.exact ? 'exact' : 'OCR-corrected';
      const nameKind = best.nameRank && best.nameRank.comparison.exact
        ? 'exact card name'
        : best.nameRank && best.nameRank.score >= 0.72
          ? 'fuzzy card name'
          : preparedNames.length
            ? 'weak card name'
            : 'no card name';
      return {
        card: best.card,
        printing: best.printing,
        score: best.combinedScore,
        confidenceScore: Number(confidenceScore.toFixed(6)),
        confidence: confidenceLabel(confidenceScore),
        reason: `${setKind} set-code match with ${nameKind}`,
        reasonCode: `set-${best.setMatch.comparison.exact ? 'exact' : 'corrected'}+name-${nameKind.split(' ')[0]}`,
        setCodeMatched: true,
        setCodeCandidate: best.setMatch.candidate,
        setCodeComparison: best.setMatch.comparison,
        nameCandidate: best.nameRank ? best.nameRank.candidate : '',
        nameComparison: best.nameRank ? best.nameRank.comparison : compareCardNames('', '')
      };
    }

    const bestName = rankedNames[0];
    if (!bestName || !preparedNames.length) return null;
    const confidenceScore = Number((bestName.score * (setCandidates.length ? 0.68 : 0.8)).toFixed(6));
    return {
      card: bestName.card,
      printing: null,
      score: bestName.score,
      confidenceScore,
      confidence: confidenceLabel(confidenceScore),
      reason: setCandidates.length
        ? 'card name match, but no strict set-code match'
        : 'card name match; a set code is still needed to identify the printing',
      reasonCode: setCandidates.length ? 'name-only+set-unmatched' : 'name-only',
      setCodeMatched: false,
      setCodeCandidate: setCandidates[0] || '',
      setCodeComparison: null,
      nameCandidate: bestName.candidate,
      nameComparison: bestName.comparison
    };
  }

  function normalizeStoredEntry(entry) {
    if (!isRecord(entry)) return null;
    const rawName = readOwn(entry, ['name', 'cardName', 'card_name']);
    const rawSetCode = readOwn(entry, ['setCode', 'set_code', 'code']);
    const name = safeText(rawName, 300, '');
    const storedCodeCandidates = extractSetCodeCandidates(rawSetCode);
    const setCode = storedCodeCandidates[0] || normalizeSetCode(rawSetCode);
    if (!name && !setCode) return null;
    const confidence = safeText(readOwn(entry, ['confidence']), 20, 'low').toLowerCase();
    return {
      name: name || 'Unknown',
      setCode,
      value: safeValue(readOwn(entry, ['value', 'price', 'setPrice'])),
      setName: safeText(readOwn(entry, ['setName', 'set_name']), 300, ''),
      rarity: safeText(readOwn(entry, ['rarity', 'set_rarity']), 120, ''),
      edition: safeText(readOwn(entry, ['edition']), 80, 'Other') || 'Other',
      quantity: safeQuantity(readOwn(entry, ['quantity', 'count', 'qty'])),
      scannedAt: safeText(readOwn(entry, ['scannedAt', 'scanned_at']), 40, ''),
      scannedDate: safeText(readOwn(entry, ['scannedDate', 'scanned_date']), 40, ''),
      rawText: safeText(readOwn(entry, ['rawText', 'raw_text']), 2000, ''),
      image: safeImageUrl(readOwn(entry, ['image', 'imageUrl', 'image_url'])),
      confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'low'
    };
  }

  function decodeStatePayload(payload) {
    if (typeof payload !== 'string') return payload;
    if (!payload.trim()) return [];
    try {
      return JSON.parse(payload);
    } catch (error) {
      return [];
    }
  }

  function migrateEntriesPayload(payload) {
    const decoded = decodeStatePayload(payload);
    let source = [];
    if (Array.isArray(decoded)) source = decoded;
    else if (isRecord(decoded) && Array.isArray(readOwn(decoded, ['entries']))) source = decoded.entries;

    const entries = [];
    for (const entry of source.slice(0, MAX_STORED_ENTRIES)) {
      const normalized = normalizeStoredEntry(entry);
      if (normalized) entries.push(normalized);
    }
    return { version: STATE_VERSION, entries };
  }

  function loadEntriesPayload(payload) {
    return migrateEntriesPayload(payload).entries;
  }

  function parseStoredState(payload) {
    return migrateEntriesPayload(payload);
  }

  function serializeState(payload) {
    return JSON.stringify(migrateEntriesPayload(payload));
  }

  function setCodeSimilarity(ocrCandidate, apiSetCode) {
    return compareSetCodeCandidate(ocrCandidate, apiSetCode).score;
  }

  function expandEntriesForExport(entriesInput) {
    const entries = migrateEntriesPayload(entriesInput).entries;
    const rows = [];
    for (const entry of entries) {
      for (let index = 0; index < entry.quantity; index += 1) {
        rows.push({ name: entry.name, setCode: entry.setCode, value: entry.value });
      }
    }
    return rows;
  }

  return Object.freeze({
    STATE_VERSION,
    parseStoredState,
    serializeState,
    migrateEntriesPayload,
    loadEntriesPayload,
    normalizeCardName,
    cleanCardNameForApi,
    extractNameCandidates,
    levenshteinDistance,
    tokenNameSimilarity,
    compareCardNames,
    rankCardCandidates,
    normalizeSetCode,
    extractSetCodeCandidates,
    setCodeSimilarity,
    compareSetCodeCandidate,
    selectBestCardPrinting,
    expandEntriesForExport
  });
}));
