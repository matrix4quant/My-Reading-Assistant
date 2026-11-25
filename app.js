/* ==================== 阅读助手 · 渲染进程逻辑 ==================== */
const BR = window.bridge;
const $ = (id) => document.getElementById(id);

let currentBook = null;      // 当前打开的书（含 chapters）
let chapterIdx = 0;          // 当前章
let sentences = [];          // 当前章分句
let idx = 0;                 // 当前句
let rate = 1, volume = 1, chosenVoice = null, voices = [];
let playing = false, paused = false, speakToken = 0, utter = null;
let saveTimer = null;

// 书签与笔记
let annotations = [];            // {id,type:'bookmark'|'note',chapter,sentence,quote,text,createdAt}
let ctxTarget = -1;              // 右键目标句索引
let noteEditingId = null;        // 正在编辑的笔记 id
let annSaveTimer = null;

// 双引擎状态
let engine = 'online';                 // 'online' | 'local'
let onlineVoices = [];                 // 在线音色列表
let onlineVoice = 'zh-CN-XiaoxiaoNeural';
let audioEl = null;                    // 在线模式播放用的 Audio
let currentMarks = [];                 // 当前句逐词时间戳
let markTimer = null;                  // 时间戳高亮定时器
let onlineDowngraded = false;          // 本次会话是否已因失败降级
const PREFETCH_AHEAD = 3;              // 提前预取后续句子数（扩大缓冲窗口，消除句间停顿）
const prefetchedKeys = new Set();      // 已发起预取的 key，避免重复 IPC

// 全文搜索
let searchNavStack = [];         // 搜索跳转前的位置栈 {chapter, sentence}
let searchActiveQuery = '';      // 当前用于高亮的关键词
let searchHits = [];             // 当前搜索结果 [{chapter,sentence,text}]
let searchSel = -1;              // 结果列表中选中项
let searchChapterCache = new Map(); // 章节分句缓存（按书 id）
let searchTimer = null;

// 图表段落：正文里用 [[BRIMG|路径|说明]] 占位，朗读时自动跳过
const IMG_RE = /^\[\[BRIMG\|([^\]]+)\]\]$/;
const imageUrlCache = new Map();
const imgSizeCache = new Map();   // 图片自然尺寸（按 bookId|rel），用于重绘时预留高度，避免布局抖动
let imgScrollTimer = null;
function imgSentinel(rel, alt) {
  return '[[BRIMG|' + encodeURIComponent(rel) + '|' + encodeURIComponent(alt || '') + ']]';
}
function parseImgSentinel(s) {
  const m = String(s).match(IMG_RE);
  if (!m) return null;
  const parts = m[1].split('|');
  return { type: 'img', src: decodeURIComponent(parts[0] || ''), alt: decodeURIComponent(parts[1] || '') };
}
function segText(seg) {
  if (!seg) return '';
  return seg.type === 'img' ? (seg.alt || '［书中图表］') : (seg.text || '');
}
async function getImageUrl(rel) {
  if (!currentBook || !rel) return '';
  const key = currentBook.id + '|' + rel;
  if (imageUrlCache.has(key)) return imageUrlCache.get(key);
  try {
    const url = await BR.imageUrl(currentBook.id, rel);
    imageUrlCache.set(key, url);
    return url;
  } catch (e) { return ''; }
}

/* ---------- 在线语音（Edge TTS + Audio 播放 + 时间戳高亮） ---------- */
function ensureAudio() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.onended = () => {
    if (!playing || paused) return;
    if (idx < sentences.length - 1) { idx++; speakFrom(idx); }
    else advanceChapter();
  };
  audioEl.onerror = () => {
    if (!playing || paused) return;
    $('status').textContent = '在线语音播放失败，正在切换系统语音…';
    fallbackToLocal();
  };
  return audioEl;
}
function b64ToBlobUrl(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'audio/mpeg' });
  return URL.createObjectURL(blob);
}
function startMarkHighlight(tokens, baseToken) {
  clearInterval(markTimer);
  markTimer = setInterval(() => {
    if (tokens !== speakToken || baseToken !== speakToken || !audioEl) return;
    const t = audioEl.currentTime * 1000;
    let pos = 0;
    for (const m of currentMarks) {
      if (t >= m.start) {
        const c = sentences[idx];
        const p = c.indexOf(m.part);
        if (p >= 0) pos = p + m.part.length;
      } else break;
    }
    highlightInSentence(pos);
  }, 50);
}
// 提前预取后续若干句：合成结果一返回就启动，不等当前句开始播放，
// 这样网络耗时被当前句的播放时长完全覆盖，切句时不再等待。
function prefetchNext(fromIdx) {
  if (engine !== 'online' || onlineDowngraded || !sentences.length) return;
  let queued = 0;
  for (let j = Math.max(0, fromIdx); j < sentences.length && queued < PREFETCH_AHEAD; j++) {
    const seg = sentences[j];
    if (!seg || seg.type === 'img') continue;
    const text = segText(seg);
    if (!text) continue;
    const key = onlineVoice + '|' + rate + '|' + text;
    if (prefetchedKeys.has(key)) continue;
    prefetchedKeys.add(key);
    queued++;
    BR.ttsPrefetch({ text, voice: onlineVoice, rate }).catch(() => {});
  }
}
async function speakOnline(i) {
  const token = ++speakToken;
  idx = i;
  render();
  $('status').textContent = '正在合成语音…';
  try {
    const res = await BR.ttsSynth({ text: segText(sentences[idx]), voice: onlineVoice, rate });
    // 合成期间可能已暂停/停止/切书，不能让迟到的音频重新响起来
    if (token !== speakToken || !playing || paused) return;
    // 合成一完成就立刻预取后续句子，把网络等待藏在当前句的播放时间里
    prefetchNext(idx + 1);
    currentMarks = res.marks || [];
    const a = ensureAudio();
    if (audioEl._url) URL.revokeObjectURL(audioEl._url);
    audioEl._url = b64ToBlobUrl(res.audio);
    a.src = audioEl._url;
    a.volume = volume;
    a.onended = () => {
      if (token !== speakToken || !playing || paused) return;
      clearInterval(markTimer);
      if (idx < sentences.length - 1) {
        idx++; speakFrom(idx);
      } else {
        advanceChapter();
      }
    };
    a.onerror = () => {
      if (token !== speakToken || !playing || paused) return;
      clearInterval(markTimer);
      $('status').textContent = '在线语音出错，切换系统语音…';
      fallbackToLocal();
    };
    try { await a.play(); }
    catch (e) { if (token !== speakToken || !playing || paused) return; throw e; }
    // play() 的 Promise 期间状态仍可能变化，落地时再校验一次
    if (token !== speakToken || !playing || paused) { try { a.pause(); } catch (e) {} return; }
    $('status').textContent = '朗读中（在线）';
    startMarkHighlight(token, token);
    updateButtons();
  } catch (e) {
    if (token !== speakToken) return;
    $('status').textContent = '在线合成失败，切换系统语音…';
    fallbackToLocal();
  }
}
function fallbackToLocal() {
  clearInterval(markTimer);
  if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  if (!onlineDowngraded) {
    onlineDowngraded = true;
    toast('在线语音不可用，已自动切换到系统语音');
  }
  engine = 'local';
  $('engineSel').value = 'local';
  refreshVoiceOptions();
  speakLocal(idx);
  // 暂停时切换引擎：保持暂停状态，恢复播放时才能继续
  if (paused) {
    try { window.speechSynthesis.pause(); } catch (e) {}
    $('status').textContent = '已暂停（已切换系统语音）';
  }
}
function advanceChapter() {
  if (!playing) return;
  if (chapterIdx < currentBook.chapters.length - 1) {
    loadChapter(chapterIdx + 1, 0);
    if (playing) speakFrom(0);
  } else {
    playing = false; paused = false; updateButtons();
    $('status').textContent = '全书朗读完毕';
    toast('全书朗读完毕');
  }
}

/* ---------- 通用工具 ---------- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function busy(on, text, sub) {
  $('overlay').classList.toggle('show', on);
  if (text) $('overlayText').textContent = text;
  if (sub !== undefined) $('overlaySub').textContent = sub;
}
function hasTextSelection() {
  const s = window.getSelection();
  return !!(s && s.toString().trim());
}
function selectedText() {
  const s = window.getSelection();
  return s ? s.toString().trim() : '';
}
async function copyToClipboard(text) {
  if (!text) { toast('没有可复制的文字'); return false; }
  try {
    await BR.copyText(text);
    toast('已复制 ' + text.length + ' 个字');
    return true;
  } catch (e) {
    toast('复制失败：' + (e && e.message ? e.message : '未知错误'));
    return false;
  }
}
/* ---------- 图表大图：滚轮缩放 / 拖动平移 ---------- */
const LB_MIN = 0.5, LB_MAX = 8;
let lbZoom = 1, lbPanX = 0, lbPanY = 0;
let lbDragging = false, lbDragX = 0, lbDragY = 0, lbPanX0 = 0, lbPanY0 = 0;

function lbApply() {
  const img = $('lightboxImg');
  img.style.transform = 'translate(' + lbPanX + 'px,' + lbPanY + 'px) scale(' + lbZoom + ')';
  $('lbZoomLabel').textContent = Math.round(lbZoom * 100) + '%';
}
function lbReset() {
  lbZoom = 1; lbPanX = 0; lbPanY = 0; lbApply();
}
function lbSetZoom(next, cx, cy) {
  next = Math.max(LB_MIN, Math.min(LB_MAX, next));
  const img = $('lightboxImg');
  const rect = img.getBoundingClientRect();
  const factor = next / lbZoom;
  if (cx === undefined) {
    lbPanX *= factor; lbPanY *= factor;
  } else {
    // 让鼠标指向的图片位置在缩放前后保持不动
    lbPanX -= (cx - (rect.left + rect.right) / 2) * (factor - 1);
    lbPanY -= (cy - (rect.top + rect.bottom) / 2) * (factor - 1);
  }
  lbZoom = next;
  lbApply();
}
function openLightbox(rel, alt) {
  const lb = $('lightbox');
  const img = $('lightboxImg');
  $('lightboxCap').textContent = alt || '书中图表';
  img.alt = alt || '书中图表';
  img.removeAttribute('src');
  lbReset();
  lb.hidden = false;
  getImageUrl(rel).then(url => { if (!lb.hidden && url) img.src = url; });
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
  lbDragging = false;
  $('lbStage').classList.remove('dragging');
  lbReset();
}
function cleanText(t) {
  return t
    .replace(/=====\s*PDF_PAGE\s*\d+\s*=====/g, '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, ''))
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\r/g, '')
    .trim();
}
function splitSentences(raw) {
  const clean = cleanText(raw);
  const paras = clean.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  paras.forEach(p => {
    const im = p.match(IMG_RE);
    if (im) {
      const seg = parseImgSentinel(p);
      if (seg) out.push(seg);
      return;
    }
    const ss = p.match(/[^。！？!?；;…]+[。！？!?；;…]?/g) || [p];
    ss.forEach(s => { s = s.trim(); if (s) out.push({ type: 'text', text: s }); });
  });
  return out;
}
function nextSpeakable(i) {
  let j = Math.max(0, i);
  while (j < sentences.length && sentences[j] && sentences[j].type === 'img') j++;
  return j;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function hashColor(str) {
  const palette = [
    ['#8C3A2B','#5E241B'], ['#2F5D62','#1C3B40'], ['#6B4A7A','#422E4D'],
    ['#4A6B3A','#2D4422'], ['#8A6A2F','#58431C'], ['#3A5A8C','#243A5E'],
    ['#7A3A4E','#4E2331'], ['#33706B','#1E4845']
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

/* ---------- 书籍解析 ---------- */
async function parseTxt(name, b64) {
  const bytes = b64ToBytes(b64);
  let text;
  try { text = new TextDecoder('utf-8').decode(bytes); }
  catch (e) { text = new TextDecoder('gbk').decode(bytes); }
  // 尝试按大标题分章
  const lines = text.split(/\n/);
  const chapters = [];
  let cur = { title: '正文', text: '' };
  let headRe = /^(第[一二三四五六七八九十百千零〇\d]+[章节回篇卷部].{0,40}|Chapter\s*\d+.{0,40}|卷[一二三四五六七八九十].{0,40})$/i;
  lines.forEach(line => {
    const t = line.trim();
    if (t && headRe.test(t) && t.length <= 45) {
      if (cur.text.trim()) chapters.push(cur);
      cur = { title: t, text: '' };
    } else {
      cur.text += line + '\n';
    }
  });
  if (cur.text.trim()) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: '正文', text });
  return { title: name, author: '', chapters };
}

function decodeHtmlAttr(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function normalizeZipPath(chapterFile, src) {
  let s = decodeHtmlAttr(src).split(/[?#]/)[0].trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch (e) {}
  if (/^[a-z]+:/i.test(s)) return null;
  const base = chapterFile.includes('/') ? chapterFile.slice(0, chapterFile.lastIndexOf('/') + 1) : '';
  const parts = base.split('/').filter(Boolean);
  s.split('/').forEach(seg => {
    if (!seg || seg === '.') return;
    if (seg === '..') { if (parts.length) parts.pop(); }
    else parts.push(seg);
  });
  return parts.join('/') || null;
}

async function parseEpub(name, b64) {
  const zip = await JSZip.loadAsync(b64, { base64: true });
  const files = Object.keys(zip.files);
  // 找 OPF
  let opfName = null;
  const container = files.find(f => /META-INF\/container\.xml$/i.test(f));
  if (container) {
    const cx = await zip.file(container).async('string');
    const m = cx.match(/full-path=["']([^"']+\.opf)["']/i);
    if (m) opfName = m[1];
  }
  if (!opfName) opfName = files.find(f => /\.opf$/i.test(f));
  if (!opfName) throw new Error('未找到 EPUB 结构文件');

  const opf = await zip.file(opfName).async('string');
  const baseDir = opfName.includes('/') ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';
  // 元数据
  const getMeta = (tag) => {
    const m = opf.match(new RegExp('<dc:' + tag + '[^>]*>([\\s\\S]*?)</dc:' + tag + '>', 'i'));
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };
  const title = getMeta('title') || name;
  const author = getMeta('creator') || '';
  // manifest: id -> href
  const idmap = {};
  const manifestRe = /<item\b[^>]*\bid=["']([^"']+)["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let mm;
  while ((mm = manifestRe.exec(opf))) idmap[mm[1]] = mm[2];
  // 兼容 href 在 id 前的写法
  const manifestRe2 = /<item\b[^>]*\bhref=["']([^"']+)["'][^>]*\bid=["']([^"']+)["'][^>]*>/gi;
  while ((mm = manifestRe2.exec(opf))) idmap[mm[2]] = mm[1];
  // spine 顺序
  const spine = [];
  const spineRe = /<itemref\b[^>]*\bidref=["']([^"']+)["']/gi;
  while ((mm = spineRe.exec(opf))) {
    const href = idmap[mm[1]];
    if (href) spine.push(baseDir + href.replace(/^\.\//, ''));
  }
  const ordered = spine.length ? spine : files.filter(f => /\.(x?html|htm)$/i.test(f)).sort();

  const chapters = [];
  const imageRefs = new Set();
  const replaceImgTag = (tag, chapterFile) => {
    const sm = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
            || tag.match(/\bxlink:href\s*=\s*["']([^"']+)["']/i);
    if (!sm) return '';
    const rel = normalizeZipPath(chapterFile, sm[1]);
    if (!rel || !zip.file(rel)) return '';
    const am = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    imageRefs.add(rel);
    return '\n' + imgSentinel(rel, am ? am[1] : '') + '\n';
  };
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    if (!zip.file(f)) continue;
    let html = await zip.file(f).async('string');
    html = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    // 图表占位：保留在原正文位置，图片本体稍后写到书籍库
    html = html.replace(/<img\b[^>]*>/gi, tag => replaceImgTag(tag, f))
               .replace(/<image\b[^>]*>/gi, tag => replaceImgTag(tag, f));
    // 提取标题
    let chTitle = '';
    const ht = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
    if (ht) chTitle = ht[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    // 段落文本
    html = html.replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n');
    html = html.replace(/<br\s*\/?>/gi, '\n');
    let text = html.replace(/<[^>]+>/g, '');
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
               .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    chapters.push({ title: chTitle || ('第 ' + (chapters.length + 1) + ' 节'), text });
  }
  if (!chapters.length) throw new Error('未能提取 EPUB 正文');
  return { title, author, chapters, imageRefs: Array.from(imageRefs) };
}

async function parsePdf(name, b64, sourcePath, bookId, extractImages) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF 组件未加载');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'node_modules/pdfjs-dist/build/pdf.worker.js';
  const data = b64ToBytes(b64);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const chapters = [];
  let pageMap = {};
  if (extractImages && sourcePath && bookId) {
    try {
      const r = await BR.extractPdfImages(bookId, sourcePath);
      pageMap = r.pageMap || {};
    } catch (e) { console.warn('PDF 图表提取失败', e); }
  }
  let buf = '', pageStart = 1;
  // 每 ~60 页合成一节，避免章节过碎
  const per = 60;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let line = '', lastY = null;
    tc.items.forEach(it => {
      if (lastY !== null && Math.abs(it.transform[5] - lastY) > 4) { buf += line + '\n'; line = ''; }
      line += it.str;
      lastY = it.transform[5];
    });
    if (line) buf += line + '\n';
    if (pageMap[p] && pageMap[p].length) {
      buf += '\n' + pageMap[p].map(rel => imgSentinel(rel, '')).join('\n') + '\n';
    }
    if (p % per === 0 || p === pdf.numPages) {
      if (buf.trim()) chapters.push({ title: '第 ' + pageStart + '–' + p + ' 页', text: buf });
      buf = ''; pageStart = p + 1;
    }
  }
  if (!chapters.length) throw new Error('未能提取 PDF 文字（可能是扫描版）');
  const imageCount = Object.values(pageMap).reduce((a, v) => a + v.length, 0);
  return { title: name, author: '', chapters, imageCount };
}

/* ---------- 首页在线书库 ---------- */
const DEFAULT_WEBLIB = [
  { id: 'gutenberg', name: '古登堡计划', url: 'https://www.gutenberg.org/', icon: '📖', meta: '公有领域经典 · 合法免费' },
  { id: 'openlibrary', name: 'Open Library', url: 'https://openlibrary.org/', icon: '📚', meta: '开放图书馆 · 可借阅' },
  { id: 'archive', name: 'Internet Archive', url: 'https://archive.org/details/books', icon: '🏛️', meta: '互联网档案馆' },
  { id: 'cnlib', name: '国家数字图书馆', url: 'https://www.nlc.cn/', icon: '🇨🇳', meta: '中国国家图书馆' }
];
let webLibCfg = { sites: [], domains: {} };
let webLibEditId = null;

function allWebLibSites() {
  const custom = (webLibCfg.sites || []).filter(s => s && s.url);
  const z = (webLibCfg.domains || {}).zlibrary;
  const zSite = {
    id: '__zlibrary', name: 'Z-Library', icon: '🌐',
    url: z ? z.url : 'https://z-library.sk/',
    meta: z ? ('官方域名 · 更新于 ' + new Date(z.updatedAt).toLocaleDateString('zh-CN')) : '官方域名 · 待更新',
    builtin: true
  };
  return [zSite, ...DEFAULT_WEBLIB.map(s => ({ ...s, builtin: true })), ...custom];
}
function renderWebLib() {
  const grid = $('weblibGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const s of allWebLibSites()) {
    const card = document.createElement('div');
    card.className = 'weblib-card';
    card.title = s.url;
    const icon = document.createElement('div');
    icon.className = 'wl-icon'; icon.textContent = s.icon || '🌐';
    const top = document.createElement('div'); top.className = 'wl-top';
    const info = document.createElement('div');
    const name = document.createElement('div'); name.className = 'wl-name'; name.textContent = s.name;
    const url = document.createElement('div'); url.className = 'wl-url'; url.textContent = s.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    info.appendChild(name); info.appendChild(url);
    top.appendChild(icon); top.appendChild(info);
    card.appendChild(top);
    if (s.meta) {
      const meta = document.createElement('div'); meta.className = 'wl-meta'; meta.textContent = s.meta;
      card.appendChild(meta);
    }
    // Z-Library 不支持编辑域名（由 Wikipedia 自动更新），其余自定义项可编辑/删除
    if (!s.builtin) {
      const edit = document.createElement('button'); edit.className = 'wl-edit'; edit.textContent = '✎';
      edit.title = '编辑'; edit.addEventListener('click', e => { e.stopPropagation(); openWebLibModal(s.id); });
      const del = document.createElement('button'); del.className = 'wl-del'; del.textContent = '×';
      del.title = '删除'; del.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm('删除书库「' + s.name + '」？')) return;
        webLibCfg.sites = (webLibCfg.sites || []).filter(x => x.id !== s.id);
        BR.weblibSave(webLibCfg); renderWebLib(); toast('已删除');
      });
      card.appendChild(edit); card.appendChild(del);
    }
    card.addEventListener('click', async () => {
      const res = await BR.openExternal(s.url);
      if (!res || !res.ok) toast('打开失败：' + ((res && res.error) || '未知错误'));
    });
    grid.appendChild(card);
  }
}
async function initWebLib() {
  try { webLibCfg = await BR.weblibLoad() || { sites: [], domains: {} }; }
  catch (e) { webLibCfg = { sites: [], domains: {} }; }
  webLibCfg.sites = webLibCfg.sites || [];
  webLibCfg.domains = webLibCfg.domains || {};
  renderWebLib();
  // 启动时静默更新一次域名
  refreshWebLibDomain(true);
}
async function refreshWebLibDomain(silent) {
  const btn = $('btnWeblibRefresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 更新中'; }
  try {
    const res = await BR.weblibResolveDomain();
    if (res && res.ok) {
      webLibCfg.domains = webLibCfg.domains || {};
      webLibCfg.domains.zlibrary = { url: res.url, candidates: res.candidates, updatedAt: res.updatedAt, source: res.source };
      BR.weblibSave(webLibCfg);
      renderWebLib();
      if (!silent) toast('官方域名已更新：' + res.url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    } else if (!silent) {
      toast('更新失败：' + ((res && res.error) || '网络不可用') + (res && res.cached ? '（继续使用缓存域名）' : ''));
    }
  } catch (e) { if (!silent) toast('更新失败：' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 更新域名'; }
}
function openWebLibModal(id) {
  webLibEditId = id || null;
  const site = id ? (webLibCfg.sites || []).find(s => s.id === id) : null;
  $('webLibModalTitle').textContent = site ? '编辑在线书库' : '添加在线书库';
  $('webLibName').value = site ? site.name : '';
  $('webLibUrl').value = site ? site.url : '';
  $('webLibIcon').value = site ? (site.icon || '') : '';
  $('webLibModal').hidden = false;
  $('webLibName').focus();
}
function closeWebLibModal() { $('webLibModal').hidden = true; webLibEditId = null; }
function saveWebLib() {
  const name = $('webLibName').value.trim();
  const url = $('webLibUrl').value.trim();
  if (!name || !url) { toast('请填写名称和网址'); return; }
  if (!/^https?:\/\//i.test(url)) { toast('网址需以 http:// 或 https:// 开头'); return; }
  webLibCfg.sites = webLibCfg.sites || [];
  const icon = $('webLibIcon').value.trim() || '🌐';
  if (webLibEditId) {
    const s = webLibCfg.sites.find(x => x.id === webLibEditId);
    if (s) { s.name = name; s.url = url; s.icon = icon; }
  } else {
    webLibCfg.sites.push({ id: 'wl_' + Date.now(), name, url, icon, meta: '自定义书库' });
  }
  BR.weblibSave(webLibCfg);
  closeWebLibModal();
  renderWebLib();
  toast('已保存');
}

/* ---------- 书架 ---------- */
async function renderShelf() {
  const list = await BR.listBooks();
  const shelf = $('shelf');
  if (!list.length) {
    shelf.innerHTML = '<div class="empty"><div class="big">📖</div><h2>书架还是空的</h2><div>点击右上角「＋ 导入书籍」，支持 TXT / MD / EPUB / PDF</div></div>';
    return;
  }
  shelf.innerHTML = '';
  list.forEach(b => {
    const [c1, c2] = hashColor(b.title);
    const card = document.createElement('div');
    card.className = 'book';
    const pct = b.totalChars ? Math.round(((b.progress?.chapter || 0) / Math.max(b.chapters.length, 1)) * 100) : 0;
    card.innerHTML = `
      <div class="cover" style="background:linear-gradient(145deg,${c1},${c2})">
        <button class="del" title="删除这本书">×</button>
        <div class="c-badge">${(b.ext || 'txt').toUpperCase()}</div>
        <div class="c-title">${escapeHtml(b.title)}</div>
      </div>
      <div class="book-meta">
        <div class="t">${escapeHtml(b.title)}</div>
        <div class="s">${b.chapters.length} 节 · ${(b.totalChars / 10000).toFixed(1)} 万字</div>
        <div class="pbar"><i style="width:${pct}%"></i></div>
      </div>`;
    card.addEventListener('dblclick', () => openBook(b.id));
    card.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('确定从书架移除《' + b.title + '》吗？')) {
        await BR.deleteBook(b.id); renderShelf(); toast('已移除');
      }
    });
    shelf.appendChild(card);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function importBooks() {
  const files = await BR.chooseFiles();
  if (!files.length) return;
  let ok = 0, fail = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    busy(true, '正在导入 ' + (fi + 1) + '/' + files.length, f.name);
    await new Promise(r => setTimeout(r, 30)); // 让 UI 刷新
    try {
      const id = 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      let parsed;
      if (f.ext === 'epub') parsed = await parseEpub(f.name, f.data);
      else if (f.ext === 'pdf') parsed = await parsePdf(f.name, f.data, f.path, id, true);
      else parsed = await parseTxt(f.name, f.data);
      if (!parsed.chapters.length) throw new Error('没有可朗读的内容');
      let hasImages = false;
      if (parsed.imageRefs && parsed.imageRefs.length) {
        busy(true, '正在导入 ' + (fi + 1) + '/' + files.length, '提取图表 ' + parsed.imageRefs.length + ' 张…');
        await BR.extractEpubImages(id, f.path, parsed.imageRefs);
        hasImages = true;
      }
      if (parsed.imageCount) hasImages = true;
      const book = {
        id,
        title: parsed.title || f.name,
        author: parsed.author || '',
        source: f.path,
        ext: f.ext,
        hasImages,
        addedAt: Date.now(),
        progress: { chapter: 0, sentence: 0 },
        chapters: parsed.chapters
      };
      await BR.saveBook(book);
      ok++;
    } catch (e) {
      fail.push(f.name + '：' + (e.message || '解析失败'));
    }
  }
  busy(false);
  await renderShelf();
  if (ok) toast('成功导入 ' + ok + ' 本');
  if (fail.length) alert('以下书籍导入失败：\n\n' + fail.join('\n'));
}

/* ---------- 打开书 & 朗读 ---------- */
async function openBook(id) {
  const book = await BR.loadBook(id);
  if (!book) { toast('书籍文件丢失'); return; }
  currentBook = book;
  // 进入书籍时彻底复位播放状态，避免上一次返回书架残留的“暂停”按钮
  resetPlayback();
  // 笔记侧栏默认收起，用顶栏「笔记」按钮展开
  $('noteSide').classList.add('collapsed');
  prefetchedKeys.clear();
  // 切换书籍时清空搜索状态
  searchChapterCache.clear(); imgSizeCache.clear(); searchNavStack = []; searchHits = []; searchSel = -1;
  searchActiveQuery = ''; $('searchInput').value = ''; $('searchCount').textContent = '';
  $('searchResults').hidden = true; $('btnSearchClear').hidden = true; $('btnSearchBack').hidden = true;
  annotations = Array.isArray(book.annotations) ? book.annotations : [];
  chapterIdx = book.progress?.chapter || 0;
  if (chapterIdx >= book.chapters.length) chapterIdx = 0;
  const savedSentence = book.progress?.sentence || 0;

  // 旧版导入的书没有图表，首次打开时从源文件补齐（保留进度与笔记）
  if (!book.hasImages && book.source && (book.ext === 'epub' || book.ext === 'pdf')) {
    busy(true, '正在为这本书补充图表', '首次打开需要重新解析源文件，请稍候…');
    await new Promise(r => setTimeout(r, 30));
    try {
      const raw = await BR.readSource(book.source);
      let parsed = null;
      if (book.ext === 'epub') {
        parsed = await parseEpub(book.title, raw);
        if (parsed.imageRefs && parsed.imageRefs.length) {
          await BR.extractEpubImages(book.id, book.source, parsed.imageRefs);
        }
      } else {
        parsed = await parsePdf(book.title, raw, book.source, book.id, true);
      }
      const added = (parsed?.imageRefs?.length || 0) + (parsed?.imageCount || 0);
      if (parsed && added) {
        book.chapters = parsed.chapters;
        book.hasImages = true;
        book.annotations = annotations;
        await BR.saveBook(book);
        toast('已补充 ' + added + ' 张图表');
      }
    } catch (e) {
      toast('图表补充失败：' + (e.message || '未知错误'));
    }
    busy(false);
  }

  $('bookTitle').textContent = book.title;
  document.title = book.title + ' · ' + appDisplayName();
  showView('readerView');
  renderAnnotations();
  buildChapList();
  const freshBook = await BR.loadBook(id);
  if (freshBook && freshBook.chapters) {
    currentBook = freshBook;
    chapterIdx = Math.min(chapterIdx, freshBook.chapters.length - 1);
    buildChapList();
  }
  loadChapter(chapterIdx, savedSentence);
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

function buildChapList() {
  const box = $('chaplist');
  box.innerHTML = '';
  if (!currentBook) return;
  currentBook.chapters.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = i === chapterIdx ? 'on' : '';
    const num = document.createElement('span');
    num.textContent = (i + 1) + '. ';
    d.appendChild(num);
    d.appendChild(document.createTextNode(c.title));
    const hasBm = annotations.some(a => a.chapter === i && a.type === 'bookmark');
    const hasNt = annotations.some(a => a.chapter === i && a.type === 'note');
    if (hasBm || hasNt) {
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = (hasNt ? '✏️' : '') + (hasBm ? '🔖' : '');
      d.appendChild(mark);
    }
    d.title = c.title + (hasNt || hasBm ? '（有笔记／书签）' : '');
    d.addEventListener('click', () => { loadChapter(i, 0); });
    box.appendChild(d);
  });
  const on = box.querySelector('.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
  const done = annotations.length;
  $('tocFoot').textContent = '共 ' + currentBook.chapters.length + ' 节 · ' + done + ' 条书签笔记';
}

function loadChapter(ci, sentence) {
  stopSpeech();
  chapterIdx = Math.max(0, Math.min(ci, currentBook.chapters.length - 1));
  const ch = currentBook.chapters[chapterIdx];
  sentences = splitSentences(ch.text);
  idx = Math.max(0, Math.min(sentence || 0, sentences.length - 1));
  $('chapterBadge').textContent = '第 ' + (chapterIdx + 1) + ' / ' + currentBook.chapters.length + ' 节';
  buildChapList();
  render();
  saveProgress();
}

// 只滚动正文容器本身，不用 scrollIntoView（后者会连带滚动外层并受懒加载图片影响）
function scrollActiveIntoView(smooth) {
  const box = $('text');
  const el = box.querySelector('.sentence.active');
  if (!el) return;
  // 用相对矩形差计算，不依赖 offsetParent，图片撑高布局后也能精确落位
  const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const target = box.scrollTop + delta - box.clientHeight * 0.34;
  box.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}
// 图片加载完成后布局会变高，重新校准当前句位置，避免停在屏幕偏下方
function scheduleImageScrollFix() {
  clearTimeout(imgScrollTimer);
  imgScrollTimer = setTimeout(() => {
    if ($('autoScroll').checked) scrollActiveIntoView(false);
  }, 80);
}

function render() {
  const focus = $('focusMode').checked;
  const box = $('text');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'chapter-title';
  title.textContent = currentBook.chapters[chapterIdx].title;
  box.appendChild(title);
  const frag = document.createDocumentFragment();
  sentences.forEach((seg, i) => {
    const d = document.createElement('div');
    const hasBm = annotations.some(a => a.chapter === chapterIdx && a.sentence === i && a.type === 'bookmark');
    const hasNt = annotations.some(a => a.chapter === chapterIdx && a.sentence === i && a.type === 'note');
    d.className = 'sentence' + (seg.type === 'img' ? ' image-seg' : '') + (i === idx ? ' active' : '') + (i < idx ? ' read' : '')
      + (hasBm ? ' has-bookmark' : '') + (hasNt ? ' has-note' : '');
    d.dataset.i = i;
    if (seg.type === 'img') {
      const frame = document.createElement('div');
      frame.className = 'img-frame';
      const img = document.createElement('img');
      img.alt = seg.alt || '书中图表';
      img.loading = 'lazy';
      // 已知尺寸时预留空间，避免每次重绘都先塌陷再撑开造成滚动定位漂移
      const size = imgSizeCache.get(seg.src);
      if (size) {
        img.width = size.w; img.height = size.h;
        img.style.aspectRatio = size.w + ' / ' + size.h;
      }
      img.addEventListener('load', () => {
        if (img.naturalWidth && img.naturalHeight && !imgSizeCache.has(seg.src)) {
          imgSizeCache.set(seg.src, { w: img.naturalWidth, h: img.naturalHeight });
        }
        if (img.closest('.sentence.active') || img.compareDocumentPosition(
              box.querySelector('.sentence.active') || img) & Node.DOCUMENT_POSITION_FOLLOWING) {
          scheduleImageScrollFix();
        }
      });
      getImageUrl(seg.src).then(url => { if (img.isConnected && url) img.src = url; });
      frame.appendChild(img);
      if (seg.alt) {
        const cap = document.createElement('div');
        cap.className = 'img-cap';
        cap.textContent = seg.alt;
        frame.appendChild(cap);
      }
      d.appendChild(frame);
      d.title = '点击查看大图';
      d.addEventListener('click', e => { e.stopPropagation(); openLightbox(seg.src, seg.alt); });
    } else {
      if (searchActiveQuery && seg.text) appendHitText(d, seg.text, searchActiveQuery);
      else d.textContent = seg.text;
      // 左键点击不再跳转播放：朗读中不打断当前句；暂停/停止时仅定位，不自动播放。
      // 需要从此句朗读请用右键菜单「▶ 从这里开始朗读」。
      d.addEventListener('click', () => {
        if (hasTextSelection() || (playing && !paused)) return;
        goto(i, false);
      });
    }
    if (focus && Math.abs(i - idx) > 1) d.classList.add('focus-hide');
    d.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, i); });
    frag.appendChild(d);
  });
  box.appendChild(frag);
  updateCounter();
  if ($('autoScroll').checked && sentences[idx]) scrollActiveIntoView(true);
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
           : String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function updateCounter() {
  const total = sentences.length;
  const cur = total ? idx + 1 : 0;
  const chapTotal = currentBook ? currentBook.chapters.length : 0;
  $('chapterBadge').textContent = '第 ' + (chapterIdx + 1) + ' / ' + chapTotal + ' 节';
  $('sentenceProgress').textContent = '第 ' + cur + ' / ' + total + ' 句';
  $('chapterProgress').textContent = '本章 ' + (chapterIdx + 1) + ' / ' + chapTotal;
  const chapterPct = total ? cur / total : 0;
  const globalPct = chapTotal ? (chapterIdx + chapterPct) / chapTotal * 100 : 0;
  $('bookProgress').textContent = '全书 ' + Math.round(globalPct) + '%';
  $('topProgress').style.width = globalPct + '%';
  // 底部时间轴：按字数×语速估算朗读时间
  const tl = $('timeline');
  tl.max = Math.max(total - 1, 0);
  tl.value = Math.max(0, idx);
  const charsBefore = sentences.slice(0, idx).reduce((a, s) => a + (s.type === 'text' ? s.text.length : 0), 0);
  const charsAll = sentences.reduce((a, s) => a + (s.type === 'text' ? s.text.length : 0), 0);
  const cps = 240 * rate / 60; // 约每分钟 240 字
  $('tlCur').textContent = formatTime(charsBefore / cps);
  $('tlTotal').textContent = formatTime(charsAll / cps);
}
function goto(i, autoplay) {
  if (!sentences.length) return;
  i = Math.max(0, Math.min(i, sentences.length - 1));
  idx = i;
  if (autoplay) { playing = true; paused = false; speakFrom(idx); }
  else { resetPlayback(); render(); saveProgress(); }
}

/* ---------- 全文搜索 ---------- */
function chapterSegments(ci) {
  if (!currentBook) return [];
  const key = currentBook.id + '|' + ci;
  if (searchChapterCache.has(key)) return searchChapterCache.get(key);
  const segs = splitSentences(currentBook.chapters[ci].text || '');
  searchChapterCache.set(key, segs);
  return segs;
}
function searchSnippet(text, query) {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, i - 18);
  const end = Math.min(text.length, i + query.length + 42);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
function appendHitText(el, text, query) {
  const needle = query.toLowerCase(), lower = text.toLowerCase();
  let p = 0, k, last = 0;
  const frag = document.createDocumentFragment();
  while ((k = lower.indexOf(needle, last)) >= 0) {
    frag.appendChild(document.createTextNode(text.slice(p, k)));
    const m = document.createElement('mark');
    m.className = 'search-hit';
    m.textContent = text.slice(k, k + query.length);
    frag.appendChild(m);
    p = k + query.length; last = p;
  }
  frag.appendChild(document.createTextNode(text.slice(p)));
  el.appendChild(frag);
}
function renderSearchResults() {
  const box = $('searchResults');
  box.innerHTML = '';
  if (!searchHits.length) {
    const d = document.createElement('div');
    d.className = 'search-empty';
    d.textContent = '未找到包含「' + $('searchInput').value.trim() + '」的内容';
    box.appendChild(d);
  } else {
    searchHits.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'search-result' + (i === searchSel ? ' on' : '');
      const loc = document.createElement('span');
      loc.className = 'sr-loc';
      loc.textContent = '第 ' + (r.chapter + 1) + ' 节 · ' + (currentBook.chapters[r.chapter].title || '') + ' · 第 ' + (r.sentence + 1) + ' 句';
      d.appendChild(loc);
      const tx = document.createElement('span');
      tx.className = 'sr-text';
      appendHitText(tx, searchSnippet(r.text, r.query), r.query);
      d.appendChild(tx);
      d.addEventListener('click', () => jumpToSearchHit(r));
      box.appendChild(d);
    });
  }
  box.hidden = false;
}
function runSearch(value, jumpFirst) {
  const q = String(value || '').trim();
  $('btnSearchClear').hidden = !q;
  if (!q || !currentBook) {
    searchHits = []; searchSel = -1;
    $('searchCount').textContent = '';
    $('searchResults').hidden = true;
    $('searchResults').innerHTML = '';
    return;
  }
  const needle = q.toLowerCase();
  searchHits = [];
  const MAX = 500;
  outer:
  for (let ci = 0; ci < currentBook.chapters.length; ci++) {
    const segs = chapterSegments(ci);
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (!seg || seg.type !== 'text') continue;
      if ((seg.text || '').toLowerCase().indexOf(needle) >= 0) {
        searchHits.push({ chapter: ci, sentence: si, text: seg.text, query: q });
        if (searchHits.length >= MAX) break outer;
      }
    }
  }
  $('searchCount').textContent = searchHits.length ? (searchHits.length >= MAX ? MAX + '+' : searchHits.length) + ' 条' : '未找到';
  searchSel = searchHits.length ? 0 : -1;
  renderSearchResults();
  if (jumpFirst && searchHits.length) jumpToSearchHit(searchHits[0]);
}
function updateBackButton() {
  $('btnSearchBack').hidden = searchNavStack.length === 0;
  const p = searchNavStack[searchNavStack.length - 1];
  $('btnSearchBack').title = p
    ? '返回搜索跳转前的位置：第 ' + (p.chapter + 1) + ' 节 · 第 ' + (p.sentence + 1) + ' 句'
    : '返回搜索跳转前的位置';
}
function jumpToSearchHit(r) {
  if (!currentBook || !r || r.chapter >= currentBook.chapters.length) return;
  // 连续点击不同结果时逐级记录跳转前位置；重复点同一条不重复入栈
  if (r.chapter !== chapterIdx || r.sentence !== idx) {
    searchNavStack.push({ chapter: chapterIdx, sentence: idx });
    updateBackButton();
  }
  playing = false; paused = false; updateButtons();
  $('status').textContent = '已跳转到搜索结果';
  searchActiveQuery = r.query;
  if (r.chapter !== chapterIdx) loadChapter(r.chapter, r.sentence);
  else goto(r.sentence, false);
  const el = $('text').querySelector('.sentence[data-i="' + r.sentence + '"]');
  if (el) {
    el.classList.add('search-target');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // 结果列表保持展开，可继续点击其他结果跳转；仅更新选中态，不重建 DOM
  searchSel = searchHits.indexOf(r);
  const box = $('searchResults');
  box.hidden = false;
  box.querySelectorAll('.search-result').forEach((node, i) => node.classList.toggle('on', i === searchSel));
  const on = box.querySelector('.search-result.on');
  if (on) {
    const a = on.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (a.top < b.top) box.scrollTop -= (b.top - a.top) + 4;
    else if (a.bottom > b.bottom) box.scrollTop += (a.bottom - b.bottom) + 4;
  }
}
function searchBack() {
  const p = searchNavStack.pop();
  if (!p) { toast('没有可返回的位置'); return; }
  searchActiveQuery = '';
  if (p.chapter !== chapterIdx) loadChapter(p.chapter, p.sentence);
  else goto(p.sentence, false);
  const el = $('text').querySelector('.sentence[data-i="' + p.sentence + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateBackButton();
  $('status').textContent = '已返回搜索前的位置';
}
function clearSearch() {
  $('searchInput').value = '';
  searchHits = []; searchSel = -1;
  $('searchCount').textContent = '';
  $('searchResults').hidden = true;
  $('btnSearchClear').hidden = true;
  if (searchActiveQuery) { searchActiveQuery = ''; render(); }
}
function highlightInSentence(pos) {
  const el = $('text').querySelector('.sentence.active');
  if (!el || !sentences[idx] || sentences[idx].type === 'img') return;
  // 用户正在选中文字时不要重写 DOM，否则选区会被清空
  const sel = window.getSelection();
  if (sel && sel.toString() && el.contains(sel.anchorNode)) return;
  const s = sentences[idx].text || '';
  const p = Math.max(0, Math.min(pos, s.length));
  el.innerHTML = '';
  if (p > 0) { const a = document.createElement('span'); a.textContent = s.slice(0, p); el.appendChild(a); }
  const c = document.createElement('span'); c.className = 'cur'; c.textContent = s.slice(p, p + 1) || ' '; el.appendChild(c);
  if (p + 1 < s.length) { const b = document.createElement('span'); b.textContent = s.slice(p + 1); el.appendChild(b); }
}
function speakFrom(i) {
  stopSpeech();
  i = nextSpeakable(i);
  if (i >= sentences.length) { advanceChapter(); return; }
  idx = i;
  if (engine === 'online' && !onlineDowngraded) speakOnline(i);
  else speakLocal(i);
}
function speakLocal(i) {
  const token = ++speakToken;
  idx = i;
  render();
  const s = segText(sentences[idx]);
  try {
    utter = new SpeechSynthesisUtterance(s);
  } catch (e) {
    playing = false; paused = false; updateButtons();
    $('status').textContent = '系统语音不可用';
    return;
  }
  utter.rate = rate; utter.volume = volume;
  if (chosenVoice) utter.voice = chosenVoice;
  utter.onboundary = (e) => {
    if (token !== speakToken) return;
    highlightInSentence(e.charIndex || 0);
  };
  utter.onend = () => {
    if (token !== speakToken || paused) return;
    if (idx < sentences.length - 1) { idx++; speakFrom(idx); }
    else advanceChapter();
  };
  utter.onerror = () => {
    if (token !== speakToken) return;
    if (playing) $('status').textContent = '语音引擎中断';
    playing = false; paused = false; updateButtons();
  };
  try { window.speechSynthesis.speak(utter); }
  catch (e) { $('status').textContent = '语音播放失败'; }
  $('status').textContent = '朗读中（系统语音）';
  updateButtons();
  saveProgress();
}
function stopSpeech() {
  speakToken++;
  clearInterval(markTimer);
  try { window.speechSynthesis.cancel(); } catch (e) {}
  if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  utter = null;
}
// 彻底复位播放状态：返回书架、停止、重新打开书籍时都必须调用，避免按钮文字与内部状态脱节
function resetPlayback(statusText) {
  stopSpeech();
  playing = false; paused = false;
  currentMarks = [];
  clearInterval(markTimer);
  if (audioEl) {
    try { audioEl.pause(); } catch (e) {}
    if (audioEl._url) { try { URL.revokeObjectURL(audioEl._url); } catch (e) {} audioEl._url = null; }
    try { audioEl.removeAttribute('src'); audioEl.load(); } catch (e) {}
  }
  updateButtons();
  if (statusText) $('status').textContent = statusText;
}
function hasLiveAudio() {
  return !!(audioEl && audioEl.src && !audioEl.ended && audioEl.currentTime > 0);
}
function pauseActiveAudio() {
  if (audioEl && audioEl.src && !audioEl.paused) {
    try { audioEl.pause(); } catch (e) {}
    return;
  }
  try { window.speechSynthesis.pause(); } catch (e) {}
}
function resumeActiveAudio() {
  if (hasLiveAudio()) {
    try { audioEl.play().catch(() => {}); } catch (e) {}
    return true;
  }
  try {
    const ss = window.speechSynthesis;
    if (ss.paused && (ss.speaking || ss.pending)) { ss.resume(); return true; }
  } catch (e) {}
  return false;
}
function updateButtons() {
  $('btnPlay').textContent = (playing && !paused) ? '⏸ 暂停' : '▶ 播放';
}
function togglePlay() {
  if (!sentences.length) { toast('这本书没有可朗读内容'); return; }
  const useOnline = engine === 'online' && !onlineDowngraded;
  if (playing && !paused) {
    pauseActiveAudio();
    paused = true; $('status').textContent = '已暂停';
  } else if (playing && paused) {
    // 先清 paused，再恢复/重启，避免异步合成路径误判为仍在暂停
    paused = false;
    if (!resumeActiveAudio()) speakFrom(idx);
    $('status').textContent = useOnline ? '朗读中（在线）' : '朗读中（系统语音）';
  } else {
    playing = true; paused = false; speakFrom(idx);
  }
  updateButtons();
}
function saveProgress() {
  if (!currentBook) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    BR.updateProgress(currentBook.id, { chapter: chapterIdx, sentence: idx });
  }, 600);
}

/* ---------- 侧栏开合 ---------- */
function toggleSide(which) {
  const side = which === 'toc' ? $('tocSide') : $('noteSide');
  const reopen = which === 'toc' ? $('btnTocReopen') : null;
  side.classList.toggle('collapsed');
  if (reopen) reopen.classList.toggle('show', side.classList.contains('collapsed'));
}

/* ---------- 右键菜单：书签与笔记 ---------- */
function showCtxMenu(e, i) {
  if (!currentBook) return;
  ctxTarget = i;
  const menu = $('ctxMenu');
  menu.hidden = false;
  menu.querySelector('[data-act="copysel"]').hidden = !hasTextSelection();
  menu.querySelector('[data-act="viewimg"]').hidden = !sentences[i] || sentences[i].type !== 'img';
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth - w - 8);
  const y = Math.min(e.clientY, window.innerHeight - h - 8);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
}
function hideCtxMenu() { $('ctxMenu').hidden = true; }

function persistAnnotations() {
  if (!currentBook) return;
  clearTimeout(annSaveTimer);
  annSaveTimer = setTimeout(() => { BR.saveAnnotations(currentBook.id, annotations); }, 300);
}
function addBookmark(i) {
  if (i < 0 || !sentences[i]) return;
  if (annotations.some(a => a.type === 'bookmark' && a.chapter === chapterIdx && a.sentence === i)) {
    toast('这一句已经有书签了'); hideCtxMenu(); return;
  }
  annotations.push({
    id: 'an_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type: 'bookmark', chapter: chapterIdx, sentence: i,
    quote: segText(sentences[i]).slice(0, 120), text: '', createdAt: Date.now()
  });
  persistAnnotations(); renderAnnotations(); buildChapList(); render();
  toast('已加书签'); hideCtxMenu();
}
function openNoteCompose(i, editId) {
  if ($('noteSide').classList.contains('collapsed')) toggleSide('note');
  document.querySelectorAll('.note-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'note'));
  $('bookmarkList').hidden = true; $('noteList').hidden = false; $('noteCompose').hidden = false;
  if (editId) {
    const a = annotations.find(x => x.id === editId);
    if (!a) return;
    noteEditingId = a.id; ctxTarget = a.sentence;
    $('noteQuote').textContent = '「' + (a.quote || '') + '」';
    $('noteInput').value = a.text || '';
  } else {
    noteEditingId = null;
    const t = i >= 0 ? i : idx;
    ctxTarget = t;
    $('noteQuote').textContent = '「' + segText(sentences[t]).slice(0, 120) + '」';
    $('noteInput').value = '';
  }
  hideCtxMenu();
  $('noteInput').focus();
}
function cancelNote() {
  noteEditingId = null;
  $('noteCompose').hidden = true;
  $('noteInput').value = '';
}
function saveNote() {
  const text = $('noteInput').value.trim();
  if (!text) { toast('请先写下读书心得'); return; }
  if (noteEditingId) {
    const a = annotations.find(x => x.id === noteEditingId);
    if (a) { a.text = text; a.updatedAt = Date.now(); }
  } else {
    const t = ctxTarget >= 0 ? ctxTarget : idx;
    annotations.push({
      id: 'an_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: 'note', chapter: chapterIdx, sentence: t,
      quote: segText(sentences[t]).slice(0, 120), text, createdAt: Date.now()
    });
  }
  noteEditingId = null;
  $('noteCompose').hidden = true;
  $('noteInput').value = '';
  persistAnnotations(); renderAnnotations(); buildChapList(); render();
  toast('笔记已保存');
}
function deleteAnnotation(id) {
  annotations = annotations.filter(a => a.id !== id);
  persistAnnotations(); renderAnnotations(); buildChapList(); render();
  toast('已删除');
}
function renderAnnotations() {
  const byTime = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
  const bms = annotations.filter(a => a.type === 'bookmark').sort(byTime);
  const nts = annotations.filter(a => a.type === 'note').sort(byTime);
  $('bmCount').textContent = bms.length;
  $('ntCount').textContent = nts.length;
  renderAnnList($('bookmarkList'), bms, false);
  renderAnnList($('noteList'), nts, true);
}
function renderAnnList(box, list, showText) {
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="note-empty">还没有' + (showText ? '笔记' : '书签') + '。<br>在正文句子上右键添加。</div>';
    return;
  }
  list.forEach(a => {
    const d = document.createElement('div');
    d.className = 'note-item';
    const q = document.createElement('div');
    q.className = 'q'; q.textContent = '「' + (a.quote || '') + '」';
    d.appendChild(q);
    if (showText) {
      const b = document.createElement('div');
      b.className = 'body'; b.textContent = a.text || '';
      d.appendChild(b);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const loc = document.createElement('span');
    loc.textContent = '第' + ((a.chapter || 0) + 1) + '节 · 第' + ((a.sentence || 0) + 1) + '句';
    meta.appendChild(loc);
    if (showText) {
      const ed = document.createElement('button');
      ed.textContent = '编辑';
      ed.addEventListener('click', ev => { ev.stopPropagation(); openNoteCompose(a.sentence, a.id); });
      meta.appendChild(ed);
    }
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', ev => { ev.stopPropagation(); deleteAnnotation(a.id); });
    meta.appendChild(del);
    d.appendChild(meta);
    d.addEventListener('click', () => jumpToAnnotation(a));
    box.appendChild(d);
  });
}
function jumpToAnnotation(a) {
  if (!currentBook || a.chapter >= currentBook.chapters.length) return;
  playing = false; paused = false; updateButtons();
  if (a.chapter !== chapterIdx) loadChapter(a.chapter, a.sentence);
  else goto(a.sentence, false);
  const el = $('text').querySelector('.sentence[data-i="' + a.sentence + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function loadVoices() {
  voices = window.speechSynthesis.getVoices() || [];
  refreshVoiceOptions();
}

// 根据当前引擎渲染音色下拉
function refreshVoiceOptions() {
  const sel = $('voiceSel');
  sel.innerHTML = '';
  if (engine === 'online' && !onlineDowngraded) {
    onlineVoices.forEach(v => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name;
      sel.appendChild(o);
    });
    sel.value = onlineVoice;
    chosenVoice = null;
  } else {
    const zh = voices.filter(v => /zh|cmn/i.test(v.lang));
    const ordered = zh.concat(voices.filter(v => !/zh|cmn/i.test(v.lang)));
    ordered.forEach(v => {
      const o = document.createElement('option');
      o.value = voices.indexOf(v);
      o.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(o);
    });
    if (zh.length) sel.value = voices.indexOf(zh[0]);
    chosenVoice = voices[parseInt(sel.value)] || voices[0] || null;
    if (!voices.length) $('status').textContent = '未检测到系统语音包，请安装中文语音';
  }
}

/* ---------- 设置窗口（左侧导航：通用 / 关于） ---------- */
let uiT = {};
function appDisplayName() { return uiT.appName || '阅读助手'; }
function applyUiTexts(t) {
  uiT = t || {};
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = uiT[el.dataset.i18n];
    if (v) el.textContent = v;
  });
  $('settingsClose').title = uiT.close || 'Close';
}
function switchSettingsPage(page) {
  const about = page === 'about';
  $('pageGeneral').hidden = about;
  $('pageAbout').hidden = !about;
  $('navGeneral').classList.toggle('active', !about);
  $('navAbout').classList.toggle('active', about);
}
async function openSettingsDialog(page) {
  const [t, s, v] = await Promise.all([BR.uiTexts(), BR.settingsGet(), BR.appVersion()]);
  applyUiTexts(t);
  $('settingsLibPath').value = s.libPath || '';
  document.querySelectorAll('input[name="closeAction"]').forEach(r => {
    r.checked = r.value === s.closeAction;
  });
  $('aboutVersion').textContent = v || '—';
  $('autoCheckUpdate').checked = s.autoCheckUpdate !== false;
  switchSettingsPage(page || 'general');
  $('settingsModal').hidden = false;
}
function closeSettingsDialog() { $('settingsModal').hidden = true; }

BR.onMenuAction(action => {
  if (action === 'import') {
    importBooks();
  } else if (action === 'back') {
    if (document.querySelector('.view.active') && document.querySelector('.view.active').id === 'readerView') {
      $('btnBack').click();
    }
  } else if (action === 'search') {
    if (!currentBook) { toast(uiT.needBook || '请先打开一本书'); return; }
    showView('readerView');
    $('searchInput').focus();
    $('searchInput').select();
  } else if (action === 'settings') {
    openSettingsDialog('general');
  } else if (action === 'about') {
    openSettingsDialog('about');
  }
});

/* ---------- 事件绑定 ---------- */
$('btnImport').addEventListener('click', importBooks);
$('settingsOpenLib').addEventListener('click', () => BR.openLib());
$('settingsCopyPath').addEventListener('click', () => {
  BR.copyText($('settingsLibPath').value).then(() => toast(uiT.copied || '书籍库路径已复制'));
});
$('settingsClose').addEventListener('click', closeSettingsDialog);
$('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) closeSettingsDialog(); });
$('navGeneral').addEventListener('click', () => switchSettingsPage('general'));
$('navAbout').addEventListener('click', () => switchSettingsPage('about'));
document.querySelectorAll('input[name="closeAction"]').forEach(r => {
  r.addEventListener('change', e => { BR.settingsSetCloseAction(e.target.value); });
});
$('autoCheckUpdate').addEventListener('change', e => {
  BR.settingsSetAutoCheck(e.target.checked);
  if (e.target.checked) checkForUpdates(true);
});

/* ---------- 软件更新 ---------- */
let updateInfo = null;
let updateBusy = false;
function setUpdateStatus(text) { $('updateStatus').textContent = text || ''; }
function cleanNotes(notes) {
  const s = String(notes || '');
  return s.replace(/SHA-256:\s*[a-fA-F0-9]{64}/gi, '').trim() || '—';
}
async function checkForUpdates(silent) {
  if (updateBusy) return;
  updateBusy = true;
  $('btnCheckUpdate').disabled = true;
  setUpdateStatus(uiT.checking || '正在检查…');
  try {
    const r = await BR.updateCheck();
    if (!r || !r.ok) {
      setUpdateStatus(uiT.checkFail || '检查失败，请检查网络后重试');
      if (!silent) toast(uiT.checkFail || '检查失败，请检查网络后重试');
      return;
    }
    updateInfo = r;
    if (r.hasUpdate) {
      setUpdateStatus((uiT.newVersion || '发现新版本') + ' v' + r.latest);
      $('btnOpenRelease').hidden = false;
      $('btnOpenRelease').onclick = () => BR.openExternal(r.url || 'https://github.com/matrix4quant/My-Reading-Assistant/releases');
      if (!silent) showUpdateDialog(r);
    } else {
      setUpdateStatus((uiT.upToDate || '已是最新版本') + ' · v' + r.current);
      $('btnOpenRelease').hidden = true;
      if (!silent) toast((uiT.upToDate || '已是最新版本') + ' v' + r.current);
    }
  } catch (e) {
    setUpdateStatus(uiT.checkFail || '检查失败，请检查网络后重试');
    if (!silent) toast(uiT.checkFail || '检查失败，请检查网络后重试');
  } finally {
    updateBusy = false;
    $('btnCheckUpdate').disabled = false;
  }
}
function showUpdateDialog(r) {
  $('updateModalVersion').textContent = 'v' + r.latest + '  (当前 v' + r.current + ')';
  $('updateModalNotes').textContent = cleanNotes(r.notes);
  $('updateProgressWrap').hidden = true;
  $('updateProgressBar').style.width = '0%';
  $('updateModalStatus').textContent = '';
  $('btnUpdateNow').disabled = false;
  $('btnUpdateNow').textContent = uiT.downloadUpdate || '下载并更新';
  $('btnUpdateLater').textContent = uiT.updateLater || '稍后';
  $('updateModal').hidden = false;
}
function closeUpdateDialog() { $('updateModal').hidden = true; }
async function startUpdate() {
  if (!updateInfo || updateBusy) return;
  updateBusy = true;
  $('btnUpdateNow').disabled = true;
  $('btnUpdateLater').disabled = true;
  $('updateProgressWrap').hidden = false;
  $('updateProgressBar').style.width = '0%';
  $('updateModalStatus').textContent = uiT.downloading || '正在下载…';
  $('btnUpdateNow').textContent = uiT.downloading || '正在下载…';
  try {
    const d = await BR.updateDownload(updateInfo);
    if (!d || !d.ok) {
      $('updateModalStatus').textContent = uiT.downloadFail || '下载失败，请稍后重试';
      toast(uiT.downloadFail || '下载失败，请稍后重试');
      return;
    }
    if (d.verified === false) {
      $('updateModalStatus').textContent = uiT.shaWarn || '校验未通过，已取消安装';
      toast(uiT.shaWarn || '校验未通过，已取消安装');
      return;
    }
    $('updateModalStatus').textContent = (uiT.verifying || '正在校验…') + (d.verified ? ' ✓' : '');
    const i = await BR.updateInstall({ path: d.path, version: d.version });
    if (!i || !i.ok) {
      $('updateModalStatus').textContent = uiT.installFail || '安装失败，请手动下载安装';
      toast(uiT.installFail || '安装失败，请手动下载安装');
      return;
    }
    $('updateModalStatus').textContent = uiT.restartHint || '下载完成后会保留旧版 exe，自动启动新版。';
    $('btnUpdateNow').textContent = uiT.installNow || '安装并重启';
  } catch (e) {
    $('updateModalStatus').textContent = uiT.updateError || '更新失败';
    toast((uiT.updateError || '更新失败') + '：' + (e.message || e));
  } finally {
    updateBusy = false;
    $('btnUpdateLater').disabled = false;
  }
}
BR.onUpdateProgress(pct => {
  if ($('updateProgressWrap').hidden) return;
  $('updateProgressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('updateModalStatus').textContent = (uiT.downloading || '正在下载…') + ' ' + pct + '%';
});
BR.onUpdateAvailable(r => {
  updateInfo = r;
  setUpdateStatus((uiT.newVersion || '发现新版本') + ' v' + r.latest);
  $('btnOpenRelease').hidden = false;
  $('btnOpenRelease').onclick = () => BR.openExternal(r.url || 'https://github.com/matrix4quant/My-Reading-Assistant/releases');
  toast((uiT.updateAvailable || '有新版本可用') + ' v' + r.latest);
});
$('btnCheckUpdate').addEventListener('click', () => checkForUpdates(false));
$('btnUpdateLater').addEventListener('click', closeUpdateDialog);
$('updateModal').addEventListener('click', e => { if (e.target === $('updateModal')) closeUpdateDialog(); });
$('btnUpdateNow').addEventListener('click', startUpdate);
$('btnWeblibRefresh').addEventListener('click', () => refreshWebLibDomain(false));
$('btnWeblibAdd').addEventListener('click', () => openWebLibModal(null));
$('webLibSave').addEventListener('click', saveWebLib);
$('webLibCancel').addEventListener('click', closeWebLibModal);
$('webLibModal').addEventListener('click', e => { if (e.target === $('webLibModal')) closeWebLibModal(); });
$('btnBack').addEventListener('click', async () => {
  resetPlayback('已停止');
  saveProgress();
  document.title = appDisplayName();
  await renderShelf();
  showView('shelfView');
});
$('btnPlay').addEventListener('click', togglePlay);
$('btnStop').addEventListener('click', () => { resetPlayback('已停止'); render(); });
$('btnPrev').addEventListener('click', () => goto(idx - 1, playing));
$('btnNext').addEventListener('click', () => goto(idx + 1, playing));

/* ---------- 侧栏开合与底部控件 ---------- */
$('btnTocClose').addEventListener('click', () => toggleSide('toc'));
$('btnTocReopen').addEventListener('click', () => toggleSide('toc'));
$('btnTocOpenTop').addEventListener('click', () => toggleSide('toc'));
$('btnNoteClose').addEventListener('click', () => toggleSide('note'));
$('btnNoteOpen').addEventListener('click', () => toggleSide('note'));

/* ---------- 全文搜索事件 ---------- */
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  $('btnSearchClear').hidden = !q.trim();
  searchTimer = setTimeout(() => runSearch(q, false), 200);
});
$('searchInput').addEventListener('keydown', e => {
  if (e.code === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    runSearch(e.target.value, true);
  } else if ((e.code === 'ArrowDown' || e.code === 'ArrowUp') && searchHits.length) {
    e.preventDefault();
    searchSel = e.code === 'ArrowDown'
      ? Math.min(searchSel + 1, searchHits.length - 1)
      : Math.max(searchSel - 1, 0);
    renderSearchResults();
    const on = $('searchResults').querySelector('.search-result.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  } else if (e.code === 'Escape') {
    $('searchResults').hidden = true;
    e.target.blur();
  }
});
$('btnSearchClear').addEventListener('click', () => { clearSearch(); $('searchInput').focus(); });
$('btnSearchBack').addEventListener('click', searchBack);

$('btnSettings').addEventListener('click', () => {
  const p = $('settingsPanel');
  p.hidden = !p.hidden;
  $('btnSettings').textContent = p.hidden ? '⚙ 设置' : '⚙ 收起设置';
});

$('timeline').addEventListener('input', e => {
  const i = parseInt(e.target.value, 10);
  if (!isNaN(i)) goto(i, playing);
});

/* ---------- 右键菜单与笔记 ---------- */
$('ctxMenu').addEventListener('click', e => {
  const item = e.target.closest('[data-act]');
  if (!item) return;
  const act = item.dataset.act;
  const i = ctxTarget >= 0 ? ctxTarget : idx;
  if (act === 'copysel') { const t = selectedText(); hideCtxMenu(); copyToClipboard(t); }
  else if (act === 'copypara') { const seg = sentences[i]; hideCtxMenu(); copyToClipboard(seg ? segText(seg) : ''); }
  else if (act === 'bookmark') addBookmark(i);
  else if (act === 'note') openNoteCompose(i);
  else if (act === 'play') { hideCtxMenu(); playing = true; paused = false; speakFrom(i); }
  else if (act === 'viewimg') {
    hideCtxMenu();
    const seg = sentences[i];
    if (seg && seg.type === 'img') openLightbox(seg.src, seg.alt);
    else toast('这一段不是图表');
  }
});
$('btnLightboxClose').addEventListener('click', closeLightbox);
$('btnZoomIn').addEventListener('click', () => lbSetZoom(lbZoom * 1.25));
$('btnZoomOut').addEventListener('click', () => lbSetZoom(lbZoom / 1.25));
$('btnZoomFit').addEventListener('click', lbReset);
$('lightbox').addEventListener('click', e => {
  if (e.target === $('lightbox') || e.target === $('lbStage')) closeLightbox();
});
$('lightbox').addEventListener('wheel', e => {
  if ($('lightbox').hidden) return;
  e.preventDefault();
  lbSetZoom(lbZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
}, { passive: false });
$('lightboxImg').addEventListener('dblclick', e => {
  e.preventDefault();
  lbSetZoom(lbZoom > 1.2 ? 1 : 2, e.clientX, e.clientY);
});
$('lbStage').addEventListener('mousedown', e => {
  if (e.button !== 0 || $('lightbox').hidden) return;
  lbDragging = true;
  lbDragX = e.clientX; lbDragY = e.clientY;
  lbPanX0 = lbPanX; lbPanY0 = lbPanY;
  $('lbStage').classList.add('dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!lbDragging) return;
  lbPanX = lbPanX0 + (e.clientX - lbDragX);
  lbPanY = lbPanY0 + (e.clientY - lbDragY);
  lbApply();
});
window.addEventListener('mouseup', () => {
  if (!lbDragging) return;
  lbDragging = false;
  $('lbStage').classList.remove('dragging');
});
document.addEventListener('click', e => {
  if (!$('ctxMenu').contains(e.target)) hideCtxMenu();
  if (!$('searchWrap').contains(e.target) && !$('searchResults').contains(e.target)) $('searchResults').hidden = true;
});
document.querySelectorAll('.note-tabs button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.note-tabs button').forEach(x => x.classList.toggle('on', x === b));
    const isBm = b.dataset.tab === 'bookmark';
    $('bookmarkList').hidden = !isBm;
    $('noteList').hidden = isBm;
  });
});
$('noteSave').addEventListener('click', saveNote);
$('noteCancel').addEventListener('click', cancelNote);

$('engineSel').addEventListener('change', e => {
  engine = e.target.value;
  onlineDowngraded = false;
  refreshVoiceOptions();
  $('status').textContent = engine === 'online' ? '已切换到在线神经语音' : '已切换到系统语音';
  if (playing && !paused) speakFrom(idx);
});
$('voiceSel').addEventListener('change', e => {
  if (engine === 'online' && !onlineDowngraded) {
    onlineVoice = e.target.value;
  } else {
    chosenVoice = voices[parseInt(e.target.value)] || null;
  }
  prefetchedKeys.clear();
  if (playing && !paused) speakFrom(idx);
});
document.querySelectorAll('#speeds button').forEach(b => {
  b.addEventListener('click', () => {
    rate = parseFloat(b.dataset.speed);
    $('rate').value = rate;
    $('rateVal').textContent = rate.toFixed(1) + '×';
    document.querySelectorAll('#speeds button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    updateCounter();
    if (playing && !paused) speakFrom(idx);
  });
});
$('rate').addEventListener('input', e => {
  rate = parseFloat(e.target.value);
  $('rateVal').textContent = rate.toFixed(1) + '×';
  document.querySelectorAll('#speeds button').forEach(x => x.classList.toggle('on', parseFloat(x.dataset.speed) === rate));
  updateCounter();
  if (playing && !paused) speakFrom(idx);
});
$('volume').addEventListener('input', e => {
  volume = parseFloat(e.target.value);
  $('volumeVal').textContent = Math.round(volume * 100) + '%';
  if (audioEl) audioEl.volume = volume;
  if (utter) utter.volume = volume;
});
$('fontSize').addEventListener('input', e => {
  document.documentElement.style.setProperty('--fs', e.target.value + 'px');
  $('fontSizeVal').textContent = e.target.value;
});
$('lineHeight').addEventListener('input', e => {
  document.documentElement.style.setProperty('--lh', e.target.value);
  $('lineHeightVal').textContent = e.target.value;
});
$('themeSel').addEventListener('change', e => { document.body.dataset.theme = e.target.value; });
$('focusMode').addEventListener('change', render);
$('autoScroll').addEventListener('change', render);

document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && !$('updateModal').hidden) { closeUpdateDialog(); return; }
  if (e.code === 'Escape' && !$('settingsModal').hidden) { closeSettingsDialog(); return; }
  if (!$('readerView').classList.contains('active')) return;
  if (e.code === 'Escape') { hideCtxMenu(); cancelNote(); closeLightbox(); $('searchResults').hidden = true; return; }
  if (!$('lightbox').hidden) {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); lbSetZoom(lbZoom * 1.25); }
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); lbSetZoom(lbZoom / 1.25); }
    else if (e.code === 'Digit0' || e.code === 'Numpad0') { e.preventDefault(); lbReset(); }
    return;
  }
  if (['TEXTAREA', 'SELECT', 'INPUT'].includes(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && hasTextSelection()) {
    e.preventDefault(); copyToClipboard(selectedText()); return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); goto(idx - 1, playing); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); goto(idx + 1, playing); }
  else if (e.code === 'KeyB') { e.preventDefault(); addBookmark(idx); }
});
// 朗读中如果用户开始选中文字，自动暂停，避免下一句刷新页面时清掉选区
document.addEventListener('selectionchange', () => {
  if (!playing || paused || !hasTextSelection()) return;
  const sel = window.getSelection();
  if (sel && $('text').contains(sel.anchorNode)) togglePlay();
});
window.addEventListener('beforeunload', () => { try { window.speechSynthesis.cancel(); } catch (e) {} });

/* ---------- 启动 ---------- */
(async function init() {
  renderShelf();
  initWebLib();
  BR.uiTexts().then(t => { applyUiTexts(t); if (!currentBook) document.title = appDisplayName(); }).catch(() => {});
  BR.appVersion().then(v => { $('appVersionLabel').textContent = appDisplayName() + ' v' + v; }).catch(() => {});
  // 加载在线音色
  try {
    onlineVoices = await BR.ttsVoices();
  } catch (e) {
    onlineVoices = [];
  }
  engine = 'online';
  $('engineSel').value = 'online';
  refreshVoiceOptions();
  // 系统语音作为离线兜底，仍预先加载
  if ('speechSynthesis' in window) {
    voices = window.speechSynthesis.getVoices() || [];
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = () => { voices = window.speechSynthesis.getVoices() || []; };
    }
  }
})();
