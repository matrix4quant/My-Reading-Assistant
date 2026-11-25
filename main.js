const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { pathToFileURL } = require('url');
const JSZip = require('jszip');
const { EdgeTTS } = require('node-edge-tts');

// 中文在线音色清单（微软 Edge 神经网络语音，2026-11 官方 voices/list）
const ONLINE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 女声（温柔通用）' },
  { id: 'zh-CN-XiaoyiNeural',   name: '晓伊 · 女声（活泼）' },
  { id: 'zh-CN-YunxiNeural',    name: '云希 · 男声（阳光）' },
  { id: 'zh-CN-YunjianNeural',  name: '云健 · 男声（浑厚）' },
  { id: 'zh-CN-YunyangNeural',  name: '云扬 · 男声（新闻播报）' },
  { id: 'zh-CN-YunxiaNeural',   name: '云夏 · 男声（少年）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 女声（东北话）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural',   name: '晓妮 · 女声（陕西话）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻 · 女声（台湾）' },
  { id: 'zh-TW-HsiaoYuNeural',   name: '曉雨 · 女声（台湾）' },
  { id: 'zh-TW-YunJheNeural',    name: '雲哲 · 男声（台湾）' },
  { id: 'zh-HK-HiuGaaiNeural',   name: '曉佳 · 女声（香港）' },
  { id: 'zh-HK-HiuMaanNeural',   name: '曉曼 · 女声（香港）' },
  { id: 'zh-HK-WanLungNeural',   name: '雲龍 · 男声（香港）' }
];

// 合成缓存：key -> { audio: base64, marks: [{part,start,end}] }
const synthCache = new Map();
const CACHE_MAX = 120;
// 飞行中的合成：key -> Promise。预取与按需朗读可能同时请求同一句，复用同一个 Promise 避免重复请求。
const synthPending = new Map();
const SYNTH_RETRIES = 2; // 网络抖动（TLS 断连等）时重试次数
let synthSeq = 0;

// 语速 0.5~2.5 转 edge-tts 的 -50% ~ +150%
function rateToEdge(rate) {
  const pct = Math.round((rate - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function synthKey(voice, edgeRate, text) {
  return voice + '|' + edgeRate + '|' + text;
}

async function doSynthesize(text, voice, edgeRate) {
  let lastErr;
  for (let attempt = 0; attempt <= SYNTH_RETRIES; attempt++) {
    const chunks = [], marks = [];
    try {
      // 每次重试都新建实例，避免复用内部连接状态
      const tts = new EdgeTTS({ voice, rate: edgeRate, saveSubtitles: true, timeout: 20000 });
      for await (const c of tts.streamAudio(text)) {
        if (Buffer.isBuffer(c)) chunks.push(c);
        else if (c && typeof c === 'object' && 'start' in c) marks.push(c);
      }
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error('未获取到音频');
      return {
        seq: ++synthSeq,
        audio: buf.toString('base64'),
        marks: marks.map(m => ({ part: m.part, start: m.start, end: m.end })),
        duration: marks.length ? marks[marks.length - 1].end : 0
      };
    } catch (e) {
      lastErr = e;
      if (attempt < SYNTH_RETRIES) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// 唯一的合成入口：命中缓存直接返回；飞行中的相同请求复用同一个 Promise
function synthesize(voice, edgeRate, text) {
  const key = synthKey(voice, edgeRate, text);
  if (synthCache.has(key)) return Promise.resolve(synthCache.get(key));
  if (synthPending.has(key)) return synthPending.get(key);
  const p = doSynthesize(text, voice, edgeRate).then(result => {
    synthCache.set(key, result);
    if (synthCache.size > CACHE_MAX) synthCache.delete(synthCache.keys().next().value);
    synthPending.delete(key);
    return result;
  }).catch(e => {
    synthPending.delete(key);
    throw e;
  });
  synthPending.set(key, p);
  return p;
}


let win = null;

// 书籍库目录：放在应用数据目录，避免随 OneDrive 同步产生冲突
function libDir() {
  return path.join(app.getPath('userData'), 'bookshelf');
}
function booksDir() {
  const d = path.join(libDir(), 'books');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function indexFile() {
  return path.join(libDir(), 'index.json');
}

function readIndex() {
  try {
    const raw = fs.readFileSync(indexFile(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}
function writeIndex(list) {
  fs.mkdirSync(libDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(list, null, 2), 'utf8');
}
function bookPath(id) {
  return path.join(booksDir(), id + '.json');
}

// 书籍图片资源：与正文 JSON 分开存放，避免每次保存进度都重写几十 MB 图片
function imageDir(bookId) {
  const d = path.join(libDir(), 'images', bookId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeRel(rel) {
  const r = String(rel || '').replace(/^\/+/, '');
  if (!r || r.includes('\0') || path.isAbsolute(r) || r.split(/[\\/]/).includes('..')) return null;
  return r;
}
function imagePath(bookId, rel) {
  const s = safeRel(rel);
  return s ? path.join(imageDir(bookId), s) : null;
}

// 把 pdf.js 解出的原始像素编码成 JPEG（不需要原生 canvas 模块）
function rawImageToRgba(img) {
  const width = img.width, height = img.height, kind = img.kind;
  const src = Buffer.from(img.data);
  const out = Buffer.alloc(width * height * 4);
  if (kind === 2) { // RGB 24bpp
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = src[j]; out[i * 4 + 1] = src[j + 1]; out[i * 4 + 2] = src[j + 2]; out[i * 4 + 3] = 255;
    }
  } else if (kind === 1) { // 1bpp：0 黑 1 白
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
  } else { // RGBA 32bpp
    src.copy(out, 0, 0, Math.min(src.length, out.length));
  }
  return { width, height, data: out };
}
function downscaleRgba(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------- 界面文案（随系统语言） ----------
function uiTexts() {
  const zh = (app.getLocale() || '').toLowerCase().startsWith('zh');
  return zh ? {
    appName: '阅读助手', file: '文件', edit: '编辑',
    import: '导入书籍…', back: '返回书架', settingsMenu: '设置…', quit: '退出',
    copy: '复制', selectAll: '全选', search: '搜索全书…',
    settingsTitle: '设置', general: '通用', aboutNav: '关于', aboutApp: '关于阅读助手',
    libraryLocation: '书籍库位置', openFolder: '打开文件夹', copyPath: '复制路径',
    closeBehavior: '关闭按钮行为', closeQuit: '退出程序', closeTray: '最小化到系统托盘',
    version: '版本', aboutDesc: '导入本地书籍，逐句高亮朗读，支持书签与笔记。',
    copied: '书籍库路径已复制', trayShow: '显示窗口', trayQuit: '退出', close: '关闭',
    needBook: '请先打开一本书'
  } : {
    appName: 'my reading assistant', file: 'File', edit: 'Edit',
    import: 'Import Books…', back: 'Back to Shelf', settingsMenu: 'Settings…', quit: 'Quit',
    copy: 'Copy', selectAll: 'Select All', search: 'Search in Books…',
    settingsTitle: 'Settings', general: 'General', aboutNav: 'About', aboutApp: 'About my reading assistant',
    libraryLocation: 'Library location', openFolder: 'Open folder', copyPath: 'Copy path',
    closeBehavior: 'Close button action', closeQuit: 'Quit application', closeTray: 'Minimize to system tray',
    version: 'Version', aboutDesc: 'Import local books, read along with word highlighting, and keep bookmarks and notes.',
    copied: 'Library path copied', trayShow: 'Show window', trayQuit: 'Quit', close: 'Close',
    needBook: 'Open a book first'
  };
}

function menuTexts() {
  const t = uiTexts();
  return {
    file: t.file, edit: t.edit, import: t.import, back: t.back,
    settings: t.settingsMenu, quit: t.quit, copy: t.copy,
    selectAll: t.selectAll, search: t.search, appName: t.appName
  };
}

function sendMenuAction(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu-action', action);
}

// ---------- 设置持久化与系统托盘 ----------
let tray = null;
let forceQuit = false;

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writeSettings(patch) {
  const data = Object.assign({}, readSettings(), patch);
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}
function closeAction() { return readSettings().closeAction === 'tray' ? 'tray' : 'quit'; }

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray) return tray;
  const t = uiTexts();
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip(t.appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.trayShow, click: showMainWindow },
    { type: 'separator' },
    { label: t.trayQuit, click: () => { forceQuit = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  return tray;
}

function buildAppMenu() {
  const t = menuTexts();
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) template.push({ role: 'appMenu', label: t.appName });
  template.push(
    {
      label: t.file,
      submenu: [
        { label: t.import, accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('import') },
        { label: t.back, accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('back') },
        { type: 'separator' },
        { label: t.settings, click: () => sendMenuAction('settings') },
        { type: 'separator' },
        { label: t.quit, click: () => { forceQuit = true; app.quit(); } }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { label: t.copy, role: 'copy', accelerator: 'CmdOrCtrl+C' },
        { label: t.selectAll, role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
        { type: 'separator' },
        { label: t.search, accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('search') }
      ]
    }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: uiTexts().appName,
    backgroundColor: '#f5f1e8',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (event) => {
    if (!forceQuit && closeAction() === 'tray') {
      event.preventDefault();
      win.hide();
    }
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools();
}

app.on('before-quit', () => { forceQuit = true; });

app.whenReady().then(() => {
  booksDir();
  buildAppMenu();
  if (closeAction() === 'tray') ensureTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

// 选择要导入的书籍文件（支持多选）
ipcMain.handle('choose-files', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要导入的书籍',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的书籍', extensions: ['txt', 'md', 'epub', 'pdf'] },
      { name: '文本', extensions: ['txt', 'md'] },
      { name: 'EPUB 电子书', extensions: ['epub'] },
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp, path.extname(fp)),
    ext: path.extname(fp).toLowerCase().slice(1),
    size: fs.statSync(fp).size,
    data: fs.readFileSync(fp).toString('base64')
  }));
});

// 列出书架
ipcMain.handle('list-books', () => readIndex());

// 保存一本书（元数据进索引，正文单独存文件）
ipcMain.handle('save-book', (event, book) => {
  fs.writeFileSync(bookPath(book.id), JSON.stringify(book), 'utf8');
  const list = readIndex();
  const meta = {
    id: book.id,
    title: book.title,
    author: book.author || '',
    source: book.source || '',
    ext: book.ext || '',
    chapters: book.chapters.map(c => ({ title: c.title, chars: c.text.length })),
    totalChars: book.chapters.reduce((a, c) => a + c.text.length, 0),
    addedAt: book.addedAt,
    progress: book.progress || { chapter: 0, sentence: 0 }
  };
  const i = list.findIndex(b => b.id === book.id);
  if (i >= 0) list[i] = meta; else list.unshift(meta);
  writeIndex(list);
  return meta;
});

// 读取整本书正文
ipcMain.handle('load-book', (event, id) => {
  try {
    return JSON.parse(fs.readFileSync(bookPath(id), 'utf8'));
  } catch (e) {
    return null;
  }
});

// 更新阅读进度
ipcMain.handle('update-progress', (event, id, progress) => {
  try {
    const book = JSON.parse(fs.readFileSync(bookPath(id), 'utf8'));
    book.progress = progress;
    fs.writeFileSync(bookPath(id), JSON.stringify(book), 'utf8');
  } catch (e) {}
  const list = readIndex();
  const meta = list.find(b => b.id === id);
  if (meta) meta.progress = progress;
  writeIndex(list);
});

// 保存书签与笔记（随书籍 JSON 一起持久化）
ipcMain.handle('save-annotations', (event, id, annotations) => {
  try {
    const book = JSON.parse(fs.readFileSync(bookPath(id), 'utf8'));
    book.annotations = annotations || [];
    fs.writeFileSync(bookPath(id), JSON.stringify(book), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
});

// 删除书
ipcMain.handle('delete-book', (event, id) => {
  try { fs.unlinkSync(bookPath(id)); } catch (e) {}
  writeIndex(readIndex().filter(b => b.id !== id));
});

// 打开库目录
ipcMain.handle('open-lib', () => shell.openPath(booksDir()));

// 获取库路径
ipcMain.handle('lib-path', () => booksDir());

// 获取应用版本号
ipcMain.handle('app-version', () => app.getVersion());

// 菜单栏信息（用于诊断与验证）
ipcMain.handle('menu-info', () => ({
  locale: app.getLocale(),
  labels: menuTexts(),
  topLevel: (Menu.getApplicationMenu()?.items || []).map(i => i.label)
}));

// 供自检使用：模拟一次菜单点击
ipcMain.handle('menu-test', (event, action) => { sendMenuAction(action); return true; });

// 供自检使用：模拟窗口关闭/显示
ipcMain.handle('window-test', (event, action) => {
  if (action === 'close') win.close();
  else if (action === 'show') showMainWindow();
  return { visible: !win.isDestroyed() && win.isVisible() };
});

// 界面文案与设置项
ipcMain.handle('ui-texts', () => uiTexts());
ipcMain.handle('settings-get', () => ({
  closeAction: closeAction(),
  libPath: booksDir()
}));
ipcMain.handle('settings-set-close-action', (event, value) => {
  const v = value === 'tray' ? 'tray' : 'quit';
  writeSettings({ closeAction: v });
  if (v === 'tray') ensureTray();
  else if (tray) { tray.destroy(); tray = null; }
  return v;
});

// ---------- 首页在线书库 ----------
// 配置持久化：用户自定义条目 + 自动域名的最新结果
function webLibPath() { return path.join(app.getPath('userData'), 'weblib.json'); }
function readWebLib() {
  try { return JSON.parse(fs.readFileSync(webLibPath(), 'utf8')); }
  catch (e) { return { sites: [], domains: {} }; }
}
function writeWebLib(cfg) {
  try { fs.writeFileSync(webLibPath(), JSON.stringify(cfg, null, 2)); } catch (e) {}
}
ipcMain.handle('weblib-load', () => readWebLib());
ipcMain.handle('weblib-save', (event, cfg) => { writeWebLib(cfg); return true; });

// 用系统默认浏览器打开外部网址（仅允许 http/https）
ipcMain.handle('open-external', async (event, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http/https 网址' };
    await shell.openExternal(u.href);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 从 Wikipedia 公开条目解析 Z-Library 官方域名（缓存结果，失败时保留上一次）
const WIKI_API = 'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&titles=Z-Library';
function httpsGet(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('重定向次数过多'));
    const req = https.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'MyReadingAssistant/2.1 (personal reading app)', 'Accept': 'application/json' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return httpsGet(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}
ipcMain.handle('weblib-resolve-domain', async () => {
  const cfg = readWebLib();
  try {
    const raw = await httpsGet(WIKI_API);
    const data = JSON.parse(raw);
    const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
    let wikitext = '';
    for (const p of pages) {
      const revs = p.revisions || [];
      if (revs.length && revs[0].slots) {
        const s = revs[0].slots.main || {};
        wikitext = s['*'] || s.content || '';
      } else if (revs.length && revs[0]['*']) wikitext = revs[0]['*'];
      if (wikitext) break;
    }
    // 只取 infobox 的 website 字段，避免抓到正文里的引用/诈骗域名链接
    const field = wikitext.match(/\|\s*website\s*=\s*([\s\S]{0,2000}?)(?=\n\s*\|\s*\w|\n\}\})/i);
    const scope = field ? field[1] : '';
    const re = /https?:\/\/(?:www\.)?(z-[a-z0-9.-]+|zlibrary[a-z0-9.-]*)\/?/gi;
    const found = [];
    for (const m of scope.matchAll(re)) {
      const u = 'https://' + m[1].replace(/\/$/, '') + '/';
      if (!found.includes(u)) found.push(u);
    }
    if (!found.length) throw new Error('条目中未找到官方域名');
    cfg.domains = cfg.domains || {};
    cfg.domains.zlibrary = { url: found[0], candidates: found, updatedAt: Date.now(), source: 'Wikipedia · Z-Library' };
    writeWebLib(cfg);
    return { ok: true, ...cfg.domains.zlibrary };
  } catch (e) {
    const cached = (cfg.domains || {}).zlibrary;
    return { ok: false, error: e.message, cached: cached || null };
  }
});

// 写入系统剪贴板
ipcMain.handle('clipboard-write', (event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

// 读取原始书籍文件（用于给旧书补齐图表）
ipcMain.handle('read-source', (event, filePath) => {
  try { return fs.readFileSync(filePath).toString('base64'); }
  catch (e) { throw new Error('无法读取原书文件：' + e.message); }
});

// 从 EPUB 源文件中提取指定图片到书籍库（只写磁盘，不塞进 JSON）
ipcMain.handle('extract-epub-images', async (event, bookId, epubPath, refs) => {
  const list = Array.isArray(refs) ? refs.filter(safeRel) : [];
  if (!list.length) return { count: 0, skipped: 0 };
  let buf;
  try { buf = fs.readFileSync(epubPath); }
  catch (e) { throw new Error('无法读取 EPUB：' + e.message); }
  const zip = await JSZip.loadAsync(buf);
  let count = 0, skipped = 0;
  for (const rel of list) {
    const zf = zip.file(rel);
    if (!zf) { skipped++; continue; }
    const dest = imagePath(bookId, rel);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { count++; continue; }
      const data = await zf.async('nodebuffer');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      count++;
    } catch (e) { skipped++; }
  }
  return { count, skipped };
});

// 保存渲染进程生成的数据图片（PDF 图表用）
ipcMain.handle('save-image-files', (event, bookId, files) => {
  let count = 0;
  for (const f of (files || [])) {
    const rel = safeRel(f.name);
    if (!rel || !f.data) continue;
    try {
      const b64 = String(f.data).replace(/^data:[^;]+;base64,/, '');
      const dest = imagePath(bookId, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
      count++;
    } catch (e) {}
  }
  return count;
});

// 从 PDF 中提取内嵌图表，直接写到书籍库磁盘，返回「页码 -> 图片路径」映射
ipcMain.handle('extract-pdf-images', async (event, bookId, pdfPath) => {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const jpeg = require('jpeg-js');
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.js');
  const fileBuf = fs.readFileSync(pdfPath);
  const data = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pageMap = {};
  const seen = new Set();
  let count = 0, skipped = 0;
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      let ops;
      try { ops = await page.getOperatorList(); } catch (e) { continue; }
      const ids = [];
      for (let oi = 0; oi < ops.fnArray.length; oi++) {
        if (ops.fnArray[oi] !== pdfjs.OPS.paintImageXObject) continue;
        const a = ops.argsArray[oi];
        const id = Array.isArray(a) ? a[0] : a;
        if ((typeof id === 'number' || typeof id === 'string') && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
      if (!ids.length) continue;
      const rels = [];
      for (let ii = 0; ii < ids.length; ii++) {
        try {
          const store = String(ids[ii]).startsWith('g_') ? page.commonObjs : page.objs;
          const img = await new Promise(resolve => store.get(ids[ii], resolve));
          if (!img || img.width < 100 || img.height < 60) { skipped++; continue; }
          const rgba = downscaleRgba(rawImageToRgba(img), 1400);
          const encoded = jpeg.encode(rgba, 82);
          const rel = 'pdf/p' + String(p).padStart(4, '0') + '_i' + ii + '.jpg';
          const dest = imagePath(bookId, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, encoded.data);
          rels.push(rel); count++;
        } catch (e) { skipped++; }
      }
      if (rels.length) pageMap[p] = rels;
    }
  } finally {
    try { await pdf.destroy(); } catch (e) {}
  }
  return { pageMap, count, skipped };
});

// 取图片的 file:// URL，供渲染进程显示
ipcMain.handle('image-url', (event, bookId, rel) => {
  const p = imagePath(bookId, rel);
  return p && fs.existsSync(p) ? pathToFileURL(p).href : '';
});

// ---------- 在线语音（Edge TTS）----------

// 获取在线中文音色列表
ipcMain.handle('tts-voices', () => ONLINE_VOICES);

// 合成语音：返回 base64 mp3 + 逐词时间戳（缓存命中 / 飞行中请求均复用结果）
ipcMain.handle('tts-synth', async (event, { text, voice, rate }) => {
  return synthesize(voice || 'zh-CN-XiaoxiaoNeural', rateToEdge(rate || 1), text);
});

// 预取后续句子（后台合成，不抛错；与按需合成共享缓存与飞行中去重）
ipcMain.handle('tts-prefetch', async (event, { text, voice, rate }) => {
  try {
    await synthesize(voice || 'zh-CN-XiaoxiaoNeural', rateToEdge(rate || 1), text);
  } catch (e) { /* 预取失败静默忽略，朗读时仍会按需重试 */ }
});
