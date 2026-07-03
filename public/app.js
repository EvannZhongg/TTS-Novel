const SAMPLE_TEXT = `第一卷 青春试音
§§§第1章：转学生
苏晚卿转学前和父母特意保证：
“爸妈，你们放心好了，我就是换个地方好好学习。”

两个月后，顾迟将女生逼到拐角，嗤笑了一声，带着宠溺的嗓音：
“嗯，好好学习，和我一起的那种嘛？”

高二一班理科实验班。
“听说了么，顾迟还有谢子逸他们都在我们班诶。”
“早就知道了，都不知道和年级校霸一起上课是怎么样的。”

§§§第2章：叫她“滚”
苏晚卿低头翻开课本。

谢子逸站在走廊尽头，声音压得很低：
“顾迟，别吓她。”

顾迟没回头，只轻轻敲了敲桌面。
“新同学，坐这里。”

第3章：晚自习
晚自习铃声响起，窗外的风吹动书页。
苏晚卿把笔记本合上，听见有人在身后说：
“明天见。”`;

const STORAGE_KEY = 'tts_pipeline_demo_last_result_v1';
const ANALYSIS_EXPORT_SCHEMA_VERSION = 'tts_pipeline_analysis_v1';
const AUTO_DOWNLOAD_JSON = false;
const JOB_LOG_FETCH_LIMIT = 5000;
const JOB_LOG_RENDER_LIMIT = 300;
const HIDE_CLEANED_EMPTY_LINES = true;
const FRONTEND_NOISE_PATTERNS = [
  /<img\b[^>]*>/gis,
  /img\s+data-ywcc-[^>]*>?/gis,
  /data-ywcc-(?:imgId|path)\s*=\s*"[^"]*"/gi,
  /https?:\/\/[^\s<>"'\]]+/gi,
  /\/\S*\.(?:jpg|jpeg|png|gif|webp|svg|bmp)(?:["'\s>]|$)/gi,
  /<[^>]+>/gis,
];
const FRONTEND_OPENING_PUNCT = new Set('（([{《【“‘"\''.split(''));
const FRONTEND_CONTINUATION_PREFIX = new Set('，,、。！？!?；;：:…」』”’）)]}》】'.split(''));
const FRONTEND_SOFT_ENDING = new Set('，,、；;：:'.split(''));
const FRONTEND_HARD_ENDING = new Set('。！？!?…」』”’）)]}》】'.split(''));
const FRONTEND_ASCII_WORD_RE = /[A-Za-z0-9]$/;

const state = {
  fileName: '',
  rawText: '',
  text: '',
  normalizedText: '',
  lines: [],
  lineOffsets: [],
  result: null,
  selectedChapterId: null,
  selectedChunkId: 'all',
  selectedSpanKey: null,
  spanLocations: [],
  candidateFilter: 'all',
  jobId: null,
  jobLogs: [],
  jobMeta: null,
  jobError: null,
  progressiveResult: null,
  completedChapterIds: new Set(),
};

const els = {
  healthBtn: document.querySelector('#healthBtn'),
  openUploadBtn: document.querySelector('#openUploadBtn'),
  importJsonBtn: document.querySelector('#importJsonBtn'),
  importJsonInput: document.querySelector('#importJsonInput'),
  uploadModal: document.querySelector('#uploadModal'),
  closeUploadBtn: document.querySelector('#closeUploadBtn'),
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#fileInput'),
  fileNamePreview: document.querySelector('#fileNamePreview'),
  pasteTextarea: document.querySelector('#pasteTextarea'),
  loadSampleBtn: document.querySelector('#loadSampleBtn'),
  clearTextBtn: document.querySelector('#clearTextBtn'),
  applyTextBtn: document.querySelector('#applyTextBtn'),
  bookTitleInput: document.querySelector('#bookTitleInput'),
  runPipelineBtn: document.querySelector('#runPipelineBtn'),
  inputStats: document.querySelector('#inputStats'),
  resultStats: document.querySelector('#resultStats'),
  pipelineSteps: document.querySelector('#pipelineSteps'),
  statusBar: document.querySelector('#statusBar'),
  sourceVisualization: document.querySelector('#sourceVisualization'),
  resultVisualization: document.querySelector('#resultVisualization'),
  candidateTable: document.querySelector('#candidateTable'),
  runtimeLogs: document.querySelector('#runtimeLogs'),
  currentJobBadge: document.querySelector('#currentJobBadge'),
  jobIdDisplay: document.querySelector('#jobIdDisplay'),
  logCountBadge: document.querySelector('#logCountBadge'),
  candidateFilterButtons: [...document.querySelectorAll('.filter-chip')],
  countAll: document.querySelector('#countAll'),
  countAccepted: document.querySelector('#countAccepted'),
  countRejected: document.querySelector('#countRejected'),
  exportJsonBtn: document.querySelector('#exportJsonBtn'),
};

function init() {
  bindEvents();
  updateInputStats();
  updateResultStats();
  renderSource();
  renderResult();
  renderCandidateTable();
  renderRuntimeLogs();
  updateJobIdDisplay();
  restoreLastResult();
}

function bindEvents() {
  els.openUploadBtn.addEventListener('click', openUploadModal);
  els.importJsonBtn.addEventListener('click', () => els.importJsonInput.click());
  els.importJsonInput.addEventListener('change', importResultJson);
  els.closeUploadBtn.addEventListener('click', closeUploadModal);
  els.uploadModal.addEventListener('click', (event) => {
    if (event.target === els.uploadModal) closeUploadModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeUploadModal();
  });

  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files?.[0];
    if (file) await readFileIntoTextarea(file);
  });

  ['dragenter', 'dragover'].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove('dragover');
    });
  });
  els.dropZone.addEventListener('drop', async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await readFileIntoTextarea(file);
  });

  els.loadSampleBtn.addEventListener('click', () => {
    els.pasteTextarea.value = SAMPLE_TEXT;
    els.fileNamePreview.textContent = '内置示例 · UTF-8';
  });
  els.clearTextBtn.addEventListener('click', () => {
    els.pasteTextarea.value = '';
    els.fileInput.value = '';
    els.fileNamePreview.textContent = '未选择文件';
  });
  els.applyTextBtn.addEventListener('click', applyTextFromModal);
  els.healthBtn.addEventListener('click', checkHealth);
  els.runPipelineBtn.addEventListener('click', runFullPipeline);
  els.exportJsonBtn.addEventListener('click', exportResultJson);
  els.candidateFilterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.candidateFilter = button.dataset.filter || 'all';
      renderCandidateTable();
    });
  });
}

function openUploadModal() {
  els.uploadModal.classList.add('open');
  els.uploadModal.setAttribute('aria-hidden', 'false');
  if (!els.pasteTextarea.value && (state.rawText || state.text)) {
    els.pasteTextarea.value = state.rawText || state.text;
  }
  setTimeout(() => els.pasteTextarea.focus(), 20);
}

function closeUploadModal() {
  if (els.uploadModal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  els.openUploadBtn.focus({ preventScroll: true });
  els.uploadModal.classList.remove('open');
  els.uploadModal.setAttribute('aria-hidden', 'true');
}

async function readFileIntoTextarea(file) {
  try {
    const buffer = await file.arrayBuffer();
    const decoded = decodeTextFile(buffer);
    els.pasteTextarea.value = decoded.text;
    els.fileNamePreview.textContent = `${file.name} · ${formatBytes(file.size)} · 自动识别 ${decoded.displayName}${decoded.warning ? ` · ${decoded.warning}` : ''}`;
    state.fileName = file.name;
    if (!els.bookTitleInput.value || els.bookTitleInput.value === 'demo') {
      els.bookTitleInput.value = file.name.replace(/\.txt$/i, '') || 'demo';
    }
    setStatus(
      `已读取 ${file.name}：自动识别为 ${decoded.displayName}${decoded.warning ? `（${decoded.warning}）` : ''}。请在文本框中确认无乱码后点击「载入文本」。`,
      decoded.warning ? 'warn' : 'ok',
    );
  } catch (error) {
    setStatus(`读取文件失败：${error.message}`, 'error');
  }
}

function decodeTextFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) return { text: '', encoding: 'utf-8', displayName: 'UTF-8', score: 0 };

  const bom = detectBom(bytes);
  if (bom) {
    return {
      text: decodeWithEncoding(buffer, bom.encoding),
      encoding: bom.encoding,
      displayName: bom.displayName,
      score: 1,
    };
  }

  const candidates = [
    { encoding: 'utf-8', displayName: 'UTF-8' },
    { encoding: 'gb18030', displayName: 'GB18030 / GBK' },
    { encoding: 'utf-16le', displayName: 'UTF-16 LE' },
    { encoding: 'utf-16be', displayName: 'UTF-16 BE' },
  ]
    .map((candidate) => decodeCandidate(buffer, candidate))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    throw new Error('浏览器无法解码该文本文件，请尝试用系统文本编辑器另存为 UTF-8 后再上传。');
  }

  const best = candidates[0];
  const second = candidates[1];
  const ambiguous = second && best.score - second.score < 0.08;
  const suspicious = best.score < 0.55 || best.metrics.replacementCount > 0 || best.metrics.controlRatio > 0.01;
  return {
    text: best.text,
    encoding: best.encoding,
    displayName: best.displayName,
    score: best.score,
    metrics: best.metrics,
    warning: suspicious ? '疑似乱码，请检查预览' : ambiguous ? '编码判断接近，请检查预览' : '',
  };
}

function detectBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', displayName: 'UTF-8 BOM' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', displayName: 'UTF-16 LE BOM' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', displayName: 'UTF-16 BE BOM' };
  }
  return null;
}

function decodeCandidate(buffer, candidate) {
  try {
    const text = decodeWithEncoding(buffer, candidate.encoding, { fatal: true });
    const metrics = scoreDecodedText(text, candidate.encoding);
    return { ...candidate, text, metrics, score: metrics.score };
  } catch (_) {
    return null;
  }
}

function decodeWithEncoding(buffer, encoding, { fatal = false } = {}) {
  return new TextDecoder(encoding, { fatal }).decode(buffer);
}

function scoreDecodedText(text, encoding) {
  const length = Math.max(1, text.length);
  let replacementCount = 0;
  let controlCount = 0;
  let cjkCount = 0;
  let asciiPrintableCount = 0;
  let whitespaceCount = 0;
  let mojibakeCount = 0;
  let zeroCount = 0;

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '\uFFFD') replacementCount += 1;
    if (char === '\u0000') zeroCount += 1;
    if ((code < 32 || (code >= 127 && code <= 159)) && !'\n\r\t'.includes(char)) controlCount += 1;
    if (/^[\u3400-\u9fff\uf900-\ufaff]$/.test(char)) cjkCount += 1;
    if (code >= 32 && code <= 126) asciiPrintableCount += 1;
    if (/\s/.test(char)) whitespaceCount += 1;
    if ('ÃÂ¤åæç'.includes(char)) mojibakeCount += 1;
  }

  const replacementRatio = replacementCount / length;
  const controlRatio = controlCount / length;
  const zeroRatio = zeroCount / length;
  const cjkRatio = cjkCount / length;
  const printableRatio = (cjkCount + asciiPrintableCount + whitespaceCount) / length;
  const mojibakeRatio = mojibakeCount / length;

  let score = 0.25;
  score += Math.min(0.35, printableRatio * 0.35);
  score += Math.min(0.3, cjkRatio * 0.9);
  score -= Math.min(0.6, replacementRatio * 8);
  score -= Math.min(0.5, controlRatio * 12);
  score -= Math.min(0.5, zeroRatio * 10);
  score -= Math.min(0.25, mojibakeRatio * 4);

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    // UTF-16 without BOM is common, but false positives tend to contain many
    // controls/zeroes after decoding. Reward it only when it looks textual.
    if (controlRatio < 0.003 && zeroRatio < 0.003 && printableRatio > 0.75) score += 0.08;
    else score -= 0.18;
  }

  if (encoding === 'utf-8' && replacementCount === 0 && controlRatio < 0.003) score += 0.05;
  if (encoding === 'gb18030' && cjkRatio > 0.08 && replacementCount === 0) score += 0.04;

  score = Math.max(0, Math.min(1, score));
  return {
    score,
    replacementCount,
    controlRatio,
    zeroRatio,
    cjkRatio,
    printableRatio,
    mojibakeRatio,
  };
}

function applyTextFromModal() {
  const text = els.pasteTextarea.value || '';
  if (!text.trim()) {
    setStatus('文本为空，请选择 TXT 文件或粘贴内容。', 'warn');
    return;
  }
  state.rawText = text;
  state.text = text;
  state.normalizedText = normalizeNewlines(text);
  state.lines = splitLinesKeepingEmpty(text);
  state.lineOffsets = computeLineOffsets(text);
  state.result = null;
  state.selectedChapterId = null;
  state.selectedChunkId = 'all';
  state.selectedSpanKey = null;
  state.spanLocations = [];
  state.candidateFilter = 'all';
  state.jobId = null;
  state.jobLogs = [];
  state.jobMeta = null;
  state.jobError = null;
  state.progressiveResult = null;
  state.completedChapterIds = new Set();
  updateInputStats();
  updateResultStats();
  renderSource();
  renderResult();
  renderCandidateTable();
  renderRuntimeLogs();
  updateJobIdDisplay();
  setPipelineStep(1);
  setStatus(`已载入文本：${state.fileName || '粘贴文本'}，可运行完整 Pipeline。`, 'ok');
  closeUploadModal();
}

async function importResultJson() {
  const file = els.importJsonInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const analysisPackage = validateAnalysisPackage(JSON.parse(text));
    const normalizedText = normalizeNewlines(analysisPackage.input.normalized_text);
    state.fileName = analysisPackage.input.file_name || file.name;
    state.rawText = normalizedText;
    state.text = normalizedText;
    state.normalizedText = normalizedText;
    state.lines = splitLinesKeepingEmpty(normalizedText);
    state.lineOffsets = computeLineOffsets(normalizedText);
    state.jobId = analysisPackage.job?.job_id || null;
    state.jobLogs = analysisPackage.logs;
    state.jobMeta = analysisPackage.job || null;
    state.jobError = analysisPackage.error || null;
    if (analysisPackage.input.book_title) els.bookTitleInput.value = analysisPackage.input.book_title;
    loadPipelineResult(analysisPackage.result, { fileName: state.fileName, persist: true });
    renderRuntimeLogs();
    setStatus(`已导入 pipeline 分析 JSON：${file.name}`, 'ok');
  } catch (error) {
    setStatus(`导入 JSON 失败：${error.message}`, 'error');
  } finally {
    els.importJsonInput.value = '';
  }
}

function validateAnalysisPackage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('不是有效的 pipeline 分析 JSON：根节点必须是对象');
  }
  if (value.schema_version !== ANALYSIS_EXPORT_SCHEMA_VERSION) {
    throw new Error(`不支持的 schema_version：${value.schema_version || 'missing'}`);
  }
  if (!value.input || typeof value.input.normalized_text !== 'string') {
    throw new Error('不是有效的 pipeline 分析 JSON：缺少 input.normalized_text');
  }
  if (!value.result || !Array.isArray(value.result.chapters)) {
    throw new Error('不是有效的 pipeline 分析 JSON：缺少 result.chapters');
  }
  return {
    ...value,
    logs: Array.isArray(value.logs) ? value.logs : [],
    error: value.error ?? null,
  };
}

function loadPipelineResult(result, { fileName = '导入 JSON', persist = false } = {}) {
  if (!result || !Array.isArray(result.chapters)) {
    throw new Error('不是有效的 pipeline result：缺少 chapters');
  }
  const rebuilt = rebuildTextFromPipelineResult(result);
  const normalizedResult = rebuilt.result;
  if (!state.rawText) state.rawText = state.text || rebuilt.text;
  state.text = rebuilt.text;
  state.normalizedText = normalizeNewlines(rebuilt.text);
  state.lines = splitLinesKeepingEmpty(rebuilt.text);
  state.lineOffsets = computeLineOffsets(rebuilt.text);
  state.fileName = state.fileName || fileName;
  state.result = normalizedResult;
  state.progressiveResult = null;
  state.completedChapterIds = new Set((normalizedResult.chapters || []).map((chapter) => chapter.chapter_id));
  state.spanLocations = buildAllSpanLocations();
  state.selectedChapterId = normalizedResult.chapters?.[0]?.chapter_id ?? null;
  state.selectedChunkId = 'all';
  state.selectedSpanKey = null;
  state.candidateFilter = 'all';
  updateInputStats();
  updateResultStats();
  renderSource();
  renderResult();
  renderCandidateTable();
  if (persist) saveLastResult();
}

function rebuildTextFromPipelineResult(result) {
  const cloned = JSON.parse(JSON.stringify(result));
  const source = state.rawText || state.normalizedText || state.text || '';
  if (source.trim() && isAlreadyDisplayMappedResult(cloned)) {
    return { text: normalizeNewlines(source), result: cloned };
  }
  if (source.trim()) {
    return rebuildTextFromPipelineResultOnSource(cloned, source);
  }
  return rebuildTextFromPipelineResultSynthetic(cloned);
}

function isAlreadyDisplayMappedResult(result) {
  if (result?.frontend_coordinate_basis === 'source_text_v2' || result?.frontend_coordinate_basis === 'synthetic_text_v2') return true;
  return (result?.chapters || []).some((chapter) =>
    chapter?.display_body_start !== undefined
    && (chapter?.display_body_end !== undefined || chapter?.display_title_line !== undefined)
    && (chapter?.chunks || []).some((chunk) => chunk?.display_start !== undefined || chunk?.clean_start !== undefined),
  );
}

function rebuildTextFromPipelineResultOnSource(cloned, sourceText) {
  const normalizedSource = normalizeNewlines(sourceText);
  const preprocessedSource = preprocessForDisplaySource(normalizedSource, cloned.preprocessing || {});
  const originalLineOffsets = computeLineOffsets(preprocessedSource);
  const context = buildChapterDisplayMappingContext(cloned, preprocessedSource, originalLineOffsets);
  cloned.chapters = (cloned.chapters || []).map((chapter) => mapChapterToDisplaySource(chapter, context));
  cloned.frontend_coordinate_basis = 'source_text_v2';
  return { text: preprocessedSource, result: cloned };
}

function preprocessForDisplaySource(text, preprocessing = {}) {
  // Keep the same coordinate basis as backend pre-chapter preprocessing.
  // The browser already normalizes CR/LF, BOM and NUL on upload; applying the
  // same cheap normalization here keeps chapter.start/end aligned with raw job
  // metadata before progressive chunks arrive.
  return normalizeNewlines(text);
}

function buildChapterDisplayMappingContext(result, displayText, lineOffsets) {
  const ordered = [...(result?.chapters || [])].sort((a, b) => Number(a.chapter_id || 0) - Number(b.chapter_id || 0));
  const titleHints = buildChapterTitleLineHints(result, displayText, lineOffsets);
  const usedTitleHintIds = new Set();
  const titleLocations = new Map();
  const titleOccupied = [];
  ordered.forEach((chapter) => {
    const title = String(chapter.title || '').trim();
    const originalStart = Number(chapter.start || 0);
    const hintedLocation = findBestChapterTitleHint({ chapter, titleHints, usedTitleHintIds, displayText });
    const location = hintedLocation || findChapterTitleInDisplaySource(displayText, title, originalStart, titleOccupied);
    if (location) {
      titleLocations.set(chapter.chapter_id, location);
      if (location.hint_id) usedTitleHintIds.add(location.hint_id);
      titleOccupied.push(location);
    }
  });

  const bodyBounds = new Map();
  ordered.forEach((chapter, index) => {
    const titleLocation = titleLocations.get(chapter.chapter_id) || null;
    const originalStart = clampOffset(chapter.start, displayText.length);
    const originalEnd = clampOffset(chapter.end ?? originalStart, displayText.length);
    const nextChapter = ordered[index + 1];
    const nextTitleLocation = nextChapter ? titleLocations.get(nextChapter.chapter_id) : null;
    const bodyStart = titleLocation ? skipLineBreaks(displayText, titleLocation.end) : originalStart;
    const fallbackEnd = originalEnd > bodyStart ? originalEnd : bodyStart + getChapterTextForMapping(chapter).length;
    const bodyEnd = findChapterBodyEndInDisplaySource({
      text: displayText,
      bodyStart,
      fallbackEnd,
      chapter,
      nextTitleStart: nextTitleLocation?.start ?? null,
    });
    bodyBounds.set(chapter.chapter_id, {
      bodyStart,
      bodyEnd,
      cleanMap: buildCleanChapterDisplayMap(displayText.slice(bodyStart, bodyEnd), bodyStart),
    });
  });

  return { displayText, lineOffsets, titleLocations, bodyBounds };
}

function buildChapterTitleLineHints(result, displayText, lineOffsets) {
  const decisions = result?.chapter_title_detection?.decisions || [];
  return decisions
    .filter((decision) => decision?.is_chapter_title && Number.isFinite(Number(decision.line_number)))
    .map((decision, index) => {
      const lineNumber = Number(decision.line_number);
      const offset = lineOffsets[lineNumber - 1];
      if (!offset) return null;
      const rawLine = displayText.slice(offset.start, offset.end);
      return {
        id: decision.candidate_id || `accepted_title_${index}`,
        line_number: lineNumber,
        start: offset.start,
        end: offset.end,
        body_start: skipLineBreaks(displayText, offset.end),
        title: String(decision.normalized_title || decision.title || '').trim(),
        raw_line: String(decision.raw_line || rawLine || '').trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function findBestChapterTitleHint({ chapter, titleHints, usedTitleHintIds, displayText }) {
  if (!titleHints.length) return null;
  const chapterTitle = normalizeTitleForMatching(chapter.title);
  const originalStart = Number(chapter.start || 0);
  const candidates = titleHints
    .filter((hint) => !usedTitleHintIds.has(hint.id))
    .map((hint) => {
      const titleMatches = chapterTitle && titleHintMatchesChapter(hint, chapterTitle);
      const distance = Math.abs(Number(hint.body_start || hint.end) - originalStart);
      return {
        hint,
        score: [
          titleMatches ? 0 : 1,
          distance,
          hint.start,
        ],
      };
    })
    .sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2]);
  const best = candidates[0];
  if (!best) return null;
  // Prefer LLM/title-validation line hints for marker-prefixed titles such as
  // "§§§第1章"; fall back to substring search only when the hint is clearly far
  // away and the title text does not match.
  if (best.score[0] === 0 || best.score[1] <= 500) {
    return { start: best.hint.start, end: best.hint.end, hint_id: best.hint.id };
  }
  return null;
}

function titleHintMatchesChapter(hint, normalizedChapterTitle) {
  const values = [hint.title, hint.raw_line].map(normalizeTitleForMatching).filter(Boolean);
  return values.some((value) => value === normalizedChapterTitle || value.includes(normalizedChapterTitle) || normalizedChapterTitle.includes(value));
}

function normalizeTitleForMatching(value) {
  return String(value || '')
    .trim()
    .replace(/^§+/, '')
    .replace(/\s+/g, '')
    .trim();
}

function mapChapterToDisplaySource(chapter, context) {
  const { displayText, titleLocations, bodyBounds, lineOffsets } = context;
  const mapped = { ...chapter };
  const title = String(mapped.title || '').trim();
  const body = bodyBounds.get(mapped.chapter_id) || {};
  const titleLocation = titleLocations.get(mapped.chapter_id) || null;
  const bodyStart = clampOffset(body.bodyStart ?? mapped.start ?? 0, displayText.length);
  const bodyEnd = clampOffset(Math.max(body.bodyEnd ?? mapped.end ?? bodyStart, bodyStart), displayText.length);
  const cleanMap = body.cleanMap || buildIdentityCleanMap(bodyStart, bodyEnd);

  mapped.display_title_start = titleLocation?.start ?? Math.max(0, bodyStart - title.length - 1);
  mapped.display_title_end = titleLocation?.end ?? mapped.display_title_start + title.length;
  mapped.display_title_line = offsetToLineNumber(mapped.display_title_start, lineOffsets, displayText.length);
  mapped.display_body_start = bodyStart;
  mapped.display_body_end = bodyEnd;
  mapped.source_start = mapped.start;
  mapped.source_end = mapped.end;
  mapped.start = bodyStart;
  mapped.end = bodyEnd;
  mapped.chunks = (mapped.chunks || []).map((chunk) => mapChunkToDisplaySource(chunk, bodyStart, bodyEnd, displayText, cleanMap));
  remapChapterTtsSegments(mapped, bodyStart, bodyEnd, displayText, cleanMap);
  return mapped;
}

function findChapterTitleInDisplaySource(text, title, originalStart, occupied = []) {
  if (!title) return null;
  const searchStart = Math.max(0, originalStart - title.length - 8);
  const searchEnd = Math.min(text.length, originalStart + title.length + 120);
  let index = text.indexOf(title, searchStart);
  while (index >= 0 && index <= searchEnd) {
    if (isLineBoundaryBefore(text, index) && isLineBoundaryAfter(text, index + title.length) && !overlapsAnyRange(index, index + title.length, occupied)) {
      return { start: index, end: index + title.length };
    }
    index = text.indexOf(title, index + 1);
  }
  index = text.indexOf(title);
  while (index >= 0) {
    if (isLineBoundaryBefore(text, index) && isLineBoundaryAfter(text, index + title.length) && !overlapsAnyRange(index, index + title.length, occupied)) {
      return { start: index, end: index + title.length };
    }
    index = text.indexOf(title, index + 1);
  }
  return null;
}

function overlapsAnyRange(start, end, ranges) {
  return (ranges || []).some((range) => rangesOverlap(start, end, range.start, range.end));
}

function isLineBoundaryBefore(text, index) {
  return index <= 0 || text[index - 1] === '\n' || text.slice(Math.max(0, index - 4), index).trim() === '';
}

function isLineBoundaryAfter(text, index) {
  return index >= text.length || text[index] === '\n' || text.slice(index, Math.min(text.length, index + 4)).trim() === '';
}

function skipLineBreaks(text, offset) {
  let cursor = clampOffset(offset, text.length);
  while (cursor < text.length && /[\r\n]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function findChapterBodyEndInDisplaySource({ text, bodyStart, fallbackEnd, chapter, nextTitleStart }) {
  if (nextTitleStart !== null && nextTitleStart !== undefined) return trimTrailingLineBreaks(text, nextTitleStart);

  const chapterText = getChapterTextForMapping(chapter);
  if (chapterText) {
    const head = chapterText.slice(0, Math.min(80, chapterText.length)).trim();
    const tail = chapterText.slice(Math.max(0, chapterText.length - 80)).trim();
    const searchEnd = clampOffset(fallbackEnd + 160, text.length);
    const tailIndex = tail ? findTextInWindow(text, tail, Math.max(0, bodyStart - 5), searchEnd) : -1;
    if (tailIndex >= bodyStart) return tailIndex + tail.length;
    const headIndex = head ? findTextInWindow(text, head, Math.max(0, bodyStart - 5), searchEnd) : -1;
    if (headIndex >= 0 && chapterText.length > 0) return Math.min(text.length, headIndex + chapterText.length);
  }
  return clampOffset(fallbackEnd, text.length);
}

function getChapterTextForMapping(chapter) {
  return String(chapter?.cleaned_text || (chapter?.chunks || []).map((chunk) => chunk.text || '').join(''));
}

function findTextInWindow(text, query, start, end) {
  const from = clampOffset(start, text.length);
  const to = clampOffset(end, text.length);
  if (!query || from >= to) return -1;
  const index = text.indexOf(query, from);
  return index >= 0 && index + query.length <= to ? index : -1;
}

function trimTrailingLineBreaks(text, offset) {
  let cursor = clampOffset(offset, text.length);
  while (cursor > 0 && /[\r\n]/.test(text[cursor - 1])) cursor -= 1;
  return cursor;
}

function buildCleanChapterDisplayMap(bodyText, absoluteBodyStart) {
  const stripped = stripFrontendNoiseRegionsWithMap(bodyText, absoluteBodyStart);
  const paragraphs = [];
  let current = null;
  splitTextLinesWithMap(stripped.text, stripped.charMap).forEach((rawLine) => {
    const line = cleanChapterLineWithMap(rawLine.text, rawLine.charMap);
    if (!line.text) {
      if (current?.text) {
        paragraphs.push(current);
        current = null;
      }
      return;
    }
    if (!current) {
      current = line;
      return;
    }
    if (shouldJoinFrontendLines(current.text, line.text)) {
      current = joinFrontendLineRecords(current, line);
      return;
    }
    paragraphs.push(current);
    current = line;
  });
  if (current?.text) paragraphs.push(current);

  const textParts = [];
  const charMap = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      const previousMap = charMap.length ? charMap[charMap.length - 1] + 1 : absoluteBodyStart;
      const nextMap = paragraph.charMap[0] ?? previousMap;
      textParts.push('\n\n');
      charMap.push(previousMap, nextMap);
    }
    textParts.push(paragraph.text);
    charMap.push(...paragraph.charMap);
  });

  return {
    identity: false,
    bodyStart: absoluteBodyStart,
    bodyEnd: absoluteBodyStart + bodyText.length,
    cleanedText: textParts.join(''),
    charMap,
  };
}

function stripFrontendNoiseRegionsWithMap(text, absoluteStart) {
  const spans = findFrontendNoiseSpans(text);
  const charMap = [];
  if (!spans.length) {
    for (let index = 0; index < text.length; index += 1) charMap.push(absoluteStart + index);
    return { text, charMap };
  }
  const parts = [];
  let previousEnd = 0;
  spans.forEach(([start, end]) => {
    if (start > previousEnd) {
      parts.push(text.slice(previousEnd, start));
      for (let index = previousEnd; index < start; index += 1) charMap.push(absoluteStart + index);
    }
    previousEnd = Math.max(previousEnd, end);
  });
  if (previousEnd < text.length) {
    parts.push(text.slice(previousEnd));
    for (let index = previousEnd; index < text.length; index += 1) charMap.push(absoluteStart + index);
  }
  return { text: parts.join(''), charMap };
}

function findFrontendNoiseSpans(text) {
  const spans = [];
  FRONTEND_NOISE_PATTERNS.forEach((pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text || '');
    while (match) {
      spans.push([match.index, match.index + match[0].length]);
      match = pattern.exec(text || '');
    }
  });
  return mergeOffsetSpans(spans);
}

function mergeOffsetSpans(spans) {
  if (!spans.length) return [];
  const ordered = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ordered[0].slice()];
  ordered.slice(1).forEach(([start, end]) => {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged;
}

function splitTextLinesWithMap(text, charMap) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== '\n') continue;
    lines.push({ text: text.slice(start, index), charMap: charMap.slice(start, index) });
    start = index + 1;
  }
  return lines;
}

function cleanChapterLineWithMap(rawLine, rawMap) {
  const chars = [];
  const charMap = [];
  let index = 0;
  while (index < rawLine.length) {
    const char = rawLine[index];
    if (char === '\ufeff') {
      index += 1;
      continue;
    }
    if (/[ \t\u3000]/.test(char)) {
      const map = rawMap[index];
      while (index < rawLine.length && /[ \t\u3000]/.test(rawLine[index])) index += 1;
      chars.push(' ');
      charMap.push(map);
      continue;
    }
    chars.push(char);
    charMap.push(rawMap[index]);
    index += 1;
  }

  let first = 0;
  let last = chars.length;
  while (first < last && /\s/.test(chars[first])) first += 1;
  while (last > first && /\s/.test(chars[last - 1])) last -= 1;
  return { text: chars.slice(first, last).join(''), charMap: charMap.slice(first, last) };
}

function shouldJoinFrontendLines(previous, current) {
  if (!previous || !current) return false;
  if (FRONTEND_OPENING_PUNCT.has(previous.at(-1) || '')) return true;
  if (FRONTEND_CONTINUATION_PREFIX.has(current[0])) return true;
  if (FRONTEND_SOFT_ENDING.has(previous.at(-1) || '')) return true;
  return !FRONTEND_HARD_ENDING.has(previous.at(-1) || '');
}

function joinFrontendLineRecords(previous, current) {
  if (FRONTEND_ASCII_WORD_RE.test(previous.text) && /^[A-Za-z0-9]/.test(current.text)) {
    const bridgeMap = (previous.charMap.at(-1) ?? current.charMap[0] ?? 0) + 1;
    return {
      text: `${previous.text} ${current.text}`,
      charMap: [...previous.charMap, bridgeMap, ...current.charMap],
    };
  }
  return {
    text: `${previous.text}${current.text}`,
    charMap: [...previous.charMap, ...current.charMap],
  };
}

function buildIdentityCleanMap(bodyStart, bodyEnd) {
  return { identity: true, bodyStart, bodyEnd, cleanedText: '', charMap: [] };
}

function mapCleanedOffsetToDisplay(cleanMap, offset, edge = 'start') {
  const bodyStart = Number(cleanMap?.bodyStart ?? 0);
  const bodyEnd = Number(cleanMap?.bodyEnd ?? bodyStart);
  if (!cleanMap || cleanMap.identity) return clampOffset(bodyStart + Number(offset || 0), Math.max(bodyEnd, bodyStart));

  const charMap = cleanMap.charMap || [];
  if (!charMap.length) return edge === 'end' ? bodyEnd : bodyStart;
  const cleanLength = charMap.length;
  const target = clampOffset(offset, cleanLength);
  if (edge === 'end') {
    if (target <= 0) return charMap[0] ?? bodyStart;
    const previous = charMap[Math.min(cleanLength - 1, target - 1)];
    return clampOffset(Number(previous) + 1, Math.max(bodyEnd, bodyStart));
  }
  if (target >= cleanLength) {
    const previous = charMap[cleanLength - 1];
    return clampOffset(Number(previous) + 1, Math.max(bodyEnd, bodyStart));
  }
  return clampOffset(charMap[target], Math.max(bodyEnd, bodyStart));
}

function mapChunkToDisplaySource(chunk, bodyStart, bodyEnd, displayText, cleanMap) {
  const mapped = { ...chunk };
  const chunkText = String(mapped.text || '');
  const originalStart = Number(mapped.start || 0);
  const originalEnd = Number(mapped.end ?? mapped.start ?? 0);
  let displayStart = mapCleanedOffsetToDisplay(cleanMap, originalStart, 'start');
  let displayEnd = mapCleanedOffsetToDisplay(cleanMap, originalEnd, 'end');
  if (chunkText) {
    const localIndex = findChunkTextInDisplaySource(displayText, chunkText, displayStart, bodyStart, bodyEnd);
    if (localIndex >= 0) {
      displayStart = localIndex;
      displayEnd = localIndex + chunkText.length;
    }
  }
  displayStart = clampOffset(displayStart, displayText.length);
  displayEnd = clampOffset(Math.max(displayEnd, displayStart), displayText.length);
  mapped.display_start = displayStart;
  mapped.display_end = displayEnd;
  mapped.clean_start = mapped.start;
  mapped.clean_end = mapped.end;
  mapped.start = displayStart;
  mapped.end = displayEnd;
  remapChunkSpanOffsets(mapped, cleanMap, originalStart, bodyStart, bodyEnd, displayText);
  return mapped;
}

function findChunkTextInDisplaySource(displayText, chunkText, expectedStart, bodyStart, bodyEnd) {
  const directFrom = Math.max(bodyStart, expectedStart - 20);
  const directTo = Math.min(bodyEnd, expectedStart + chunkText.length + 120);
  const direct = findTextInWindow(displayText, chunkText, directFrom, directTo);
  if (direct >= 0) return direct;

  const anchors = [
    chunkText.slice(0, Math.min(120, chunkText.length)).trim(),
    chunkText.slice(Math.max(0, chunkText.length - 120)).trim(),
  ].filter((value) => value.length >= 8);
  for (const anchor of anchors) {
    const found = findUniqueQueryInRange(displayText, anchor, bodyStart, bodyEnd);
    if (found !== null) return anchor === anchors[0] ? found : Math.max(bodyStart, found - Math.max(0, chunkText.length - anchor.length));
  }
  return -1;
}

function remapChunkSpanOffsets(chunk, cleanMap, chunkCleanStart, bodyStart, bodyEnd, displayText) {
  const collections = [
    chunk.grounded_dialogue_spans,
    chunk.final_grounded_dialogue_spans,
    chunk.recovered_grounded_dialogue_spans,
    chunk.quote_recovery_superseded_spans,
  ].filter(Array.isArray);
  collections.forEach((items) => {
    items.forEach((span) => remapSpanOffset(span, cleanMap, 0, bodyStart, bodyEnd, displayText));
  });
  if (Array.isArray(chunk.quote_span_candidates)) {
    chunk.quote_span_candidates.forEach((candidate) => remapSpanOffset(candidate, cleanMap, chunkCleanStart, bodyStart, bodyEnd, displayText));
  }
  if (Array.isArray(chunk.missed_quote_span_candidates)) {
    chunk.missed_quote_span_candidates.forEach((candidate) => remapSpanOffset(candidate, cleanMap, chunkCleanStart, bodyStart, bodyEnd, displayText));
  }
}

function remapSpanOffset(span, cleanMap, offsetBase, bodyStart, bodyEnd, displayText) {
  if (!span || span.start === null || span.start === undefined || span.end === null || span.end === undefined) return;
  const originalStart = Number(span.start);
  const originalEnd = Number(span.end);
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return;
  const cleanStart = offsetBase + originalStart;
  const cleanEnd = offsetBase + originalEnd;
  let start = mapCleanedOffsetToDisplay(cleanMap, cleanStart, 'start');
  let end = mapCleanedOffsetToDisplay(cleanMap, cleanEnd, 'end');
  const query = String(span.text || span.dialogue_text || '').trim();
  if (query && (start < bodyStart || end > bodyEnd || displayText.slice(start, end) !== query)) {
    const found = findUniqueQueryInRange(displayText, query, bodyStart, bodyEnd);
    if (found !== null) {
      start = found;
      end = found + query.length;
    }
  }
  span.clean_start = cleanStart;
  span.clean_end = cleanEnd;
  span.display_start = clampOffset(start, displayText.length);
  span.display_end = clampOffset(Math.max(end, start), displayText.length);
  span.start = span.display_start;
  span.end = span.display_end;
}

function remapChapterTtsSegments(chapter, bodyStart, bodyEnd, displayText, cleanMap) {
  if (!Array.isArray(chapter.tts_segments)) return;
  chapter.tts_segments = chapter.tts_segments.map((segment) => {
    const mapped = { ...segment };
    const originalStart = Number(mapped.start || 0);
    const originalEnd = Number(mapped.end ?? mapped.start ?? 0);
    const segmentText = String(mapped.text || '');
    let displayStart = mapCleanedOffsetToDisplay(cleanMap, originalStart, 'start');
    let displayEnd = mapCleanedOffsetToDisplay(cleanMap, originalEnd, 'end');
    if (segmentText && (displayStart < bodyStart || displayEnd > bodyEnd || displayText.slice(displayStart, displayEnd) !== segmentText)) {
      const found = findUniqueQueryInRange(displayText, segmentText, bodyStart, bodyEnd);
      if (found !== null) {
        displayStart = found;
        displayEnd = found + segmentText.length;
      }
    }
    mapped.clean_start = mapped.start;
    mapped.clean_end = mapped.end;
    mapped.display_start = clampOffset(displayStart, displayText.length);
    mapped.display_end = clampOffset(Math.max(displayEnd, displayStart), displayText.length);
    mapped.start = mapped.display_start;
    mapped.end = mapped.display_end;
    return mapped;
  });
}

function findUniqueQueryInRange(text, query, start, end) {
  const from = clampOffset(start, text.length);
  const to = clampOffset(end, text.length);
  if (!query || from >= to) return null;
  let found = -1;
  let count = 0;
  let index = text.indexOf(query, from);
  while (index >= 0 && index + query.length <= to) {
    found = index;
    count += 1;
    if (count > 1) return null;
    index = text.indexOf(query, index + 1);
  }
  return count === 1 ? found : null;
}

function offsetToLineNumber(offset, lineOffsets = state.lineOffsets || [], textLength = state.normalizedText.length || state.text.length || 0) {
  const target = clampOffset(offset, textLength);
  const offsets = lineOffsets || [];
  for (let index = 0; index < offsets.length; index += 1) {
    const item = offsets[index];
    if (target < item.start) return Math.max(1, index);
    if (target >= item.start && target <= item.end) return index + 1;
  }
  return offsets.length || 1;
}

function clampOffset(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(length, number));
}

function rebuildTextFromPipelineResultSynthetic(cloned) {
  let text = '';
  let cursor = 0;
  let lineNumber = 1;
  (cloned.chapters || []).forEach((chapter) => {
    const title = chapter.title || `第${chapter.chapter_id}章`;
    chapter.display_title_line = lineNumber;
    chapter.display_title_start = cursor;
    text += `${title}\n`;
    cursor += title.length + 1;
    lineNumber += 1;

    const bodyStart = cursor;
    const body = chapter.cleaned_text || (chapter.chunks || []).map((chunk) => chunk.text || chunk.text_preview || '').join('');
    text += body;
    cursor += body.length;
    lineNumber += body ? body.split('\n').length : 0;

    const chapterEnd = cursor;
    chapter.start = bodyStart;
    chapter.end = chapterEnd;

    text += '\n\n';
    cursor += 2;
    lineNumber += 1;
  });
  (cloned.chapters || []).forEach((chapter) => {
    const cleanMap = buildIdentityCleanMap(chapter.start, chapter.end);
    chapter.chunks = (chapter.chunks || []).map((chunk) => mapChunkToDisplaySource(chunk, chapter.start, chapter.end, text, cleanMap));
    remapChapterTtsSegments(chapter, chapter.start, chapter.end, text, cleanMap);
  });
  cloned.frontend_coordinate_basis = 'synthetic_text_v2';
  return { text, result: cloned };
}

function saveLastResult() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      saved_at: new Date().toISOString(),
      fileName: state.fileName,
      rawText: state.rawText,
      text: state.text,
      result: state.result,
      jobId: state.jobId,
      jobMeta: state.jobMeta,
      jobError: state.jobError,
      jobLogs: state.jobLogs,
    }));
  } catch (_) {
    // localStorage may be unavailable or quota-limited; export JSON still works.
  }
}

function restoreLastResult() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved?.result || !saved?.text) return;
    state.fileName = saved.fileName || '本地缓存';
    state.jobId = saved.jobId || saved.job_id || saved.result?.job_id || null;
    state.jobMeta = saved.jobMeta || null;
    state.jobError = saved.jobError || null;
    state.jobLogs = Array.isArray(saved.jobLogs) ? saved.jobLogs : [];
    state.rawText = saved.rawText || saved.raw_text || saved.text || '';
    state.text = saved.text;
    state.normalizedText = normalizeNewlines(saved.text);
    state.lines = splitLinesKeepingEmpty(saved.text);
    state.lineOffsets = computeLineOffsets(saved.text);
    loadPipelineResult(saved.result, { fileName: state.fileName, persist: false });
    setStatus(`已恢复上次 pipeline 结果：${state.fileName}`, 'ok');
  } catch (_) {
    // Ignore corrupt cache.
  }
}


async function checkHealth() {
  const base = getApiBase();
  setStatus('正在检查同源 API 健康状态...', '');
  try {
    const response = await fetch(`${base}/api/v1/health`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    setStatus(`同源 API 正常：${data.service} / ${data.env} / ${data.llm_provider}:${data.llm_model}`, 'ok');
  } catch (error) {
    setStatus(`同源 API 不可用：${error.message}。请确认 Next.js 服务已启动，且环境变量配置正确。`, 'error');
  }
}

async function runFullPipeline() {
  const sourceText = state.rawText || state.text;
  if (!sourceText.trim()) {
    setStatus('请先上传或粘贴 TXT 文本。', 'warn');
    openUploadModal();
    return;
  }

  const base = getApiBase();
  const payload = {
    book_title: els.bookTitleInput.value.trim() || 'demo',
    text: sourceText,
  };

  state.result = null;
  state.selectedChapterId = null;
  state.selectedChunkId = 'all';
  state.selectedSpanKey = null;
  state.jobId = null;
  state.jobLogs = [];
  state.jobMeta = null;
  state.jobError = null;
  state.progressiveResult = null;
  state.completedChapterIds = new Set();
  updateResultStats();
  renderSource();
  renderResult();
  renderCandidateTable();
  renderRuntimeLogs();
  updateJobIdDisplay();
  setPipelineStep(2);
  setStatus('正在创建 Pipeline job...', '');
  els.runPipelineBtn.disabled = true;

  try {
    const createResponse = await fetch(`${base}/api/v1/pipeline/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!createResponse.ok) {
      let detail = `${createResponse.status} ${createResponse.statusText}`;
      try {
        const errorJson = await createResponse.json();
        detail = formatApiError(errorJson.detail) || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const created = await createResponse.json();
    state.jobId = created.job_id;
    state.jobMeta = pickJobMetadata(created);
    state.jobError = null;
    updateJobIdDisplay();
    setStatus(`Pipeline job 已创建：${state.jobId}，正在轮询进度...`, '');
    await pollPipelineJob(base, state.jobId);
  } catch (error) {
    state.jobError = { message: error.message };
    setPipelineStep(1);
    setStatus(`Pipeline 失败：${error.message}`, 'error');
  } finally {
    els.runPipelineBtn.disabled = false;
  }
}

async function pollPipelineJob(base, jobId) {
  while (true) {
    if (state.jobId !== jobId) return;
    const response = await fetch(`${base}/api/v1/pipeline/jobs/${jobId}?include_result=false&log_tail=${JOB_LOG_FETCH_LIMIT}`);
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errorJson = await response.json();
        detail = formatApiError(errorJson.detail) || detail;
      } catch (_) {}
      throw new Error(detail);
    }

    const job = await response.json();
    state.jobLogs = job.logs || [];
    state.jobMeta = pickJobMetadata(job);
    state.jobError = job.error ? { message: job.error, stage: job.stage || 'failed' } : null;
    applyProgressivePipelineResult(job.partial_result, job);
    updateStageFromJob(job);
    renderRuntimeLogs();
    setStatus(`${stageLabel(job.stage)}：${job.message || job.status}`, job.status === 'failed' ? 'error' : '');

    if (job.status === 'completed') {
      const completedJob = await fetchPipelineJobResult(base, jobId);
      if (state.jobId !== jobId) return;
      state.jobLogs = completedJob.logs || state.jobLogs;
      state.jobMeta = pickJobMetadata(completedJob);
      state.jobError = completedJob.error ? { message: completedJob.error, stage: completedJob.stage || 'completed' } : null;
      loadPipelineResult(completedJob.result, { fileName: state.fileName || 'pipeline result', persist: false });
      const persistedStorage = await persistCompletedResult(base, jobId);
      if (persistedStorage) completedJob.storage = { ...(completedJob.storage || {}), ...persistedStorage };
      saveLastResult();
      const firstChapter = state.result?.chapters?.[0];
      state.selectedChapterId = firstChapter?.chapter_id ?? null;
      state.selectedChunkId = 'all';
      state.selectedSpanKey = null;
      setPipelineStep(8);
      updateResultStats();
      renderSource();
      renderResult();
      renderCandidateTable();
      renderRuntimeLogs();
      const summary = getPipelineSummary();
      const storageHint = completedJob.storage?.frontend_result_path ? `完整 JSON 已保存：${completedJob.storage.frontend_result_path}` : '完整 JSON 已保存到浏览器缓存。';
      setStatus(`Pipeline 完成：${summary.chapterCount} 章，${summary.chunkCount} chunks，${summary.spanCount} spans，定位成功 ${summary.groundedCount}。${storageHint}`, 'ok');
      return;
    }

    if (job.status === 'failed') {
      state.jobError = {
        message: job.error || job.message || 'pipeline job failed',
        status: job.status,
        stage: job.stage || 'failed',
      };
      renderRuntimeLogs();
      throw new Error(job.error || job.message || 'pipeline job failed');
    }

    await sleep(900);
  }
}

function pickJobMetadata(job = {}) {
  if (!job || typeof job !== 'object') return null;
  return {
    job_id: job.job_id || state.jobId || null,
    status: job.status ?? null,
    stage: job.stage ?? null,
    message: job.message ?? null,
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    request_summary: job.request_summary ?? null,
    storage: job.storage ?? null,
  };
}


function applyProgressivePipelineResult(partialResult, job = {}) {
  if (!partialResult || !Array.isArray(partialResult.chapters)) return;
  const completedIds = new Set(partialResult.completed_chapter_ids || []);
  const previousCompleted = state.completedChapterIds || new Set();
  const hasNewCompletedChapter = [...completedIds].some((id) => !previousCompleted.has(id));
  const hasNoResultYet = !state.result;
  if (!hasNewCompletedChapter && !hasNoResultYet) return;

  const merged = mergeProgressiveResult(partialResult);
  const previousSelected = state.selectedChapterId;
  const previousChunk = state.selectedChunkId;
  const previousSpan = state.selectedSpanKey;

  state.progressiveResult = merged;
  state.completedChapterIds = completedIds;
  loadProgressivePipelineResult(merged, {
    selectedChapterId: previousSelected,
    selectedChunkId: previousChunk,
    selectedSpanKey: previousSpan,
  });

  const completedCount = completedIds.size;
  const totalCount = (merged.chapters || []).length;
  const summary = getPipelineSummary();
  setStatus(`已完成 ${formatNumber(completedCount)}/${formatNumber(totalCount)} 章，可先查看已完成章节；当前 spans ${formatNumber(summary.spanCount)}，定位成功 ${formatNumber(summary.groundedCount)}。`, 'ok');
}

function mergeProgressiveResult(partialResult) {
  const previous = state.progressiveResult || state.result || {};
  const byId = new Map((previous.chapters || []).map((chapter) => [chapter.chapter_id, chapter]));
  (partialResult.chapters || []).forEach((chapter) => {
    const existing = byId.get(chapter.chapter_id) || {};
    byId.set(chapter.chapter_id, { ...existing, ...chapter });
  });
  return {
    ...previous,
    ...partialResult,
    status: partialResult.status || previous.status || 'running_partial',
    chapters: [...byId.values()].sort((a, b) => Number(a.chapter_id || 0) - Number(b.chapter_id || 0)),
  };
}

function loadProgressivePipelineResult(result, { selectedChapterId, selectedChunkId, selectedSpanKey } = {}) {
  const rebuilt = rebuildTextFromPipelineResult(result);
  const normalizedResult = rebuilt.result;
  state.text = rebuilt.text;
  state.normalizedText = normalizeNewlines(rebuilt.text);
  state.lines = splitLinesKeepingEmpty(rebuilt.text);
  state.lineOffsets = computeLineOffsets(rebuilt.text);
  state.result = normalizedResult;
  state.spanLocations = buildAllSpanLocations();
  const completedChapter = (normalizedResult.chapters || []).find((chapter) => chapter.status === 'completed' || (chapter.chunks || []).length);
  state.selectedChapterId = (normalizedResult.chapters || []).some((chapter) => chapter.chapter_id === selectedChapterId)
    ? selectedChapterId
    : completedChapter?.chapter_id ?? normalizedResult.chapters?.[0]?.chapter_id ?? null;
  const selectedChapter = getSelectedChapter();
  state.selectedChunkId = selectedChapter && (selectedChapter.chunks || []).some((chunk) => chunk.chunk_id === selectedChunkId) ? selectedChunkId : 'all';
  state.selectedSpanKey = selectedSpanKey && getVisibleSpans().some((span) => span.key === selectedSpanKey) ? selectedSpanKey : null;
  updateInputStats();
  updateResultStats();
  renderSource();
  renderResult();
  renderCandidateTable();
}

async function fetchPipelineJobResult(base, jobId) {
  const response = await fetch(`${base}/api/v1/pipeline/jobs/${jobId}?include_result=true&log_tail=${JOB_LOG_FETCH_LIMIT}`);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const errorJson = await response.json();
      detail = formatApiError(errorJson.detail) || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return response.json();
}

async function persistCompletedResult(base, jobId) {
  if (!state.result) return null;
  if (jobId) state.result.job_id = state.result.job_id || jobId;
  const analysisPackage = buildAnalysisExportPackage();
  try {
    if (!jobId) throw new Error('missing job id');
    const response = await fetch(`${base}/api/v1/pipeline/jobs/${jobId}/frontend-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'frontend_demo',
        result: analysisPackage,
      }),
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errorJson = await response.json();
        detail = formatApiError(errorJson.detail) || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const saved = await response.json();
    appendRuntimeLog({
      ts: new Date().toISOString(),
      stage: 'frontend_result',
      message: '前端完整 JSON 结果已保存到 job 目录',
      frontend_result_path: saved.storage?.frontend_result_path,
    });
    if (AUTO_DOWNLOAD_JSON) exportResultJson();
    return saved.storage || null;
  } catch (error) {
    appendRuntimeLog({
      ts: new Date().toISOString(),
      stage: 'frontend_result',
      message: `前端保存到后端失败：${error.message}；已保留浏览器缓存`,
    });
  }
  if (AUTO_DOWNLOAD_JSON) exportResultJson();
  return null;
}

function appendRuntimeLog(log) {
  state.jobLogs = [...(state.jobLogs || []), log];
  renderRuntimeLogs();
}

function updateStageFromJob(job) {
  const stage = job.stage || '';
  const mapping = {
    queued: 1,
    running: 1,
    preprocess: 2,
    chapter_candidates: 3,
    chapter_validation: 3,
    chapter_split: 4,
    chapter_concurrency: 4,
    chapter_processing: 4,
    span_extraction: 5,
    grounding: 6,
    quote_recovery: 6,
    aliases: 6,
    role_voice_profile: 7,
    completed: 8,
    failed: 1,
  };
  setPipelineStep(mapping[stage] || 2);
}

function stageLabel(stage) {
  return {
    queued: '排队',
    running: '运行中',
    preprocess: '预处理',
    chapter_candidates: '章节候选识别',
    chapter_validation: 'LLM 章节判断',
    chapter_split: '章节拆分',
    chapter_concurrency: '章节并发',
    chapter_processing: '章节处理',
    span_extraction: 'LLM Span 抽取',
    grounding: 'Source Grounding',
    quote_recovery: '引号补抽',
    aliases: 'Aliases 合并',
    role_voice_profile: '角色声线',
    frontend_result: '前端结果存储',
    completed: '完成',
    failed: '失败',
  }[stage] || stage || '运行中';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function formatApiError(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => formatApiError(item)).filter(Boolean).join('；');
  }
  if (typeof detail === 'object') {
    return detail.message || detail.error || JSON.stringify(detail);
  }
  return String(detail);
}

function getApiBase() {
  return '';
}

function updateInputStats() {
  const chars = state.text.length;
  const lines = state.text ? state.lines.length : 0;
  els.inputStats.innerHTML = `
    <div><dt>文件</dt><dd title="${escapeAttr(state.fileName || '粘贴文本')}">${escapeHtml(state.fileName || (state.text ? '粘贴文本' : '尚未上传'))}</dd></div>
    <div><dt>字符数</dt><dd>${formatNumber(chars)}</dd></div>
    <div><dt>行数</dt><dd>${formatNumber(lines)}</dd></div>
  `;
}

function updateResultStats() {
  const summary = getPipelineSummary();
  els.resultStats.innerHTML = `
    <div><dt>章节数</dt><dd>${formatNumber(summary.chapterCount)}</dd></div>
    <div><dt>Chunk 数</dt><dd>${formatNumber(summary.chunkCount)}</dd></div>
    <div><dt>Dialogue spans</dt><dd>${formatNumber(summary.spanCount)}</dd></div>
    <div><dt>定位成功</dt><dd>${formatNumber(summary.groundedCount)}</dd></div>
    <div><dt>TTS segments</dt><dd>${formatNumber(summary.ttsSegmentCount)}</dd></div>
  `;
}

function setPipelineStep(step) {
  const items = [...els.pipelineSteps.children];
  const completed = step > items.length;
  items.forEach((item, index) => {
    const itemStep = index + 1;
    item.classList.toggle('done', completed || itemStep < step);
    item.classList.toggle('active', !completed && itemStep === step);
  });
}

function setStatus(message, type = '') {
  els.statusBar.textContent = message;
  els.statusBar.classList.remove('ok', 'warn', 'error');
  if (type) els.statusBar.classList.add(type);
}


function renderRuntimeLogs() {
  if (!els.runtimeLogs) return;
  const logs = state.jobLogs || [];
  updateJobIdDisplay();
  if (els.currentJobBadge) {
    els.currentJobBadge.textContent = state.jobId ? `#${state.jobId.slice(0, 8)}` : '无任务';
    els.currentJobBadge.title = state.jobId || '';
  }
  if (els.logCountBadge) els.logCountBadge.textContent = formatNumber(logs.length);
  if (!logs.length) {
    els.runtimeLogs.className = 'runtime-logs empty-state';
    els.runtimeLogs.textContent = state.jobId ? '等待当前任务日志。' : '尚未运行。';
    return;
  }
  els.runtimeLogs.className = 'runtime-logs';
  const visibleLogs = logs.slice(-JOB_LOG_RENDER_LIMIT);
  const truncatedNotice = logs.length > visibleLogs.length
    ? `<div class="log-row log-row-notice"><p>仅渲染最新 ${formatNumber(visibleLogs.length)} 条；当前已拉取 ${formatNumber(logs.length)} 条。</p></div>`
    : '';
  els.runtimeLogs.innerHTML = truncatedNotice + visibleLogs.map((log) => {
    const time = log.ts ? new Date(log.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const data = Object.entries(log)
      .filter(([key]) => !['ts', 'stage', 'message'].includes(key))
      .map(([key, value]) => `${key}=${formatLogValue(value)}`)
      .join(' · ');
    return `<div class="log-row"><span>${escapeHtml(time)}</span><strong>${escapeHtml(stageLabel(log.stage))}</strong><p>${escapeHtml(log.message || '')}${data ? `<em>${escapeHtml(data)}</em>` : ''}</p></div>`;
  }).join('');
  els.runtimeLogs.scrollTop = els.runtimeLogs.scrollHeight;
}

function updateJobIdDisplay() {
  if (!els.jobIdDisplay) return;
  if (!state.jobId) {
    els.jobIdDisplay.textContent = 'Job ID：无';
    els.jobIdDisplay.title = '';
    els.jobIdDisplay.classList.add('empty');
    return;
  }
  els.jobIdDisplay.textContent = `Job ID：${state.jobId}`;
  els.jobIdDisplay.title = `点击复制 Job ID：${state.jobId}`;
  els.jobIdDisplay.classList.remove('empty');
  if (!els.jobIdDisplay.dataset.boundCopy) {
    els.jobIdDisplay.dataset.boundCopy = 'true';
    els.jobIdDisplay.addEventListener('click', async () => {
      if (!state.jobId) return;
      try {
        await navigator.clipboard.writeText(state.jobId);
        setStatus(`已复制 Job ID：${state.jobId}`, 'ok');
      } catch (_) {
        setStatus(`当前 Job ID：${state.jobId}`, 'ok');
      }
    });
  }
}

function formatLogValue(value) {
  if (value === null || value === undefined) return '-';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function renderSource() {
  if (!state.text) {
    els.sourceVisualization.className = 'source-visualization empty-state';
    els.sourceVisualization.textContent = '暂无文本。点击右上角「上传 TXT」。';
    return;
  }

  els.sourceVisualization.className = 'source-visualization';
  const decisionByLine = buildDecisionByLine();
  const selectedChapter = getSelectedChapter();
  const allSpanLocations = state.spanLocations || [];
  const ttsSegmentLocations = buildTtsSegmentSourceLocations();
  const maxLines = 1800;
  const renderableLines = buildRenderableSourceLines();
  const linesToRender = renderableLines.slice(0, maxLines);
  const truncated = renderableLines.length > maxLines;

  const mapHtml = renderSourceMap();
  const linesHtml = linesToRender.map(({ line, index }) => {
    const lineNumber = index + 1;
    const offset = state.lineOffsets[index] || { start: 0, end: 0 };
    const visualEnd = Math.max(offset.end, offset.start + 1);
    const acceptedChapterDecision = getAcceptedChapterDecisionForLineRange(offset.start, visualEnd);
    const decision = decisionByLine.get(lineNumber) || acceptedChapterDecision;
    const selected = selectedChapter && rangesOverlap(offset.start, visualEnd, selectedChapter.start, selectedChapter.end);
    const hasAnySpan = allSpanLocations.some((span) => rangesOverlap(offset.start, visualEnd, span.start, span.end));
    const ttsCoverage = getLineTtsCoverage(offset.start, visualEnd, ttsSegmentLocations);
    const spanHit = false;
    const classes = [
      'source-line',
      decision ? 'candidate' : '',
      decision?.is_chapter_title ? 'accepted' : '',
      selected ? 'selected' : '',
      hasAnySpan ? 'has-span' : '',
      spanHit ? 'span-hit' : '',
    ].filter(Boolean).join(' ');
    const html = renderLineWithHighlights(line, offset.start, allSpanLocations, ttsSegmentLocations);
    const titleParts = [];
    if (decision) titleParts.push(`${decision.is_chapter_title ? '真章节' : '非章节'}：${decision.reason || ''}`);
    if (ttsCoverage) titleParts.push(ttsCoverage === 'dialogue' ? 'TTS 覆盖：对白 / 内心独白' : 'TTS 覆盖：旁白');
    const title = titleParts.join(' · ');
    return `<div class="${classes}" data-line="${lineNumber}" data-start="${offset.start}" data-end="${offset.end}" title="${escapeAttr(title)}">
      <div class="line-number">${lineNumber}</div>
      <div class="line-text">${html}</div>
    </div>`;
  }).join('');

  els.sourceVisualization.innerHTML = `
    ${mapHtml}
    <div class="source-scroll">${linesHtml}${truncated ? `<div class="source-line"><div class="line-number">…</div><div class="line-text">仅渲染前 ${maxLines} 行以保证浏览器性能</div></div>` : ''}</div>
  `;

  els.sourceVisualization.querySelectorAll('.source-map-segment').forEach((node) => {
    node.addEventListener('click', () => selectChapter(Number(node.dataset.chapterId)));
  });
  updateSourceHighlights();
}

function buildRenderableSourceLines() {
  return state.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !shouldHideSourceLine(line));
}

function shouldHideSourceLine(line) {
  return HIDE_CLEANED_EMPTY_LINES && Boolean(state.result) && !String(line || '').trim();
}

function renderLineWithHighlights(line, lineStart, allSpans, ttsSegments = []) {
  const safeLine = line || ' ';
  const lineEnd = lineStart + safeLine.length;
  const ranges = [];

  (ttsSegments || []).forEach((segment) => {
    if (segment.type !== 'narration') return;
    if (!rangesOverlap(lineStart, lineEnd, segment.start, segment.end)) return;
    ranges.push({
      start: Math.max(0, segment.start - lineStart),
      end: Math.min(safeLine.length, segment.end - lineStart),
      type: 'tts-narration-soft',
    });
  });

  (allSpans || []).forEach((span) => {
    if (!rangesOverlap(lineStart, lineEnd, span.start, span.end)) return;
    ranges.push({
      start: Math.max(0, span.start - lineStart),
      end: Math.min(safeLine.length, span.end - lineStart),
      type: 'span-soft',
    });
  });

  return renderHighlightedText(safeLine, ranges);
}

function renderHighlightedText(text, ranges) {
  const points = [...new Set([0, text.length, ...ranges.flatMap((range) => [range.start, range.end])])]
    .filter((point) => point >= 0 && point <= text.length)
    .sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const active = ranges.filter((range) => range.start < end && range.end > start);
    const type = active.some((range) => range.type === 'span-mark')
      ? 'span-mark'
      : active.some((range) => range.type === 'span-soft')
        ? 'span-soft'
        : active.some((range) => range.type === 'tts-narration-soft')
          ? 'tts-narration-soft'
          : '';
    const piece = escapeHtml(text.slice(start, end));
    html += type ? `<mark class="${type}">${piece}</mark>` : piece;
  }
  return html || escapeHtml(text || ' ');
}


function renderSourceMap() {
  const chapters = state.result?.chapters || [];
  if (!chapters.length) return '';
  const total = Math.max(1, getSourceBasisLength());
  const palette = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4f46e5', '#65a30d'];
  const segments = chapters.map((chapter, index) => {
    const length = Math.max(1, (chapter.end || 0) - (chapter.start || 0));
    const width = Math.max(0.8, (length / total) * 100);
    const selected = chapter.chapter_id === state.selectedChapterId ? 'selected' : '';
    const done = isChapterCompleted(chapter);
    const statusClass = done ? 'completed' : 'pending';
    const statusLabel = done ? '已完成' : '处理中';
    return `<div class="source-map-segment ${selected} ${statusClass}" data-chapter-id="${chapter.chapter_id}" style="width:${width}%; background:${palette[index % palette.length]}" title="${escapeAttr(chapter.title)} · ${statusLabel} · ${formatNumber(length)} chars"></div>`;
  }).join('');
  return `<div class="source-map" aria-label="章节在文本中的位置">${segments}</div>`;
}

function renderResult() {
  const chapters = state.result?.chapters || [];
  if (!chapters.length) {
    els.resultVisualization.className = 'result-visualization empty-state';
    els.resultVisualization.textContent = state.text ? '尚未运行完整 Pipeline。' : '运行完整 Pipeline 后，这里会展示流程统计、章节/Chunk 导航、span 列表和定位状态。';
    els.exportJsonBtn.disabled = true;
    return;
  }

  els.exportJsonBtn.disabled = false;
  els.resultVisualization.className = 'result-visualization pipeline-inspector';
  els.resultVisualization.innerHTML = `
    ${renderPipelineSummary()}
    <div class="inspector-grid">
      <aside class="chapter-nav" aria-label="章节导航">${renderChapterNav()}</aside>
      <section class="span-panel">${renderSpanPanel()}</section>
    </div>
  `;

  els.resultVisualization.querySelectorAll('[data-action="select-chapter"]').forEach((node) => {
    node.addEventListener('click', () => selectChapter(Number(node.dataset.chapterId)));
  });
  els.resultVisualization.querySelectorAll('[data-action="select-chunk"]').forEach((node) => {
    node.addEventListener('click', () => selectChunk(node.dataset.chunkId || 'all'));
  });
  els.resultVisualization.querySelectorAll('[data-action="select-span"]').forEach((node) => {
    node.addEventListener('click', () => selectSpan(node.dataset.spanKey, { scrollRight: false }));
  });
}

function renderPipelineSummary() {
  const summary = getPipelineSummary();
  const grounding = state.result?.grounding || {};
  const detection = state.result?.chapter_title_detection || {};
  return `<div class="flow-summary">
    <div class="flow-step"><span>1</span><strong>预处理</strong><small>${formatNumber(state.result?.preprocessing?.output_chars || 0)} chars</small></div>
    <div class="flow-step"><span>2</span><strong>章节判断</strong><small>${formatNumber(detection.accepted_count || 0)}/${formatNumber(detection.candidate_count || 0)} 真章节</small></div>
    <div class="flow-step"><span>3</span><strong>拆章/Chunk</strong><small>${formatNumber(summary.chapterCount)} 章 · ${formatNumber(summary.chunkCount)} chunks</small></div>
    <div class="flow-step"><span>4</span><strong>Span 抽取</strong><small>${formatNumber(summary.primarySpanCount)} 主抽取 · ${formatNumber(summary.recoveredSpanCount)} 补抽</small></div>
    <div class="flow-step"><span>5</span><strong>TTS 覆盖</strong><small>${formatNumber(summary.ttsSegmentCount)} segments · ${summary.ttsCoverageOk ? '覆盖完整' : '需检查'}</small></div>
  </div>`;
}

function renderChapterNav() {
  const chapters = state.result?.chapters || [];
  return chapters.map((chapter) => {
    const selected = chapter.chapter_id === state.selectedChapterId ? 'selected' : '';
    const metrics = getChapterMetrics(chapter);
    const done = isChapterCompleted(chapter);
    const statusClass = done ? 'completed' : 'pending';
    const statusLabel = done ? '已完成' : '处理中';
    return `<button class="nav-chapter ${selected} ${statusClass}" data-action="select-chapter" data-chapter-id="${chapter.chapter_id}">
      <strong>${chapter.chapter_id}. ${escapeHtml(chapter.title || '未命名章节')} <em>${statusLabel}</em></strong>
      <span>${formatNumber(metrics.chunkCount)} chunks · ${formatNumber(metrics.spanCount)} spans · ${formatNumber(metrics.groundedCount)} located</span>
    </button>`;
  }).join('');
}

function renderSpanPanel() {
  const chapter = getSelectedChapter();
  if (!chapter) return '<div class="empty-inline">请选择章节。</div>';
  const chunks = chapter.chunks || [];
  const pending = !isChapterCompleted(chapter);
  const spans = getVisibleSpans();
  const metrics = getChapterMetrics(chapter);
  return `
    <div class="selected-header">
      <div>
        <h3>${escapeHtml(chapter.title || '未命名章节')}</h3>
        <p>清洗后 ${formatNumber(chapter.char_count || 0)} 字 · ${formatNumber(metrics.spanCount)} spans（补抽 ${formatNumber(metrics.recoveredSpanCount)}）· ${formatNumber(metrics.groundedCount)} 定位成功</p>
      </div>
      <span class="badge ${pending ? 'amber' : metrics.unresolvedCount ? 'amber' : 'green'}">${pending ? 'processing' : metrics.unresolvedCount ? `${formatNumber(metrics.unresolvedCount)} unresolved` : 'all located'}</span>
    </div>
    <div class="chunk-tabs">
      <button class="chunk-tab ${state.selectedChunkId === 'all' ? 'active' : ''}" data-action="select-chunk" data-chunk-id="all">全部</button>
      ${chunks.map((chunk) => renderChunkTab(chunk)).join('')}
    </div>
    <div class="span-list">
      ${pending ? '<div class="empty-inline pending-inline">该章节仍在处理中，完成后会自动展示 chunk 和 spans。</div>' : spans.length ? spans.map(renderSpanCard).join('') : '<div class="empty-inline">当前范围没有 dialogue span。</div>'}
    </div>
  `;
}

function renderChunkTab(chunk) {
  const metrics = getChunkMetrics(chunk);
  const active = state.selectedChunkId === chunk.chunk_id ? 'active' : '';
  return `<button class="chunk-tab ${active}" data-action="select-chunk" data-chunk-id="${escapeAttr(chunk.chunk_id)}">
    ${escapeHtml(chunk.chunk_id)} <span>${formatNumber(metrics.spanCount)} / +${formatNumber(metrics.recoveredSpanCount)}</span>
  </button>`;
}

function renderSpanCard(item) {
  const span = item.grounded || item.raw || {};
  const raw = item.raw || {};
  const isSelected = item.key === state.selectedSpanKey ? 'selected' : '';
  const located = span.start !== null && span.start !== undefined && span.end !== null && span.end !== undefined;
  const status = span.status || (located ? 'located' : 'raw_only');
  const source = item.source || span.source || 'llm';
  const statusClass = located ? 'green' : status === 'ambiguous' ? 'amber' : 'red';
  const speaker = span.speaker || raw.speaker || 'unknown_speaker';
  const gender = span.speaker_gender || raw.speaker_gender || 'unknown';
  const confidence = raw.confidence ?? span.confidence;
  const emotion = span.emotion || raw.emotion || '';
  const text = span.dialogue_text || raw.dialogue_text || span.text || '';
  const rawDialogueText = span.raw_dialogue_text || raw.raw_dialogue_text || '';
  return `<article class="span-card ${isSelected}" data-action="select-span" data-span-key="${escapeAttr(item.key)}">
    <div class="span-card-head">
      <div>
        <strong>${escapeHtml(speaker)}</strong>
        <span class="muted">${escapeHtml(gender)}${raw.alias_used || span.alias_used ? ` · alias: ${escapeHtml(raw.alias_used || span.alias_used)}` : ''}</span>
      </div>
      <div class="span-head-badges">
        ${emotion ? `<span class="badge emotion">${escapeHtml(emotion)}</span>` : ''}
        <span class="badge ${source === 'quote_span_recovery' ? 'purple' : statusClass}">${source === 'quote_span_recovery' ? 'quote recovery' : escapeHtml(status)}</span>
      </div>
    </div>
    <blockquote>${escapeHtml(text || '空 dialogue_text')}</blockquote>
    <div class="span-meta">
      <span>${item.chapterId}/${escapeHtml(item.chunkId)}</span>
      <span>${escapeHtml(source)}</span>
      <span>offset ${located ? `${formatNumber(span.start)}–${formatNumber(span.end)}` : '-'}</span>
      <span>match ${formatConfidence(span.match_score)}</span>
      <span>LLM ${formatConfidence(confidence)}</span>
      ${rawDialogueText ? `<span>raw ${escapeHtml(rawDialogueText)}</span>` : ''}
      ${raw.quote_recovery_reason ? `<span>补抽原因 ${escapeHtml(raw.quote_recovery_reason)}</span>` : ''}
    </div>
    ${span.message ? `<div class="span-message">${escapeHtml(span.message)}</div>` : ''}
  </article>`;
}

function renderCandidateTable() {
  const decisions = state.result?.chapter_title_detection?.decisions || [];
  const enabled = Boolean(state.result?.chapter_title_detection?.enabled);
  const acceptedCount = decisions.filter((item) => item.is_chapter_title).length;
  const rejectedCount = decisions.length - acceptedCount;

  if (els.countAll) els.countAll.textContent = formatNumber(decisions.length);
  if (els.countAccepted) els.countAccepted.textContent = formatNumber(acceptedCount);
  if (els.countRejected) els.countRejected.textContent = formatNumber(rejectedCount);
  els.candidateFilterButtons.forEach((button) => {
    button.classList.toggle('active', (button.dataset.filter || 'all') === state.candidateFilter);
  });

  if (!state.result) {
    els.candidateTable.className = 'candidate-table empty-state';
    els.candidateTable.textContent = state.text ? '尚未运行完整 Pipeline。' : '暂无结果。';
    return;
  }

  const filtered = decisions.filter((item) => {
    if (state.candidateFilter === 'accepted') return item.is_chapter_title;
    if (state.candidateFilter === 'rejected') return !item.is_chapter_title;
    return true;
  });

  els.candidateTable.className = 'candidate-table roles-and-titles';
  els.candidateTable.innerHTML = `
    <div class="candidate-summary">
      <span class="badge ${enabled ? 'blue' : 'amber'}">${enabled ? 'LLM 标题判断' : '未调用 LLM 标题判断'}</span>
      <span>真章节：<strong>${formatNumber(acceptedCount)}</strong></span>
      <span>非章节：<strong>${formatNumber(rejectedCount)}</strong></span>
      <span>角色 aliases：<strong>${formatNumber((state.result.aliases || []).length)}</strong></span>
      <span>voice profiles：<strong>${formatNumber((state.result.role_registry || []).length)}</strong></span>
    </div>
    <div class="bottom-grid">
      <div>${renderTitleDecisionTable(filtered)}</div>
      <div>${renderAliasList()}</div>
    </div>
  `;
  els.candidateTable.querySelectorAll('.line-jump').forEach((button) => {
    button.addEventListener('click', () => scrollSourceLineIntoView(Number(button.dataset.line)));
  });
}

function renderTitleDecisionTable(decisions) {
  if (!decisions.length) return '<div class="empty-inline">当前筛选条件下没有标题候选。</div>';
  const rows = decisions.map((item) => {
    const badgeClass = item.is_chapter_title ? 'green' : 'red';
    const status = item.is_chapter_title ? '真章节' : '非章节';
    const title = item.normalized_title || item.title || item.raw_line || '';
    const displayLine = getDecisionDisplayLine(item);
    const lineCell = displayLine
      ? `<button class="line-jump" data-line="${displayLine}" title="cleaned display line ${displayLine}">${formatNumber(displayLine)}</button>`
      : `<span class="line-static" title="原始 TXT 行号，cleaned 视图中不定位">${formatNumber(item.line_number || 0)}</span>`;
    return `<tr class="candidate-row ${item.is_chapter_title ? 'accepted' : 'rejected'}">
      <td>${lineCell}</td>
      <td><span class="badge ${badgeClass}">${status}</span></td>
      <td><strong>${escapeHtml(title)}</strong><div class="raw-line">${escapeHtml(item.reason || '')}</div></td>
    </tr>`;
  }).join('');
  return `<h3 class="subsection-title">章节标题判断</h3><div class="table-wrap"><table>
    <thead><tr><th>行号</th><th>判断</th><th>标题 / 原因</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function getDecisionDisplayLine(decision) {
  if (!decision?.is_chapter_title) return null;
  const title = String(decision.normalized_title || decision.title || decision.raw_line || '').trim();
  const chapter = (state.result?.chapters || []).find((item) => {
    const chapterTitle = String(item.title || '').trim();
    return chapterTitle && (chapterTitle === title || title.includes(chapterTitle) || chapterTitle.includes(title));
  });
  return chapter?.display_title_line || null;
}

function renderAliasList() {
  const registry = state.result?.role_registry || [];
  if (registry.length) return renderRoleRegistry(registry);

  const aliases = state.result?.aliases || [];
  if (!aliases.length) return '<h3 class="subsection-title">角色声线 Profile</h3><div class="empty-inline">暂无 role registry / aliases。</div>';
  const rows = aliases.map((entry) => `<div class="alias-card">
    <div><strong>${escapeHtml(entry.canonical_name || 'unknown')}</strong><span class="badge blue">${escapeHtml(entry.gender || 'unknown')}</span></div>
    <p>${(entry.aliases || []).map((alias) => `<span>${escapeHtml(alias)}</span>`).join('') || '<em>无别名</em>'}</p>
  </div>`).join('');
  return `<h3 class="subsection-title">角色别名 / 性别投票结果</h3><div class="alias-list">${rows}</div>`;
}

function renderRoleRegistry(registry) {
  const generation = state.result?.role_voice_profile_generation || {};
  const rows = registry.map((role) => {
    const profile = role.voice_profile || {};
    const aliases = Array.isArray(role.aliases) ? role.aliases : [];
    return `<div class="alias-card role-profile-card">
      <div class="role-profile-head">
        <strong>${escapeHtml(role.canonical_name || 'unknown')}</strong>
        <span class="badge purple">${escapeHtml(role.voice_profile_id || role.role_id || 'profile')}</span>
      </div>
      <div class="profile-tags">
        <span>${escapeHtml(profile.gender || role.gender || 'unknown')}</span>
        <span>${escapeHtml(profile.age_group || '未知')}</span>
        <span>confidence ${formatConfidence(profile.confidence)}</span>
        <span>${escapeHtml(profile.source || generation.status || 'profile')}</span>
        ${role.evidence_truncated ? '<span>evidence truncated</span>' : ''}
      </div>
      ${profile.description ? `<p class="profile-desc">${escapeHtml(profile.description)}</p>` : ''}
      ${profile.fallback_reason ? `<div class="profile-evidence-meta">fallback: ${escapeHtml(profile.fallback_reason)}</div>` : ''}
      <p class="profile-aliases">${aliases.map((alias) => `<span>${escapeHtml(alias)}</span>`).join('') || '<em>无别名</em>'}</p>
      <div class="profile-evidence-meta">evidence spans ${formatNumber(role.evidence_span_count || 0)} · chars ${formatNumber(role.evidence_char_count || 0)}</div>
    </div>`;
  }).join('');
  const statusBadge = `<span class="badge ${generation.status === 'llm_enriched' ? 'green' : 'amber'}">${escapeHtml(generation.status || 'role_registry')}</span>`;
  return `<h3 class="subsection-title">角色声线 Profile ${statusBadge}</h3><div class="alias-list">${rows}</div>`;
}

function buildAllSpanLocations() {
  const locations = [];
  (state.result?.chapters || []).forEach((chapter) => {
    (chapter.chunks || []).forEach((chunk) => {
      getChunkSpanItems(chapter, chunk).forEach((item) => {
        const location = resolveSpanSourceLocation(item);
        if (location && isLocated(location)) {
          locations.push({ ...location, key: item.key, chapterId: item.chapterId, chunkId: item.chunkId });
        }
      });
    });
  });
  return dedupeLocations(locations);
}

function dedupeLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = `${location.start}:${location.end}:${location.key || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTtsSegmentSourceLocations() {
  const locations = [];
  (state.result?.chapters || []).forEach((chapter) => {
    const segments = Array.isArray(chapter.tts_segments) ? chapter.tts_segments : [];
    segments.forEach((segment) => {
      const start = Number(segment.display_start ?? segment.start ?? 0);
      const end = Number(segment.display_end ?? segment.end ?? segment.start ?? 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      locations.push({
        start,
        end,
        type: segment.type === 'dialogue' ? 'dialogue' : 'narration',
        chapterId: chapter.chapter_id,
      });
    });
  });
  return locations;
}

function getLineTtsCoverage(lineStart, lineEnd, locations) {
  let hasNarration = false;
  for (const location of locations || []) {
    if (!rangesOverlap(lineStart, lineEnd, location.start, location.end)) continue;
    if (location.type === 'dialogue') return 'dialogue';
    hasNarration = true;
  }
  return hasNarration ? 'narration' : '';
}


function getPipelineSummary() {
  const chapters = state.result?.chapters || [];
  const summary = emptyMetrics();
  summary.chapterCount = chapters.length;
  chapters.forEach((chapter) => {
    addTtsMetrics(summary, chapter.tts_segment_summary || {});
    (chapter.chunks || []).forEach((chunk) => {
      summary.chunkCount += 1;
      addMetrics(summary, getChunkMetrics(chunk, chapter));
    });
  });
  return summary;
}

function getChapterMetrics(chapter) {
  const metrics = emptyMetrics();
  const chunks = chapter.chunks || [];
  addTtsMetrics(metrics, chapter.tts_segment_summary || {});
  metrics.chunkCount = chunks.length;
  chunks.forEach((chunk) => addMetrics(metrics, getChunkMetrics(chunk, chapter)));
  return metrics;
}

function getChunkMetrics(chunk, chapter = getSelectedChapter()) {
  const items = getChunkSpanItems(chapter, chunk);
  const metrics = emptyMetrics();
  metrics.spanCount = items.length;
  metrics.primarySpanCount = items.filter((item) => item.source !== 'quote_span_recovery').length;
  metrics.recoveredSpanCount = items.filter((item) => item.source === 'quote_span_recovery').length;
  metrics.groundedCount = items.filter((item) => isLocated(item.grounded)).length;
  metrics.unresolvedCount = metrics.spanCount - metrics.groundedCount;
  metrics.quoteCandidateCount = Array.isArray(chunk.quote_span_candidates) ? chunk.quote_span_candidates.length : 0;
  metrics.missedQuoteCount = Array.isArray(chunk.missed_quote_span_candidates) ? chunk.missed_quote_span_candidates.length : 0;
  return metrics;
}

function emptyMetrics() {
  return {
    chapterCount: 0,
    chunkCount: 0,
    spanCount: 0,
    primarySpanCount: 0,
    recoveredSpanCount: 0,
    groundedCount: 0,
    unresolvedCount: 0,
    quoteCandidateCount: 0,
    missedQuoteCount: 0,
    ttsSegmentCount: 0,
    ttsNarrationSegmentCount: 0,
    ttsDialogueSegmentCount: 0,
    ttsSkippedSpanCount: 0,
    ttsCoverageOk: true,
  };
}

function addMetrics(target, source) {
  Object.keys(emptyMetrics()).forEach((key) => {
    if (key === 'chapterCount' || key === 'chunkCount') return;
    if (key === 'ttsCoverageOk') {
      target.ttsCoverageOk = Boolean(target.ttsCoverageOk) && source.ttsCoverageOk !== false;
      return;
    }
    target[key] += source[key] || 0;
  });
}

function addTtsMetrics(target, summary) {
  target.ttsSegmentCount += Number(summary.segment_count || 0);
  target.ttsNarrationSegmentCount += Number(summary.narration_segment_count || 0);
  target.ttsDialogueSegmentCount += Number(summary.dialogue_segment_count || 0);
  target.ttsSkippedSpanCount += Number(summary.skipped_dialogue_span_count || 0);
  target.ttsCoverageOk = Boolean(target.ttsCoverageOk) && summary.coverage_ok !== false;
}

function getVisibleSpans() {
  const chapter = getSelectedChapter();
  if (!chapter) return [];
  return (chapter.chunks || [])
    .filter((chunk) => state.selectedChunkId === 'all' || chunk.chunk_id === state.selectedChunkId)
    .flatMap((chunk) => getChunkSpanItems(chapter, chunk));
}

function getChunkSpanItems(chapter, chunk) {
  if (!chapter || !chunk) return [];
  const rawSpans = Array.isArray(chunk.llm_result?.dialogue_spans) ? chunk.llm_result.dialogue_spans : [];
  const grounded = Array.isArray(chunk.grounded_dialogue_spans) ? chunk.grounded_dialogue_spans : [];
  const recoveredRaw = Array.isArray(chunk.quote_recovery_llm_result?.dialogue_spans) ? chunk.quote_recovery_llm_result.dialogue_spans : [];
  const recoveredGrounded = Array.isArray(chunk.recovered_grounded_dialogue_spans) ? chunk.recovered_grounded_dialogue_spans : [];
  const recoveredKeys = new Set(recoveredGrounded.map((span) => `${span.start}:${span.end}:${span.dialogue_text || span.text || ''}`));
  const primaryGrounded = grounded.filter((span) => !recoveredKeys.has(`${span.start}:${span.end}:${span.dialogue_text || span.text || ''}`));
  const primaryLength = Math.max(rawSpans.length, primaryGrounded.length);
  const items = Array.from({ length: primaryLength }, (_, index) => ({
    key: `${chapter.chapter_id}:${chunk.chunk_id}:llm:${index}`,
    chapterId: chapter.chapter_id,
    chunkId: chunk.chunk_id,
    index,
    source: 'llm',
    raw: rawSpans[index] || {},
    grounded: primaryGrounded[index] || null,
  }));
  const recoveredLength = Math.max(recoveredRaw.length, recoveredGrounded.length);
  for (let index = 0; index < recoveredLength; index += 1) {
    items.push({
      key: `${chapter.chapter_id}:${chunk.chunk_id}:quote:${index}`,
      chapterId: chapter.chapter_id,
      chunkId: chunk.chunk_id,
      index,
      source: 'quote_span_recovery',
      raw: recoveredRaw[index] || {},
      grounded: recoveredGrounded[index] || null,
    });
  }
  return items;
}


function getSelectedSpanLocation() {
  if (!state.selectedSpanKey) return null;
  const item = getVisibleSpans().find((candidate) => candidate.key === state.selectedSpanKey);
  if (!item) return null;
  return resolveSpanSourceLocation(item);
}

function resolveSpanSourceLocation(item) {
  const chapter = (state.result?.chapters || []).find((candidate) => candidate.chapter_id === item.chapterId);
  const chapterStart = chapter?.start ?? 0;
  const chapterEnd = chapter?.end ?? getSourceBasisLength();
  const groundedLocation = resolveGroundedSourceLocation(item.grounded, chapterStart);
  if (groundedLocation) return groundedLocation;

  for (const query of getDialogueSearchQueries(item)) {
    if (!shouldUseFrontendSearchFallback(query, chapterStart, chapterEnd)) continue;
    const index = findQueryInChapter(query, chapterStart, chapterEnd);
    if (index >= 0 && index + query.length <= chapterEnd) {
      return {
        start: index,
        end: index + query.length,
        status: item.grounded?.status || 'source_text_match',
        method: item.grounded?.method || 'frontend_source_exact',
        match_score: item.grounded?.match_score ?? 1,
      };
    }
  }

  return null;
}

function resolveGroundedSourceLocation(grounded, chapterStart) {
  if (!isLocated(grounded)) return null;
  const start = Number(grounded.display_start ?? grounded.start ?? 0);
  const end = Number(grounded.display_end ?? grounded.end ?? grounded.start ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start || end > getSourceBasisLength()) return null;
  return {
    ...grounded,
    start,
    end,
    status: grounded.status || 'grounded',
  };
}

function shouldUseFrontendSearchFallback(query, chapterStart, chapterEnd) {
  const text = String(query || '').trim();
  if (!text) return false;
  if (text.length <= 4) return false;
  return countQueryOccurrencesInChapter(text, chapterStart, chapterEnd) === 1;
}

function countQueryOccurrencesInChapter(query, chapterStart, chapterEnd) {
  let count = 0;
  let index = state.normalizedText.indexOf(query, chapterStart);
  while (index >= 0 && index + query.length <= chapterEnd) {
    count += 1;
    if (count > 1) return count;
    index = state.normalizedText.indexOf(query, index + 1);
  }
  return count;
}

function findQueryInChapter(query, chapterStart, chapterEnd) {
  if (!query) return -1;
  const index = state.normalizedText.indexOf(query, chapterStart);
  return index >= 0 && index + query.length <= chapterEnd ? index : -1;
}

function getDialogueSearchQueries(item) {
  const values = [
    item.grounded?.text,
    item.grounded?.dialogue_text,
    item.raw?.dialogue_text,
  ];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function selectChapter(chapterId) {
  if (!chapterId) return;
  state.selectedChapterId = chapterId;
  state.selectedChunkId = 'all';
  state.selectedSpanKey = null;
  renderResult();
  updateSourceHighlights();
  const chapter = getSelectedChapter();
  if (chapter?.start !== undefined) scrollOffsetIntoView(chapter.display_title_start ?? chapter.start, { behavior: 'smooth' });
}

function selectChunk(chunkId) {
  state.selectedChunkId = chunkId || 'all';
  state.selectedSpanKey = null;
  renderResult();
  updateSourceHighlights();
  const chapter = getSelectedChapter();
  if (chapter && state.selectedChunkId !== 'all') {
    const chunk = (chapter.chunks || []).find((candidate) => candidate.chunk_id === state.selectedChunkId);
    if (chunk) scrollOffsetIntoView(chunk.display_start ?? chunk.start ?? chapter.start ?? 0, { behavior: 'smooth' });
  }
}

function selectSpan(spanKey, { scrollRight = true } = {}) {
  state.selectedSpanKey = spanKey;
  const item = getVisibleSpans().find((candidate) => candidate.key === spanKey);
  if (item?.chapterId) state.selectedChapterId = item.chapterId;
  const location = item ? resolveSpanSourceLocation(item) : null;
  if (location && isLocated(location)) {
    setStatus(`已定位 span：${location.start}–${location.end}，${location.status}`, 'ok');
  } else {
    setStatus('该 span 暂无可靠原文定位，可查看 grounding 状态和候选原因。', 'warn');
  }
  updateSourceHighlights();
  if (location && isLocated(location)) scrollOffsetIntoView(location.start, { behavior: 'smooth' });
  updateSelectedSpanCard({ scrollIntoView: scrollRight });
}

function updateSelectedSpanCard({ scrollIntoView = true } = {}) {
  let selectedNode = null;
  els.resultVisualization.querySelectorAll('.span-card').forEach((node) => {
    const selected = node.dataset.spanKey === state.selectedSpanKey;
    node.classList.toggle('selected', selected);
    if (selected) selectedNode = node;
  });
  if (scrollIntoView && selectedNode) {
    scrollElementInsideNearestContainer(selectedNode, '.span-list');
  }
}

function scrollElementInsideNearestContainer(element, containerSelector) {
  const container = element.closest(containerSelector);
  if (!container) {
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const above = elementRect.top < containerRect.top;
  const below = elementRect.bottom > containerRect.bottom;
  if (!above && !below) return;
  const delta = above ? elementRect.top - containerRect.top : elementRect.bottom - containerRect.bottom;
  container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
}

function isChapterCompleted(chapter) {
  return Boolean(chapter && (chapter.status === 'completed' || (state.completedChapterIds instanceof Set && state.completedChapterIds.has(chapter.chapter_id))));
}

function getSelectedChapter() {
  return (state.result?.chapters || []).find((chapter) => chapter.chapter_id === state.selectedChapterId) || null;
}

function buildDecisionByLine() {
  const map = new Map();
  const decisions = state.result?.chapter_title_detection?.decisions || [];
  (state.result?.chapters || []).forEach((chapter) => {
    const title = String(chapter.title || '').trim();
    if (title && chapter.display_title_line) {
      map.set(chapter.display_title_line, {
        candidate_id: `display_chapter_${chapter.chapter_id}`,
        line_number: chapter.display_title_line,
        raw_line: title,
        title,
        normalized_title: title,
        is_chapter_title: true,
        confidence: 1,
        reason: 'cleaned display chapter title',
      });
    }
  });
  decisions.forEach((decision) => {
    if (decision.line_number && !map.has(decision.line_number)) map.set(decision.line_number, decision);
  });
  return map;
}

function getAcceptedChapterDecisionForLineRange(lineStart, lineEnd) {
  const chapter = (state.result?.chapters || []).find((item) => {
    const titleStart = Number(item.display_title_start ?? NaN);
    const titleEnd = Number(item.display_title_end ?? NaN);
    return Number.isFinite(titleStart) && Number.isFinite(titleEnd) && rangesOverlap(lineStart, lineEnd, titleStart, Math.max(titleEnd, titleStart + 1));
  });
  if (!chapter) return null;
  const title = String(chapter.title || '').trim();
  return {
    candidate_id: `display_chapter_${chapter.chapter_id}`,
    line_number: chapter.display_title_line || offsetToLineNumber(chapter.display_title_start ?? lineStart),
    raw_line: title,
    title,
    normalized_title: title,
    is_chapter_title: true,
    confidence: 1,
    reason: 'display chapter title range',
  };
}

function updateSourceHighlights() {
  const selectedChapter = getSelectedChapter();
  const selectedSpan = getSelectedSpanLocation();
  const sourceLines = els.sourceVisualization.querySelectorAll('.source-line[data-start]');
  sourceLines.forEach((line) => {
    const start = Number(line.dataset.start);
    const end = Number(line.dataset.end);
    const selected = selectedChapter && rangesOverlap(start, end, selectedChapter.start, selectedChapter.end);
    const spanHit = selectedSpan && isLocated(selectedSpan) && rangesOverlap(start, end, selectedSpan.start, selectedSpan.end);
    line.classList.toggle('selected', Boolean(selected));
    line.classList.toggle('span-hit', Boolean(spanHit));
  });
  els.sourceVisualization.querySelectorAll('.source-map-segment').forEach((node) => {
    node.classList.toggle('selected', Number(node.dataset.chapterId) === state.selectedChapterId);
  });
}

function scrollSourceLineIntoView(lineNumber) {
  if (!lineNumber) return;
  const line = els.sourceVisualization.querySelector(`[data-line="${lineNumber}"]`);
  if (!line) return;
  scrollSourceLineNode(line, { behavior: 'smooth' });
}

function scrollOffsetIntoView(offset, { behavior = 'smooth' } = {}) {
  const lines = [...els.sourceVisualization.querySelectorAll('.source-line[data-start]')];
  const line = lines.find((node) => {
    const start = Number(node.dataset.start);
    const end = Number(node.dataset.end);
    return offset >= start && offset <= end;
  }) || lines.find((node) => Number(node.dataset.start) >= offset);
  if (!line) return;
  scrollSourceLineNode(line, { behavior });
}

function scrollSourceLineNode(line, { behavior = 'smooth' } = {}) {
  const container = els.sourceVisualization.querySelector('.source-scroll');
  if (container) {
    const lineRect = line.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const targetTop = container.scrollTop + (lineRect.top - containerRect.top) - (container.clientHeight / 2) + (line.clientHeight / 2);
    container.scrollTo({ top: Math.max(0, targetTop), behavior });
  } else {
    line.scrollIntoView({ behavior, block: 'center' });
  }
  line.classList.add('flash');
  setTimeout(() => line.classList.remove('flash'), 1300);
}

function isLocated(span) {
  return Boolean(span && span.start !== null && span.start !== undefined && span.end !== null && span.end !== undefined);
}

function normalizeNewlines(text) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u2028/g, '\n').replace(/\u2029/g, '\n').replace(/^\ufeff+/, '').replace(/\x00/g, '');
}

function splitLinesKeepingEmpty(text) {
  return normalizeNewlines(text).split('\n');
}

function computeLineOffsets(text) {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split('\n');
  const offsets = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push({ start: cursor, end: cursor + line.length });
    cursor += line.length + 1;
  }
  return offsets;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function getSourceBasisLength() {
  return state.normalizedText.length || state.text.length || 1;
}

function exportResultJson() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(buildAnalysisExportPackage(), null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${els.bookTitleInput.value || 'pipeline-result'}.pipeline-analysis.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildAnalysisExportPackage() {
  if (!state.result) throw new Error('没有可导出的 pipeline result');
  const normalizedText = normalizeNewlines(state.normalizedText || state.text || state.rawText || '');
  const summary = getPipelineSummary();
  return {
    schema_version: ANALYSIS_EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    source: 'frontend_demo',
    job: {
      ...(state.jobMeta || {}),
      job_id: state.jobId || state.jobMeta?.job_id || state.result?.job_id || null,
    },
    input: {
      file_name: state.fileName || '',
      book_title: els.bookTitleInput.value.trim() || state.result?.book_title || '',
      normalized_text: normalizedText,
      normalized_text_chars: normalizedText.length,
      normalized_line_count: normalizedText ? splitLinesKeepingEmpty(normalizedText).length : 0,
    },
    coordinate_systems: buildCoordinateSystemsMetadata(),
    analysis_summary: {
      chapter_count: summary.chapterCount,
      chunk_count: summary.chunkCount,
      span_count: summary.spanCount,
      primary_span_count: summary.primarySpanCount,
      recovered_span_count: summary.recoveredSpanCount,
      grounded_count: summary.groundedCount,
      unresolved_count: summary.unresolvedCount,
      quote_candidate_count: summary.quoteCandidateCount,
      missed_quote_count: summary.missedQuoteCount,
      tts_segment_count: summary.ttsSegmentCount,
      tts_narration_segment_count: summary.ttsNarrationSegmentCount,
      tts_dialogue_segment_count: summary.ttsDialogueSegmentCount,
      tts_skipped_span_count: summary.ttsSkippedSpanCount,
      tts_coverage_ok: summary.ttsCoverageOk,
    },
    result: state.result,
    logs: state.jobLogs || [],
    error: state.jobError || null,
  };
}

function buildCoordinateSystemsMetadata() {
  return {
    normalized_text: 'input.normalized_text，前端统一换行后的分析文本。所有 display_* 坐标均以此文本为可视化基准。',
    cleaned_chapter_text: '后端对单章正文执行 cleanChapterText 后的文本；chunk.text、chunk.clean_start/clean_end、span.clean_start/clean_end 基于该清洗后章节正文。',
    result_coordinate_basis: state.result?.frontend_coordinate_basis || 'unknown',
    fields: {
      'chapter.source_start/source_end': '后端拆章后的章节正文在 cleanBeforeChapterSplit 文本中的原始坐标；仅前端重映射后存在。',
      'chapter.start/end': '当前前端展示坐标；导出时通常等同于 chapter.display_body_start/display_body_end。',
      'chapter.display_title_start/display_title_end': '章节标题在 input.normalized_text 中的展示坐标。',
      'chapter.display_body_start/display_body_end': '章节正文在 input.normalized_text 中的展示坐标。',
      'chunk.clean_start/clean_end': 'chunk 在 cleaned_chapter_text 中的坐标。',
      'chunk.display_start/display_end': 'chunk 在 input.normalized_text 中的展示坐标。',
      'chunk.start/end': '当前前端展示坐标；导出时通常等同于 chunk.display_start/display_end。',
      'span.clean_start/clean_end': 'span 在 cleaned_chapter_text 中的坐标。',
      'span.display_start/display_end': 'span 在 input.normalized_text 中的展示坐标。',
      'span.start/end': '当前前端展示坐标；导出时通常等同于 span.display_start/display_end。',
      'tts_segment.display_start/display_end': 'TTS segment 在 input.normalized_text 中的展示坐标。',
      'tts_segment.start/end': '当前前端展示坐标；导出时通常等同于 tts_segment.display_start/display_end。',
    },
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatConfidence(value) {
  if (value === undefined || value === null || value === '') return '-';
  const number = Number(value);
  if (Number.isNaN(number)) return escapeHtml(String(value));
  return `${Math.round(number * 100)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

init();
