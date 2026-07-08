const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3012;
const ROOT_DIR = __dirname;
const IMAGES_DIR = path.resolve(ROOT_DIR, '..', 'images');
const IMAGE_SRC_PREFIX = normalizeImageSrcPrefix(process.env.IMAGE_SRC_PREFIX || 'https://cdn.jsdelivr.net/gh/lx233/cos-album@main/');
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const META_FILE = path.join(ROOT_DIR, 'image-meta.json');
const DEFAULT_WEIGHT = 100;
const MIN_WEIGHT = 0;
const MAX_WEIGHT = 999;
const SHUFFLE_NOISE = 30;
const ADMIN_QUESTION = '香菇猫的 QQ 号前 4 位是多少？';
const ADMIN_ANSWER = '3108';
const ADMIN_TOKEN = '3108-' + require('crypto').createHash('sha256').update('shanggu-admin-secret').digest('hex').slice(0, 16);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 50,
    fileSize: 30 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, imageExtensions.has(ext));
  }
});

function normalizePart(value, fallback) {
  const clean = String(value || '')
    .trim()
    .replace(/[\\/\0]/g, '')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/[<>:"|?*]/g, '')
    .slice(0, 40);
  return clean || fallback;
}

function normalizeMonth(value) {
  const match = String(value || '').match(/\d{4}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 7);
}

function normalizeWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight)) return DEFAULT_WEIGHT;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(weight)));
}

function normalizeImageSrcPrefix(value) {
  const prefix = String(value || '/images/').trim() || '/images/';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(prefix) || prefix.startsWith('//')) {
    return prefix.endsWith('/') ? prefix : prefix + '/';
  }
  return '/' + prefix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';
}

function getImageSrc(fileName) {
  return IMAGE_SRC_PREFIX + encodeURIComponent(fileName);
}

function getLocalImageSrc(fileName) {
  return '/images/' + encodeURIComponent(fileName);
}

function candidateLocalFileNames(image) {
  const candidates = [image.fileName, image.id];
  for (const value of [image.localSrc, image.src]) {
    if (!value || /^https?:\/\//i.test(value)) continue;
    try {
      candidates.push(path.basename(decodeURIComponent(new URL(value, 'http://local').pathname)));
    } catch (error) {
      candidates.push(path.basename(String(value)));
    }
  }
  return Array.from(new Set(candidates.filter(Boolean)
    .filter((fileName) => !/^https?:\/\//i.test(fileName))
    .map((fileName) => {
      try { return decodeURIComponent(fileName); } catch (error) { return fileName; }
    })));
}

function deleteLocalImageIfExists(image) {
  for (const fileName of candidateLocalFileNames(image)) {
    const imagePath = path.resolve(IMAGES_DIR, fileName);
    if (!imagePath.startsWith(IMAGES_DIR + path.sep)) continue;
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      return fileName;
    }
  }
  return '';
}

function readMetadata() {
  const base = { version: 1, bestByGroup: {}, weightByFile: {}, externalImages: [], nextExternalId: 1 };
  if (!fs.existsSync(META_FILE)) return base;
  const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  return { ...base, ...meta };
}

function writeMetadata(meta) {
  fs.writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
}

function migrateMetadataImages() {
  const meta = readMetadata();
  if (!Array.isArray(meta.images)) {
    const existing = new Set();
    meta.images = [];
    for (const item of listImages()) {
      meta.images.push(item);
      existing.add(item.fileName);
    }
    for (const item of meta.externalImages || []) {
      if (existing.has(item.id)) continue;
      meta.images.push({
        id: item.id,
        src: item.url,
        url: item.url,
        fileName: item.url,
        category: item.category,
        month: item.month,
        date: item.month,
        role: item.role
      });
    }
  }
  meta.images = normalizeMetaImages(meta);
  meta.externalImages = [];
  meta.migratedToImageList = true;
  writeMetadata(meta);
  return meta;
}

function getGroupKey(image) {
  return JSON.stringify([image.category, image.month, image.role]);
}

function normalizeMetaImages(meta) {
  const images = Array.isArray(meta.images) ? meta.images : (meta.externalImages || []);
  return images.map((item) => {
    const fileName = item.fileName || item.url || item.id;
    const isRemote = /^https?:\/\//i.test(fileName) || /^https?:\/\//i.test(item.src || '');
    const normalized = {
      ...item,
      id: item.id || fileName,
      src: item.src || item.url || (isRemote ? fileName : getImageSrc(fileName)),
      fileName,
      category: item.category || '其他',
      month: item.month || item.date || '未知月份',
      date: item.date || item.month || '未知月份',
      role: item.role || '未分类角色'
    };
    delete normalized.kind;
    if (!isRemote) normalized.localSrc = item.localSrc || getLocalImageSrc(fileName);
    return normalized;
  });
}

function getAllImages(meta = readMetadata()) {
  return normalizeMetaImages(meta);
}

function enrichImagesWithMetadata(images, meta = readMetadata()) {
  const firstByGroup = new Map();
  for (const image of images) {
    const groupKey = getGroupKey(image);
    if (!firstByGroup.has(groupKey)) firstByGroup.set(groupKey, image.id);
  }
  return images.map((image) => {
    const groupKey = getGroupKey(image);
    const best = meta.bestByGroup[groupKey] || firstByGroup.get(groupKey);
    return {
      ...image,
      groupKey,
      weight: normalizeWeight(meta.weightByFile[image.id]),
      isBest: best === image.id
    };
  });
}

function groupImages(images) {
  const groups = new Map();
  for (const image of images) {
    if (!groups.has(image.groupKey)) {
      groups.set(image.groupKey, {
        groupKey: image.groupKey,
        photographer: image.category,
        month: image.month,
        role: image.role,
        count: 0,
        bestFileName: '',
        images: []
      });
    }
    const group = groups.get(image.groupKey);
    group.count += 1;
    group.images.push(image);
    if (image.isBest) group.bestFileName = image.fileName;
  }
  return Array.from(groups.values()).sort((a, b) => b.month.localeCompare(a.month) || a.photographer.localeCompare(b.photographer, 'zh-Hans-CN') || a.role.localeCompare(b.role, 'zh-Hans-CN'));
}

function parseImageName(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const parts = base.split('_');
  const category = parts[0] || '其他';
  const dateMatch = base.match(/\d{4}-\d{2}-\d{2}/);
  const monthMatch = base.match(/\d{4}-\d{2}/);
  const date = dateMatch ? dateMatch[0] : '';
  const month = date ? date.slice(0, 7) : (monthMatch ? monthMatch[0] : '未知月份');
  const role = parts.length >= 3 ? parts[2] : '未分类角色';
  return { category, date: month, month, role };
}

function listImages(options = {}) {
  const localSrc = options.localSrc === true;
  return fs.readdirSync(IMAGES_DIR)
    .filter((fileName) => imageExtensions.has(path.extname(fileName).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((fileName) => {
      const parsed = parseImageName(fileName);
      const localImageSrc = getLocalImageSrc(fileName);
      return {
        src: localSrc ? localImageSrc : getImageSrc(fileName),
        localSrc: localImageSrc,
        fileName,
        ...parsed
      };
    });
}

function nextFileName(category, date, role, ext) {
  const prefix = `${category}_${date}_${role}_`;
  const existing = fs.readdirSync(IMAGES_DIR).filter((fileName) => fileName.startsWith(prefix));
  let max = 0;
  for (const fileName of existing) {
    const stem = path.basename(fileName, path.extname(fileName));
    const number = Number(stem.slice(prefix.length));
    if (Number.isInteger(number) && number > max) max = number;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}${ext}`;
}

function parseUrlList(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  let candidates = [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) candidates = parsed.map((item) => String(item));
    } catch (error) {
      candidates = [];
    }
  }
  if (!candidates.length) {
    candidates = text.split(/[\s,]+/);
  }
  return candidates.map((item) => item.trim()).filter(Boolean);
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = new URL(url).protocol === 'http:' ? http : https;
    } catch (error) {
      reject(new Error('无效的 URL：' + url));
      return;
    }
    const request = client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadImage(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('下载失败（' + response.statusCode + '）：' + url));
        return;
      }
      const contentType = response.headers['content-type'] || '';
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType, url }));
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('下载超时：' + url)));
  });
}

function extFromUrl(url, contentType) {
  const typeMap = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif'
  };
  if (contentType && typeMap[contentType.split(';')[0].trim()]) return typeMap[contentType.split(';')[0].trim()];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (imageExtensions.has(ext)) return ext;
  } catch (error) {
    // ignore
  }
  return '.jpg';
}

function renderPublicSite(images) {
  const publicImages = images.map((image) => image.localSrc ? { ...image, fallbackSrc: image.localSrc } : image);
  const data = JSON.stringify(publicImages).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>我的摄影作品</title>
  <style>
    :root {
      --bg: #eef7ff;
      --bg-gradient:
        radial-gradient(circle at 18% -8%, rgba(159, 208, 255, 0.72), transparent 28rem),
        radial-gradient(circle at 88% 2%, rgba(255, 255, 255, 0.92), transparent 24rem),
        radial-gradient(circle at 58% 42%, rgba(185, 221, 255, 0.38), transparent 34rem),
        linear-gradient(135deg, #f8fcff 0%, #eef7ff 46%, #dceeff 100%);
      --panel: rgba(255, 255, 255, 0.58);
      --panel-strong: rgba(255, 255, 255, 0.78);
      --text: #142033;
      --muted: rgba(20, 32, 51, 0.58);
      --line: rgba(97, 140, 184, 0.2);
      --accent: #9fd0ff;
      --accent-2: #d9efff;
      --chip-bg: rgba(255, 255, 255, 0.46);
      --filters-bg: rgba(255,255,255,0.66);
      --grid-line: rgba(64, 116, 166, 0.05);
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.18);
    }

    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1018;
      --bg-gradient:
        radial-gradient(circle at 16% -10%, rgba(54, 92, 140, 0.45), transparent 30rem),
        radial-gradient(circle at 86% 4%, rgba(40, 60, 96, 0.42), transparent 26rem),
        linear-gradient(150deg, #0b1018 0%, #0e1622 52%, #070b12 100%);
      --panel: rgba(255, 255, 255, 0.06);
      --panel-strong: rgba(255, 255, 255, 0.12);
      --text: #e8eef7;
      --muted: rgba(214, 224, 238, 0.62);
      --line: rgba(150, 184, 224, 0.2);
      --accent: #4f8fd6;
      --accent-2: #2a4e78;
      --chip-bg: rgba(255, 255, 255, 0.08);
      --filters-bg: rgba(16, 22, 34, 0.72);
      --grid-line: rgba(150, 184, 224, 0.05);
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.55);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg-gradient);
      color: var(--text);
      transition: background 280ms ease, color 280ms ease;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
      background-size: 72px 72px;
      mask-image: linear-gradient(to bottom, black, transparent 78%);
    }

    .hero {
      max-width: 1240px;
      margin: 0 auto;
      padding: 28px 22px 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 28px;
      align-items: end;
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      max-width: 820px;
      font-size: clamp(24px, 4vw, 44px);
      letter-spacing: -0.075em;
      line-height: 0.86;
    }

    .subtitle {
      margin: 8px 0 0;
      max-width: 520px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .hero-card {
      min-width: 140px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(145deg, rgba(255,255,255,0.14), rgba(255,255,255,0.045));
      box-shadow: var(--shadow);
      backdrop-filter: blur(20px);
    }

    .hero-card strong {
      display: block;
      font-size: 24px;
      letter-spacing: -0.05em;
    }

    .hero-card span {
      color: var(--muted);
      font-size: 11px;
    }

    .hero-links {
      max-width: 1240px;
      margin: -4px auto 18px;
      padding: 0 22px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }

    .hero-links a, .qq-slot, .copyright {
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--chip-bg);
      color: var(--muted);
      text-decoration: none;
    }

    .filters {
      position: sticky;
      top: 0;
      z-index: 5;
      max-width: 1240px;
      margin: 0 auto 12px;
      padding: 6px 22px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      background: var(--filters-bg);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(20px);
    }

    .filter-group {
      display: grid;
      grid-template-columns: auto auto;
      gap: 6px;
      align-items: center;
    }

    .filter-title {
      padding-top: 5px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .filter-toggle {
      padding: 5px 8px;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .filter-toggle::after {
      content: " 展开";
      letter-spacing: 0;
      font-weight: 700;
      text-transform: none;
    }

    .filter-group.open .filter-toggle::after { content: " 收起"; }

    .filter-group.collapsed .chips { display: none; }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .best-toggle {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: rgba(20, 32, 51, 0.78);
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }

    .best-badge {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 3;
      padding: 4px 8px;
      border-radius: 999px;
      background: #ffd36a;
      color: #2b1a00;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }

    button {
      border: 1px solid var(--line);
      background: var(--chip-bg);
      color: var(--text);
      border-radius: 999px;
      padding: 5px 9px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: transform 160ms ease, background 160ms ease, color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
    }

    button:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
    }

    button.active {
      background: var(--accent);
      color: #07111d;
      border-color: var(--accent);
      box-shadow: 0 10px 28px rgba(185, 220, 255, 0.22);
      font-weight: 800;
    }

    .gallery {
      max-width: 1240px;
      margin: 0 auto;
      padding: 0 22px 92px;
      columns: 4 240px;
      column-gap: 12px;
    }

    .photo-card {
      position: relative;
      display: inline-block;
      width: 100%;
      margin: 0 0 12px;
      overflow: hidden;
      break-inside: avoid;
      border: 0;
      border-radius: 22px;
      background: transparent;
      box-shadow: 0 10px 30px rgba(56, 96, 140, 0.14);
      cursor: zoom-in;
      isolation: isolate;
      transition: transform 320ms ease, box-shadow 320ms ease;
    }

    .photo-card.is-landscape {
      width: 100%;
    }

    .photo-card.is-portrait {
      width: 78%;
      margin-left: 11%;
      margin-right: 11%;
    }

    .photo-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 22px 60px rgba(40, 78, 120, 0.22);
    }

    .photo-card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.72), transparent 42%);
      opacity: 0;
      transition: opacity 220ms ease;
      z-index: 1;
    }

    .photo-card img {
      display: block;
      width: 100%;
      height: auto;
      filter: saturate(0.96) contrast(1.04);
      transition: transform 320ms ease, filter 320ms ease;
    }

    .photo-card img {
      aspect-ratio: auto;
      object-fit: contain;
    }

    .photo-card:hover::after { opacity: 1; }
    .photo-card:hover img { transform: scale(1.035); filter: saturate(1.06) contrast(1.08); }

    .meta {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2;
      padding: 24px 18px 18px;
      display: grid;
      gap: 5px;
      color: rgba(255,255,255,0.72);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 220ms ease, transform 220ms ease;
    }

    .photo-card:hover .meta { opacity: 1; transform: translateY(0); }

    .meta strong {
      color: white;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    .meta span { font-size: 13px; }

    .empty {
      max-width: 1240px;
      margin: 16px auto 80px;
      padding: 0 22px;
      color: var(--muted);
      display: none;
    }

    .lightbox {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 26px;
      background: rgba(0, 0, 0, 0.9);
      z-index: 10;
      backdrop-filter: blur(16px);
    }

    .lightbox.open { display: flex; }

    .lightbox-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      max-width: min(100%, 1220px);
    }

    .lightbox img {
      max-width: 100%;
      max-height: 82vh;
      border-radius: 24px;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.72);
    }

    .lightbox-caption {
      display: flex;
      gap: 14px;
      align-items: baseline;
      color: rgba(255,255,255,0.92);
      text-align: center;
      flex-wrap: wrap;
      justify-content: center;
    }
    .lightbox-caption strong { font-size: 18px; letter-spacing: -0.01em; }
    .lightbox-caption span { color: rgba(255,255,255,0.62); font-size: 13px; }

    .lightbox button {
      position: fixed;
      background: rgba(255,255,255,0.92);
      color: #111;
      border: 0;
    }

    #closeLightbox { top: 22px; right: 22px; }
    .lightbox-nav {
      top: 50%;
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      font-size: 24px;
      transform: translateY(-50%);
    }
    #prevLightbox { left: 22px; }
    #nextLightbox { right: 22px; }

    @media (max-width: 780px) {
      .hero { grid-template-columns: 1fr; padding-top: 22px; }
      .hero-card { width: 100%; }
      .filters { padding: 6px 14px; }
      .filter-group { grid-template-columns: auto auto; gap: 5px; }
      .filter-title { padding-top: 4px; }
      .gallery { columns: 2; column-gap: 8px; padding: 0 14px 80px; }
      .photo-card { border-radius: 16px; margin-bottom: 8px; }
      .photo-card.is-landscape { width: 100%; }
      .photo-card.is-portrait { width: 90%; margin-left: 5%; margin-right: 5%; }
      .meta { position: static; opacity: 1; transform: none; padding: 10px 11px 12px; background: var(--panel); }
      .meta strong { color: var(--text); font-size: 14px; }
      .meta span { color: var(--muted); font-size: 11px; }
      .photo-card::after { display: none; }
      .lightbox-caption strong { font-size: 16px; }
    }

    @media (max-width: 460px) {
      .gallery { column-gap: 6px; padding: 0 10px 70px; }
      .photo-card { margin-bottom: 6px; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <div>
      <p class="eyebrow">Photo Archive</p>
      <h1 id="pageTitle">香菇出过的角色展示</h1>
      <p class="subtitle" id="pageSubtitle">用更沉浸的瀑布流展示香菇出过的角色，按角色、摄影师或月份快速筛选。</p>
    </div>
    <div class="hero-card">
      <strong>${images.length}</strong>
      <span>张已收录作品</span>
    </div>
  </header>

  <nav class="hero-links" aria-label="友情链接">
    <a href="https://calmdream.cn/">友情链接-宁梦</a>
    <a href="https://lx233.github.io/">友情链接-香菇猫</a>
    <!-- <a href="#">友情链接 3</a> -->
    <span class="qq-slot">QQ 扩列：3223591937</span>
    <span class="copyright">copy right by 香菇</span>
  </nav>

  <section class="filters" aria-label="图片筛选">
    <div class="filter-group">
      <div class="filter-title">摄影师</div>
      <div class="chips" id="categoryFilters"></div>
    </div>
    <div class="filter-group collapsed" id="monthFilterGroup">
      <button type="button" class="filter-title filter-toggle" id="monthToggle">月份</button>
      <div class="chips" id="monthFilters"></div>
    </div>
    <div class="filter-group collapsed" id="roleFilterGroup">
      <button type="button" class="filter-title filter-toggle" id="roleToggle">角色</button>
      <div class="chips" id="roleFilters"></div>
    </div>
    <label class="best-toggle">
      <input type="checkbox" id="bestOnly">
      单图模式
    </label>
    <button type="button" id="shuffleButton">打乱</button>
    <button type="button" id="weightSortButton">按权重</button>
    <button type="button" id="themeToggle">🌙 夜间</button>
  </section>

  <main class="gallery" id="gallery"></main>
  <p class="empty" id="empty">暂无匹配图片。</p>

  <div class="lightbox" id="lightbox" aria-hidden="true">
    <button type="button" id="closeLightbox">关闭</button>
    <button type="button" class="lightbox-nav" id="prevLightbox">‹</button>
    <div class="lightbox-stage">
      <img id="lightboxImage" alt="">
      <div class="lightbox-caption">
        <strong id="lightboxRole"></strong>
        <span id="lightboxInfo"></span>
      </div>
    </div>
    <button type="button" class="lightbox-nav" id="nextLightbox">›</button>
  </div>

  <script>
    const images = ${data};
    const filterKeys = ['category', 'month', 'role'];
    const urlParams = { category: 'photographer', month: 'month', role: 'role' };
    const rainbowPraises = ['{name}的镜头有魔法，香菇都被拍得闪闪发光。', '{name}随手一拍都是高光时刻，香菇看了直冒泡。', '构图稳、氛围甜，香菇宣布{name}这组可以循环播放。', '{name}把香菇拍出了会发光的样子。', '{name}镜头里的香菇好看到像偷偷开了滤镜外挂。', '{name}这组直接封神，香菇看一眼就血压回升。', '{name}把光影拿捏得死死的，香菇当场原地转圈。', '{name}随手一拍都是壁纸级，香菇决定全部收藏。', '{name}的氛围感拉满，香菇怀疑镜头里住了个神仙。', '{name}每张都好看到犯规，香菇已经笑出了酒窝。', '{name}的调色温柔又高级，香菇直呼这是电影质感。', '{name}抓拍稳准狠，香菇的每个瞬间都被偷偷神化了。', '{name}的审美在线到离谱，香菇感动得想发锦旗。', '{name}快门一响，香菇的颜值直接原地起飞。', '{name}构图讲究、留白高级，香菇宣布这位是宝藏摄影。', '{name}就是香菇的专属造光师，随手都能出片。', '{name}一出手，香菇的每张照片都自带柔光。', '香菇怀疑{name}的相机里偷偷装了仙气。', '{name}的取景角度刁钻又高级，香菇服气。', '在{name}镜头下，香菇连呼吸都是上镜的。', '{name}总能抓住香菇最灵的那一瞬间。', '{name}的片子有故事感，香菇看一次心动一次。', '香菇宣布：{name}的图直接进收藏夹吃灰都舍不得。', '{name}把平平无奇的日子拍成了大片，香菇感动。', '{name}的色彩高级到犯规，香菇怀疑在看画展。'];
    const state = { category: '全部', month: '全部', role: '全部', bestOnly: false, shuffle: false };
    const soulSoups = ['慢慢来，喜欢的事值得多花一点时间。', '把日子拍成喜欢的样子，就是认真生活。', '光会找到愿意等待的人。', '收藏每一个当下，未来会谢谢现在的你。', '生活不必完美，但可以足够温柔。', '你认真对待的瞬间，都会在某天发光。', '走得慢一点没关系，记得抬头看看风景。', '热爱可抵岁月漫长。', '愿你眼里有光，镜头里有爱。', '平凡的日子，也藏着不动声色的浪漫。'];
    const photographerOrder = new Map();
    let visibleImages = [];
    let currentLightboxIndex = -1;
    const pageTitle = document.getElementById('pageTitle');
    const pageSubtitle = document.getElementById('pageSubtitle');
    const gallery = document.getElementById('gallery');
    const empty = document.getElementById('empty');
    const bestOnly = document.getElementById('bestOnly');
    const monthFilterGroup = document.getElementById('monthFilterGroup');
    const monthToggle = document.getElementById('monthToggle');
    const roleFilterGroup = document.getElementById('roleFilterGroup');
    const roleToggle = document.getElementById('roleToggle');
    const shuffleButton = document.getElementById('shuffleButton');
    const weightSortButton = document.getElementById('weightSortButton');
    const lightbox = document.getElementById('lightbox');
    const lightboxImage = document.getElementById('lightboxImage');
    const lightboxRole = document.getElementById('lightboxRole');
    const lightboxInfo = document.getElementById('lightboxInfo');
    const themeToggle = document.getElementById('themeToggle');
    images.forEach((image, index) => { image._index = index; });

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      themeToggle.textContent = theme === 'dark' ? '🌙 夜间' : '☀️ 白天';
      try { localStorage.setItem('photoTheme', theme); } catch (error) { /* ignore */ }
    }

    let savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('photoTheme') || 'dark'; } catch (error) { savedTheme = 'dark'; }
    applyTheme(savedTheme);

    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });

    function assignShuffleNoise() {
      for (const image of images) {
        image._shuffleNoise = (Math.random() * 2 - 1) * ${SHUFFLE_NOISE};
      }
    }

    function getWeight(item) {
      const weight = Number(item.weight);
      return Number.isFinite(weight) ? weight : ${DEFAULT_WEIGHT};
    }

    function getImageOrientation(item) {
      const width = Number(item.width || item.naturalWidth);
      const height = Number(item.height || item.naturalHeight);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return width >= height ? 'landscape' : 'portrait';
      }
      return 'landscape';
    }

    function sortGalleryItems(items) {
      return [...items].sort((a, b) => {
        const monthCompare = String(b.month).localeCompare(String(a.month));
        if (monthCompare !== 0) return monthCompare;
        const scoreA = getWeight(a) + (state.shuffle ? a._shuffleNoise : 0);
        const scoreB = getWeight(b) + (state.shuffle ? b._shuffleNoise : 0);
        return scoreB - scoreA || a._index - b._index;
      });
    }

    function randomPraise(name) {
      const tpl = rainbowPraises[Math.floor(Math.random() * rainbowPraises.length)];
      return tpl.replace(/\{name\}/g, name || '这位摄影');
    }

    let lastSubtitleKey = null;

    function updateHeroCopy() {
      const active = filterKeys.find((key) => state[key] !== '全部');
      if (active) {
        const label = state[active];
        if (active === 'role') {
          pageTitle.textContent = '香菇出过的角色 · ' + label;
        } else if (active === 'category') {
          pageTitle.textContent = '感谢' + label + '给香菇拍摄的照片';
        } else {
          pageTitle.textContent = label + ' 的角色合集';
        }
      } else {
        pageTitle.textContent = '香菇出过的角色展示';
      }

      const subtitleKey = state.category !== '全部' ? 'photographer:' + state.category : 'default';
      if (subtitleKey === lastSubtitleKey) return;
      lastSubtitleKey = subtitleKey;
      if (state.category !== '全部') {
        pageSubtitle.textContent = randomPraise(state.category);
      } else {
        pageSubtitle.textContent = soulSoups[Math.floor(Math.random() * soulSoups.length)];
      }
    }

    function updateSortButtons() {
      shuffleButton.className = state.shuffle ? 'active' : '';
      weightSortButton.className = state.shuffle ? '' : 'active';
    }

    assignShuffleNoise();

    function uniqueValues(key) {
      if (key === 'category') {
        const counts = new Map();
        for (const image of images) {
          if (image.category) counts.set(image.category, (counts.get(image.category) || 0) + 1);
        }
        const photographers = Array.from(counts.entries()).filter(([, count]) => count >= 3).map(([value]) => value);
        for (const photographer of photographers) {
          if (!photographerOrder.has(photographer)) photographerOrder.set(photographer, Math.random());
        }
        return ['全部', ...photographers.sort((a, b) => photographerOrder.get(a) - photographerOrder.get(b))];
      }
      return ['全部', ...Array.from(new Set(images.map((item) => item[key]).filter(Boolean))).sort((a, b) => b.localeCompare(a, 'zh-Hans-CN'))];
    }

    function renderFilters(containerId, key) {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      for (const value of uniqueValues(key)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = value;
        button.className = state[key] === value ? 'active' : '';
        button.addEventListener('click', () => {
          if (state[key] === value) {
            state[key] = '全部';
          } else {
            for (const otherKey of filterKeys) {
              state[otherKey] = otherKey === key ? value : '全部';
            }
          }
          syncUrl();
          renderAll();
        });
        container.appendChild(button);
      }
    }

    function readStateFromUrl() {
      const params = new URLSearchParams(window.location.search);
      for (const key of filterKeys) {
        const value = params.get(urlParams[key]) || params.get(key);
        if (value && uniqueValues(key).includes(value)) state[key] = value;
      }
      state.bestOnly = params.get('best') === '1';
      state.shuffle = params.get('shuffle') === '1';
      bestOnly.checked = state.bestOnly;
      updateSortButtons();
    }

    function syncUrl() {
      const params = new URLSearchParams(window.location.search);
      for (const key of filterKeys) {
        const param = urlParams[key];
        params.delete(key);
        if (state[key] === '全部') {
          params.delete(param);
        } else {
          params.set(param, state[key]);
        }
      }
      if (state.bestOnly) {
        params.set('best', '1');
      } else {
        params.delete('best');
      }
      if (state.shuffle) {
        params.set('shuffle', '1');
      } else {
        params.delete('shuffle');
      }
      params.delete('composition');
      const query = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    }

    function matches(item) {
      return (state.category === '全部' || item.category === state.category)
        && (state.month === '全部' || item.month === state.month)
        && (state.role === '全部' || item.role === state.role)
        && (!state.bestOnly || item.isBest);
    }

    function renderGallery() {
      visibleImages = sortGalleryItems(images.filter(matches));
      gallery.innerHTML = '';
      empty.style.display = visibleImages.length ? 'none' : 'block';
      for (const item of visibleImages) {
        const card = document.createElement('article');
        const syncCardOrientation = () => {
          const orientation = getImageOrientation(item);
          card.className = 'photo-card is-' + orientation;
        };
        syncCardOrientation();
        const image = document.createElement('img');
        image.loading = 'lazy';
        image.addEventListener('load', () => {
          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!width || !height || (item.naturalWidth === width && item.naturalHeight === height)) return;
          item.naturalWidth = width;
          item.naturalHeight = height;
          syncCardOrientation();
        });
        image.src = item.src;
        if (item.fallbackSrc) {
          image.addEventListener('error', () => {
            if (image.src !== new URL(item.fallbackSrc, window.location.href).href) image.src = item.fallbackSrc;
          }, { once: true });
        }
        image.alt = item.fileName;

        const meta = document.createElement('div');
        meta.className = 'meta';
        const title = document.createElement('strong');
        title.textContent = item.role;
        const detail = document.createElement('span');
        detail.textContent = item.category + ' · ' + item.month;
        meta.append(title, detail);

        card.append(image, meta);
        card.addEventListener('click', () => {
          openLightbox(visibleImages.indexOf(item));
        });
        gallery.appendChild(card);
      }
    }

    function openLightbox(index) {
      if (!visibleImages.length) return;
      currentLightboxIndex = (index + visibleImages.length) % visibleImages.length;
      const item = visibleImages[currentLightboxIndex];
      lightboxImage.onerror = item.fallbackSrc ? () => {
        lightboxImage.onerror = null;
        lightboxImage.src = item.fallbackSrc;
      } : null;
      lightboxImage.src = item.src;
      lightboxImage.alt = item.fileName;
      lightboxRole.textContent = item.role;
      lightboxInfo.textContent = '摄影：' + item.category + ' · ' + item.month;
      lightbox.classList.add('open');
      lightbox.setAttribute('aria-hidden', 'false');
    }

    function moveLightbox(step) {
      if (!lightbox.classList.contains('open')) return;
      openLightbox(currentLightboxIndex + step);
    }

    function renderAll() {
      renderFilters('categoryFilters', 'category');
      renderFilters('monthFilters', 'month');
      renderFilters('roleFilters', 'role');
      if (state.month !== '全部') monthFilterGroup.classList.add('open');
      if (state.role !== '全部') roleFilterGroup.classList.add('open');
      monthFilterGroup.classList.toggle('collapsed', !monthFilterGroup.classList.contains('open'));
      roleFilterGroup.classList.toggle('collapsed', !roleFilterGroup.classList.contains('open'));
      updateHeroCopy();
      updateSortButtons();
      renderGallery();
    }

    document.getElementById('closeLightbox').addEventListener('click', () => {
      lightbox.classList.remove('open');
      lightbox.setAttribute('aria-hidden', 'true');
      lightboxImage.removeAttribute('src');
      currentLightboxIndex = -1;
    });

    document.getElementById('prevLightbox').addEventListener('click', (event) => {
      event.stopPropagation();
      moveLightbox(-1);
    });

    document.getElementById('nextLightbox').addEventListener('click', (event) => {
      event.stopPropagation();
      moveLightbox(1);
    });

    monthToggle.addEventListener('click', () => {
      monthFilterGroup.classList.toggle('open');
      monthFilterGroup.classList.toggle('collapsed', !monthFilterGroup.classList.contains('open'));
    });

    roleToggle.addEventListener('click', () => {
      roleFilterGroup.classList.toggle('open');
      roleFilterGroup.classList.toggle('collapsed', !roleFilterGroup.classList.contains('open'));
    });

    bestOnly.addEventListener('change', () => {
      state.bestOnly = bestOnly.checked;
      syncUrl();
      renderGallery();
    });

    shuffleButton.addEventListener('click', () => {
      state.shuffle = true;
      assignShuffleNoise();
      syncUrl();
      updateSortButtons();
      renderGallery();
    });

    weightSortButton.addEventListener('click', () => {
      state.shuffle = false;
      syncUrl();
      updateSortButtons();
      renderGallery();
    });

    lightbox.addEventListener('click', (event) => {
      if (event.target === lightbox) document.getElementById('closeLightbox').click();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') document.getElementById('closeLightbox').click();
      if (event.key === 'ArrowLeft') moveLightbox(-1);
      if (event.key === 'ArrowRight') moveLightbox(1);
      if (event.key === 'ArrowLeft') moveLightbox(-1);
      if (event.key === 'ArrowRight') moveLightbox(1);
    });

    readStateFromUrl();
    renderAll();
  </script>
</body>
</html>`;
}

function renderAdminPage() {
  const photographerCounts = new Map();
  for (const image of getAllImages(readMetadata())) {
    photographerCounts.set(image.category, (photographerCounts.get(image.category) || 0) + 1);
  }
  const photographerOptions = Array.from(photographerCounts.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([photographer]) => `            <option value="${escapeHtml(photographer)}"></option>`)
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>图片管理后台</title>
  <style>
    :root {
      --bg: #0b0d12;
      --card: rgba(255, 255, 255, 0.88);
      --text: #171923;
      --muted: #6b7280;
      --accent: #111827;
      --accent-2: #d9a84e;
      --line: rgba(17, 24, 39, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 8%, rgba(217, 168, 78, 0.3), transparent 24rem),
        radial-gradient(circle at 82% 18%, rgba(111, 168, 255, 0.26), transparent 26rem),
        linear-gradient(135deg, #0b0d12, #171923 58%, #090a0d);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
      background-size: 64px 64px;
      mask-image: linear-gradient(to bottom, black, transparent 76%);
    }
    main {
      position: relative;
      max-width: 980px;
      margin: 0 auto;
      padding: 56px 22px;
    }
    .admin-shell {
      display: grid;
      grid-template-columns: 0.9fr 1.25fr;
      gap: 22px;
      align-items: start;
    }
    .intro, form {
      border: 1px solid rgba(255, 255, 255, 0.52);
      border-radius: 32px;
      background: var(--card);
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(22px);
    }
    .intro {
      padding: 30px;
      color: #f9fafb;
      background: linear-gradient(155deg, rgba(255,255,255,0.18), rgba(255,255,255,0.06));
      border-color: rgba(255,255,255,0.18);
      position: sticky;
      top: 24px;
    }
    .eyebrow {
      margin: 0 0 18px;
      color: var(--accent-2);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(38px, 5vw, 64px);
      line-height: 0.92;
      letter-spacing: -0.07em;
    }
    p { color: rgba(249, 250, 251, 0.68); line-height: 1.75; }
    .steps {
      margin-top: 28px;
      display: grid;
      gap: 10px;
      color: rgba(249, 250, 251, 0.78);
      font-size: 14px;
    }
    .step {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.1);
    }
    form {
      padding: 26px;
      display: grid;
      gap: 18px;
    }
    label {
      display: grid;
      gap: 9px;
      color: #1f2937;
      font-size: 14px;
      font-weight: 800;
    }
    input, button, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 13px 15px;
      font: inherit;
      background: rgba(255,255,255,0.78);
      color: var(--text);
      outline: none;
      transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    textarea { resize: vertical; min-height: 90px; line-height: 1.5; }
    input:focus, textarea:focus {
      border-color: rgba(217, 168, 78, 0.85);
      box-shadow: 0 0 0 4px rgba(217, 168, 78, 0.18);
    }
    input[type="file"] {
      padding: 18px;
      border-style: dashed;
      background: rgba(17,24,39,0.035);
    }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    button {
      border: 0;
      min-height: 52px;
      background: linear-gradient(135deg, #111827, #303846);
      color: white;
      cursor: pointer;
      font-weight: 900;
      box-shadow: 0 16px 34px rgba(17, 24, 39, 0.24);
    }
    button:hover { transform: translateY(-1px); }
    .hint, #result {
      padding: 14px 16px;
      border-radius: 18px;
      background: rgba(17, 24, 39, 0.055);
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
      white-space: pre-wrap;
    }
    #preview { color: #374151; }
    a { color: #111827; font-weight: 900; }
    .manager {
      margin-top: 24px;
      padding: 26px;
      border: 1px solid rgba(255, 255, 255, 0.52);
      border-radius: 32px;
      background: var(--card);
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.35);
    }
    .manager h2 { margin: 0 0 8px; }
    .manager p { margin: 0 0 18px; color: var(--muted); }
    .group-card {
      margin-top: 16px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(255,255,255,0.58);
    }
    .group-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
      color: #1f2937;
      font-weight: 900;
    }
    .group-head span { color: var(--muted); font-size: 13px; font-weight: 700; }
    .edit-toggle { flex: 0 0 auto; width: auto; min-height: 0; padding: 5px 12px; font-size: 12px; border-radius: 999px; white-space: nowrap; }
    .edit-toggle.active { background: linear-gradient(135deg, #111827, #303846); color: #fff; }
    .edit-grid, .weight-label { display: none; }
    .group-card.editing .edit-grid { display: grid; }
    .group-card.editing .weight-label { display: grid; }
    .thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .thumb-card {
      position: relative;
      display: grid;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: white;
    }
    .thumb-card img {
      width: 100%;
      aspect-ratio: 1;
      object-fit: cover;
      border-radius: 12px;
      background: #eef2f7;
    }
    .thumb-card .best-tag {
      position: absolute;
      top: 12px;
      left: 12px;
      z-index: 2;
      padding: 3px 8px;
      border-radius: 999px;
      background: linear-gradient(135deg, #d9a84e, #f7cf74);
      color: #221400;
      font-size: 11px;
      font-weight: 900;
      box-shadow: 0 4px 12px rgba(217, 168, 78, 0.4);
    }
    .thumb-actions { display: flex; gap: 8px; }
    .thumb-actions button { flex: 1; }
    .edit-grid { gap: 6px; }
    .group-card.editing .edit-grid { display: grid; }
    .edit-grid label { display: grid; gap: 3px; font-size: 11px; font-weight: 700; color: var(--muted); }
    .edit-grid input { min-height: 32px; padding: 6px 8px; font-size: 12px; border-radius: 10px; }
    .edit-grid button { min-height: 32px; font-size: 12px; }
    .thumb-card button { min-height: 36px; padding: 8px 10px; font-size: 12px; }
    .thumb-card button.best { background: linear-gradient(135deg, #d9a84e, #f7cf74); color: #221400; }
    .thumb-card button.danger { background: linear-gradient(135deg, #c0392b, #e74c3c); color: #fff; }
    .thumb-card small { color: var(--muted); word-break: break-all; }
    .upload-tabs { display: flex; gap: 8px; margin-bottom: 4px; }
    .upload-tabs button {
      flex: 1;
      min-height: 42px;
      border-radius: 14px;
      background: rgba(17,24,39,0.06);
      color: #374151;
      font-weight: 800;
    }
    .upload-tabs button.active { background: linear-gradient(135deg, #111827, #303846); color: #fff; }
    .upload-pane { display: none; }
    .upload-pane.active { display: block; }
    @media (max-width: 860px) {
      main { padding-top: 28px; }
      .admin-shell { grid-template-columns: 1fr; }
      .intro { position: static; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="admin-shell">
      <section class="intro">
        <p class="eyebrow">Local Publisher</p>
        <h1>图片管理后台</h1>
        <p>在本地整理照片信息，点击 OK 后自动重命名、归档到 images，并重新生成可部署的静态相册。</p>
        <div class="steps">
          <div class="step">01 选择一组图片</div>
          <div class="step">02 填写月份、摄影师和角色</div>
          <div class="step">03 生成新的公共页面</div>
        </div>
      </section>
      <form id="uploadForm">
      <div class="upload-tabs">
        <button type="button" id="tabFile" class="active">本地文件</button>
        <button type="button" id="tabUrl">图片 URL</button>
      </div>
      <div class="upload-pane active" id="paneFile">
        <label>
          图片文件
          <input name="photos" id="photos" type="file" accept="image/*" multiple>
        </label>
      </div>
      <div class="upload-pane" id="paneUrl">
        <label>
          图片 URL（可批量）
          <textarea name="urls" id="urls" rows="4" placeholder='支持多种写法，自动分割：&#10;1) 每行一个 URL&#10;2) 逗号分隔：https://a.com/1.jpg, https://a.com/2.jpg&#10;3) JSON 数组：["https://a.com/1.jpg","https://a.com/2.jpg"]'></textarea>
        </label>
      </div>
      <div class="grid">
        <label>
          月份
          <input name="month" id="month" type="month" required>
        </label>
        <label>
          摄影师
          <input name="category" id="category" list="categoryList" placeholder="摄影师姓名" required>
          <datalist id="categoryList">
${photographerOptions}
          </datalist>
        </label>
        <label>
          角色
          <input name="role" id="role" list="roleList" placeholder="无角色" required>
          <datalist id="roleList">
            <option value="无角色"></option>
            <option value="朋友"></option>
            <option value="家人"></option>
            <option value="模特"></option>
          </datalist>
        </label>
      </div>
      <div id="preview" class="hint">命名格式：摄影师_月份_角色_001.jpg</div>
      <button type="submit">OK，导入图片并重新生成页面</button>
      <div id="result"></div>
      </form>
    </div>
    <section class="manager">
      <h2>全部图片管理 <a href="/admin/logout" style="float:right;font-size:13px;font-weight:700;color:#c0392b;">退出登录</a></h2>
      <p>同一摄影师、同一月份、同一角色会归为同一组图；每组只能有一张 best。</p>
      <div id="imageManager" class="hint">正在加载图片...</div>
    </section>
  </main>
  <script>
    const form = document.getElementById('uploadForm');
    const result = document.getElementById('result');
    const preview = document.getElementById('preview');
    const month = document.getElementById('month');
    const category = document.getElementById('category');
    const role = document.getElementById('role');
    const photos = document.getElementById('photos');
    const imageManager = document.getElementById('imageManager');
    const tabFile = document.getElementById('tabFile');
    const tabUrl = document.getElementById('tabUrl');
    const paneFile = document.getElementById('paneFile');
    const paneUrl = document.getElementById('paneUrl');

    function switchTab(tab) {
      const isFile = tab === 'file';
      tabFile.classList.toggle('active', isFile);
      tabUrl.classList.toggle('active', !isFile);
      paneFile.classList.toggle('active', isFile);
      paneUrl.classList.toggle('active', !isFile);
    }
    tabFile.addEventListener('click', () => switchTab('file'));
    tabUrl.addEventListener('click', () => switchTab('url'));

    month.value = new Date().toISOString().slice(0, 7);

    function clean(value, fallback) {
      return (value || fallback).trim().replace(/[\\/\\0_\\s]+/g, '-').replace(/[<>:"|?*]/g, '').slice(0, 40) || fallback;
    }

    function updatePreview() {
      const file = photos.files[0];
      const ext = file ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '.jpg';
      preview.textContent = '示例文件名：' + clean(category.value, '摄影师') + '_' + (month.value || new Date().toISOString().slice(0, 7)) + '_' + clean(role.value, '无角色') + '_001' + ext;
    }

    async function loadImageManager() {
      imageManager.textContent = '正在加载图片...';
      const response = await fetch('/api/images');
      if (response.status === 401) {
        window.location.href = '/admin/login';
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        imageManager.textContent = data.error || '加载失败';
        return;
      }
      imageManager.className = '';
      imageManager.innerHTML = '';
      if (!data.groups.length) {
        imageManager.className = 'hint';
        imageManager.textContent = '暂无图片。';
        return;
      }
      for (const group of data.groups) {
        const groupCard = document.createElement('section');
        groupCard.className = 'group-card';
        const head = document.createElement('div');
        head.className = 'group-head';
        const title = document.createElement('div');
        title.textContent = group.photographer + ' / ' + group.month + ' / ' + group.role;
        const meta = document.createElement('span');
        meta.textContent = '共 ' + group.count + ' 张' + (group.bestFileName ? '，best：' + group.bestFileName : '，未设置 best');
        const editToggle = document.createElement('button');
        editToggle.type = 'button';
        editToggle.className = 'edit-toggle';
        editToggle.textContent = '✎ 编辑';
        editToggle.addEventListener('click', () => {
          const editing = groupCard.classList.toggle('editing');
          editToggle.textContent = editing ? '✕ 完成' : '✎ 编辑';
          editToggle.classList.toggle('active', editing);
        });
        head.append(title, meta, editToggle);
        const grid = document.createElement('div');
        grid.className = 'thumb-grid';
        for (const item of group.images) {
          const card = document.createElement('div');
          card.className = 'thumb-card';
          const img = document.createElement('img');
          img.src = item.src;
          if (item.localSrc) {
            img.addEventListener('error', () => {
              if (img.src !== new URL(item.localSrc, window.location.href).href) img.src = item.localSrc;
            }, { once: true });
          }
          img.alt = item.fileName;
          if (item.isBest) {
            const bestTag = document.createElement('div');
            bestTag.className = 'best-tag';
            bestTag.textContent = 'BEST';
            card.appendChild(bestTag);
          }
          const name = document.createElement('small');
          name.textContent = item.fileName;
          const editGrid = document.createElement('div');
          editGrid.className = 'edit-grid';
          const catLabel = document.createElement('label');
          catLabel.textContent = '摄影';
          const catInput = document.createElement('input');
          catInput.type = 'text';
          catInput.value = item.category;
          catLabel.appendChild(catInput);
          const roleLabel = document.createElement('label');
          roleLabel.textContent = '角色';
          const roleInput = document.createElement('input');
          roleInput.type = 'text';
          roleInput.value = item.role;
          roleLabel.appendChild(roleInput);
          const monthLabel = document.createElement('label');
          monthLabel.textContent = '月份';
          const monthInput = document.createElement('input');
          monthInput.type = 'month';
          monthInput.value = item.month;
          monthLabel.appendChild(monthInput);
          const saveButton = document.createElement('button');
          saveButton.type = 'button';
          saveButton.textContent = '保存信息';
          saveButton.addEventListener('click', async () => {
            const result = await fetch('/api/image', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id, category: catInput.value, role: roleInput.value, month: monthInput.value })
            });
            if (!result.ok) {
              const error = await result.json();
              alert(error.error || '保存失败');
              return;
            }
            await loadImageManager();
          });
          editGrid.append(catLabel, roleLabel, monthLabel, saveButton);
          const weightLabel = document.createElement('label');
          weightLabel.className = 'weight-label';
          weightLabel.textContent = '权重';
          const weightInput = document.createElement('input');
          weightInput.type = 'number';
          weightInput.min = '0';
          weightInput.max = '999';
          weightInput.step = '1';
          weightInput.value = item.weight;
          weightInput.addEventListener('change', async () => {
            const result = await fetch('/api/weight', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id, weight: weightInput.value })
            });
            if (!result.ok) {
              const error = await result.json();
              alert(error.error || '保存权重失败');
              return;
            }
            await loadImageManager();
          });
          weightLabel.appendChild(weightInput);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = item.isBest ? 'best' : '';
          button.textContent = item.isBest ? '取消 best' : '设为 best';
          button.addEventListener('click', async () => {
            const method = item.isBest ? 'DELETE' : 'POST';
            const result = await fetch('/api/best', {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id })
            });
            if (!result.ok) {
              const error = await result.json();
              alert(error.error || '操作失败');
              return;
            }
            await loadImageManager();
          });
          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.className = 'danger';
          deleteButton.textContent = '删除';
          deleteButton.addEventListener('click', async () => {
            if (!confirm('确定删除 ' + item.fileName + ' 吗？此操作不可恢复。')) return;
            const result = await fetch('/api/image', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id })
            });
            if (!result.ok) {
              const error = await result.json();
              alert(error.error || '删除失败');
              return;
            }
            await loadImageManager();
          });
          const actions = document.createElement('div');
          actions.className = 'thumb-actions';
          actions.append(button, deleteButton);
          card.append(img, name, editGrid, weightLabel, actions);
          grid.appendChild(card);
        }
        groupCard.append(head, grid);
        imageManager.appendChild(groupCard);
      }
    }

    form.addEventListener('input', updatePreview);
    updatePreview();
    loadImageManager();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const urls = document.getElementById('urls').value.trim();
      if (!photos.files.length && !urls) {
        result.textContent = '请选择图片文件或填写图片 URL。';
        return;
      }
      result.textContent = '正在处理...';
      const body = new FormData(form);
      const response = await fetch('/api/upload', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) {
        result.textContent = data.error || '处理失败';
        return;
      }
      let summary = '已导入 ' + data.files.length + ' 张图片，并重新生成 index.html：\\n' + data.files.join('\\n');
      if (data.errors && data.errors.length) {
        summary += '\\n\\n以下未导入：\\n' + data.errors.join('\\n');
      }
      result.textContent = summary;
      const link = document.createElement('a');
      link.href = '/';
      link.target = '_blank';
      link.textContent = '打开生成后的页面';
      result.append(document.createElement('br'), document.createElement('br'), link);
      form.reset();
      month.value = new Date().toISOString().slice(0, 7);
      updatePreview();
      loadImageManager();
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getEnrichedImages() {
  const meta = readMetadata();
  return enrichImagesWithMetadata(getAllImages(meta), meta);
}

function generateSite() {
  const images = getEnrichedImages();
  fs.writeFileSync(INDEX_FILE, renderPublicSite(images));
  return images;
}

app.use('/images', express.static(IMAGES_DIR));

function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === 'admin_token=' + ADMIN_TOKEN);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: '请先登录后台。' });
}

function renderLoginPage(failed) {
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>后台登录</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:linear-gradient(150deg,#0b1018,#0e1622 52%,#070b12); color:#e8eef7; font-family: ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
    form { width:min(92vw,360px); padding:30px; border:1px solid rgba(150,184,224,0.2); border-radius:24px; background:rgba(255,255,255,0.06); box-shadow:0 28px 80px rgba(0,0,0,0.55); }
    h1 { margin:0 0 6px; font-size:22px; }
    p { margin:0 0 18px; color:rgba(214,224,238,0.62); font-size:14px; }
    label { display:block; font-size:13px; font-weight:700; margin-bottom:8px; }
    input { width:100%; padding:13px 15px; border-radius:14px; border:1px solid rgba(150,184,224,0.2); background:rgba(255,255,255,0.08); color:#e8eef7; font:inherit; outline:none; }
    input:focus { border-color:#4f8fd6; box-shadow:0 0 0 4px rgba(79,143,214,0.18); }
    button { width:100%; margin-top:16px; padding:13px; border:0; border-radius:14px; background:linear-gradient(135deg,#4f8fd6,#2a4e78); color:#fff; font-weight:800; cursor:pointer; }
    .err { color:#ff8a8a; font-size:13px; margin-top:12px; ${failed ? '' : 'display:none;'} }
  </style>
</head>
<body>
  <form method="POST" action="/admin/login">
    <h1>后台登录</h1>
    <p>${escapeHtml(ADMIN_QUESTION)}</p>
    <label>答案</label>
    <input name="answer" type="text" autocomplete="off" autofocus required>
    <button type="submit">进入后台</button>
    <div class="err">答案不对，再想想～</div>
  </form>
</body>
</html>`;
}

app.get('/admin/login', (req, res) => {
  if (isAuthed(req)) {
    res.redirect('/admin');
    return;
  }
  res.type('html').send(renderLoginPage(req.query.failed === '1'));
});

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const answer = String(req.body.answer || '').trim();
  if (answer === ADMIN_ANSWER) {
    res.setHeader('Set-Cookie', 'admin_token=' + ADMIN_TOKEN + '; Path=/; Max-Age=2592000; SameSite=Lax');
    res.redirect('/admin');
    return;
  }
  res.redirect('/admin/login?failed=1');
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/admin/login');
});

app.get('/', (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get('/admin', (req, res) => {
  if (!isAuthed(req)) {
    res.redirect('/admin/login');
    return;
  }
  res.type('html').send(renderAdminPage());
});

app.get('/api/images', requireAuth, (req, res) => {
  const meta = readMetadata();
  const images = enrichImagesWithMetadata(getAllImages(meta), meta);
  res.json({ images, groups: groupImages(images) });
});

function findImageById(id, meta = readMetadata()) {
  return getAllImages(meta).find((item) => item.id === id);
}

app.post('/api/weight', requireAuth, (req, res) => {
  const id = req.body.id || req.body.fileName;
  const meta = readMetadata();
  const image = findImageById(id, meta);
  if (!image) {
    res.status(404).json({ error: '图片不存在。' });
    return;
  }
  const rawWeight = Number(req.body.weight);
  if (!Number.isFinite(rawWeight)) {
    res.status(400).json({ error: '权重必须是数字。' });
    return;
  }
  const weight = normalizeWeight(rawWeight);
  if (weight === DEFAULT_WEIGHT) {
    delete meta.weightByFile[image.id];
  } else {
    meta.weightByFile[image.id] = weight;
  }
  writeMetadata(meta);
  generateSite();
  res.json({ ok: true, id: image.id, weight });
});

app.post('/api/best', requireAuth, (req, res) => {
  const id = req.body.id || req.body.fileName;
  const meta = readMetadata();
  const image = findImageById(id, meta);
  if (!image) {
    res.status(404).json({ error: '图片不存在。' });
    return;
  }
  meta.bestByGroup[getGroupKey(image)] = image.id;
  writeMetadata(meta);
  generateSite();
  res.json({ ok: true, id: image.id });
});

app.delete('/api/best', requireAuth, (req, res) => {
  const id = req.body.id || req.body.fileName;
  const meta = readMetadata();
  const image = findImageById(id, meta);
  if (!image) {
    res.status(404).json({ error: '图片不存在。' });
    return;
  }
  const groupKey = getGroupKey(image);
  if (meta.bestByGroup[groupKey] === image.id) delete meta.bestByGroup[groupKey];
  writeMetadata(meta);
  generateSite();
  res.json({ ok: true, groupKey });
});

app.delete('/api/image', requireAuth, (req, res) => {
  const id = req.body.id || req.body.fileName;
  const meta = readMetadata();
  const image = findImageById(id, meta);
  if (!image) {
    res.status(404).json({ error: '图片不存在。' });
    return;
  }
  meta.images = normalizeMetaImages(meta).filter((item) => (item.id || item.fileName || item.url) !== image.id);
  meta.externalImages = (meta.externalImages || []).filter((item) => item.id !== image.id);
  const deletedLocalFile = deleteLocalImageIfExists(image);
  const groupKey = getGroupKey(image);
  if (meta.bestByGroup[groupKey] === image.id) delete meta.bestByGroup[groupKey];
  delete meta.weightByFile[image.id];
  writeMetadata(meta);
  generateSite();
  res.json({ ok: true, id: image.id, deletedLocalFile });
});

app.patch('/api/image', requireAuth, (req, res) => {
  const id = req.body.id || req.body.fileName;
  const meta = readMetadata();
  const image = findImageById(id, meta);
  if (!image) {
    res.status(404).json({ error: '图片不存在。' });
    return;
  }
  const month = normalizeMonth(req.body.month || image.month);
  const category = normalizePart(req.body.category, image.category);
  const role = normalizePart(req.body.role, image.role);
  const oldGroupKey = getGroupKey(image);
  const newGroupKey = getGroupKey({ category, month, role });
  const wasBest = meta.bestByGroup[oldGroupKey] === image.id;

  meta.images = normalizeMetaImages(meta).map((item) => {
    const itemId = item.id || item.fileName || item.url;
    if (itemId !== image.id) return item;
    return { ...item, category, month, date: month, role };
  });
  const entry = (meta.externalImages || []).find((item) => item.id === image.id);
  if (entry) { entry.category = category; entry.month = month; entry.role = role; }
  if (wasBest) { delete meta.bestByGroup[oldGroupKey]; meta.bestByGroup[newGroupKey] = image.id; }
  writeMetadata(meta);
  generateSite();
  res.json({ ok: true, id: image.id });
});

app.post('/api/upload', requireAuth, upload.array('photos'), async (req, res) => {
  const files = req.files || [];
  const urls = parseUrlList(req.body.urls);
  if (!files.length && !urls.length) {
    res.status(400).json({ error: '请选择图片文件或填写图片 URL。' });
    return;
  }

  const month = normalizeMonth(req.body.month || req.body.date);
  const category = normalizePart(req.body.category, '未知摄影师');
  const role = normalizePart(req.body.role, '无角色');
  const saved = [];
  const errors = [];

  const meta = readMetadata();
  meta.images = normalizeMetaImages(meta);
  meta.externalImages = [];
  if (!Number.isInteger(meta.nextExternalId)) meta.nextExternalId = 1;

  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = nextFileName(category, month, role, ext);
    fs.writeFileSync(path.join(IMAGES_DIR, fileName), file.buffer);
    meta.images.push({
      id: fileName,
      src: getImageSrc(fileName),
      localSrc: getLocalImageSrc(fileName),
      fileName,
      category,
      month,
      date: month,
      role
    });
    saved.push(fileName);
  }

  for (const url of urls) {
    let downloaded;
    try {
      // eslint-disable-next-line no-new
      new URL(url);
      downloaded = await downloadImage(url);
    } catch (error) {
      errors.push((error && error.message) ? error.message : '下载失败：' + url);
      continue;
    }
    const ext = extFromUrl(downloaded.url, downloaded.contentType);
    const fileName = nextFileName(category, month, role, ext);
    fs.writeFileSync(path.join(IMAGES_DIR, fileName), downloaded.buffer);
    meta.images.push({
      id: fileName,
      src: getImageSrc(fileName),
      localSrc: getLocalImageSrc(fileName),
      fileName,
      category,
      month,
      date: month,
      role
    });
    saved.push(fileName);
  }
  writeMetadata(meta);

  if (!saved.length) {
    res.status(400).json({ error: errors.join('\n') || '没有成功导入的图片。' });
    return;
  }

  generateSite();
  res.json({ files: saved, errors });
});

migrateMetadataImages();
generateSite();

app.listen(PORT, () => {
  console.log(`图片管理后台：http://localhost:${PORT}/admin`);
  console.log(`静态相册页面：http://localhost:${PORT}/`);
});
