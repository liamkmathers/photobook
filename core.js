// Layout geometry + lossless PDF builder. No DOM access, so it also runs in Node for tests.
(function (root) {
  'use strict';

  const MM = 72 / 25.4;
  const PAPERS = {
    A4: [595.28, 841.89],
    Letter: [612, 792],
    A5: [419.53, 595.28],
    A3: [841.89, 1190.55],
  };

  // Classic one-sheet zine imposition, landscape 4x2, sheet positions left->right, top->bottom.
  // Top row prints upside down so it reads correctly once folded.
  const ZINE_PAGES = [5, 4, 3, 2, 6, 7, 8, 1];
  // Facing pages. Each pair is side by side on the printed sheet, so one photo can span the fold.
  const ZINE_SPREADS = [[2, 3], [4, 5], [6, 7]];
  const spreadKey = (sp) => sp.join("");

  // `file` fonts are bundled TTFs (Google Fonts, OFL) embedded into the PDF; the rest are PDF built-ins.
  // `hidden` entries only exist so older project files still open.
  const FONTS = {
    Helvetica: { pdf: 'Helvetica', css: 'Helvetica, Arial, sans-serif' },
    'Archivo Black': { file: 'archivo-black.ttf' },
    'Barlow Condensed': { file: 'barlow-condensed.ttf' },
    Coda: { file: 'coda.ttf' },
    'Courier Prime': { file: 'courier-prime.ttf' },
    Cutive: { file: 'cutive.ttf' },
    Jost: { file: 'jost.ttf' },
    Oswald: { file: 'oswald.ttf' },
    'Playfair Display': { file: 'playfair-display.ttf' },
    'Press Start 2P': { file: 'press-start-2p.ttf' },
    'Special Elite': { file: 'special-elite.ttf' },
    Syncopate: { file: 'syncopate.ttf' },
    'Times-Roman': { pdf: 'Times-Roman', css: '"Times New Roman", Times, serif' },
    'Helvetica-Bold': { pdf: 'Helvetica-Bold', css: 'Helvetica, Arial, sans-serif', weight: '700', hidden: true },
    'Times-Italic': { pdf: 'Times-Italic', css: '"Times New Roman", Times, serif', style: 'italic', hidden: true },
    Courier: { pdf: 'Courier', css: '"Courier New", Courier, monospace', hidden: true },
  };
  for (const [name, f] of Object.entries(FONTS)) {
    f.css = f.css || `"PB ${name}"`; // bundled fonts are registered under a prefixed family name
    f.weight = f.weight || '400';
    f.style = f.style || 'normal';
  }

  // EXIF orientation -> affine taking the stored image's unit square (v up) to the
  // upright displayed unit square (v up). [a,b,c,d,e,f]: x = a*u + c*v + e, y = b*u + d*v + f.
  const ORIENT = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, 1, 0],
    3: [-1, 0, 0, -1, 1, 1],
    4: [1, 0, 0, -1, 0, 1],
    5: [0, -1, -1, 0, 1, 1],
    6: [0, -1, 1, 0, 0, 1],
    7: [0, 1, 1, 0, 0, 0],
    8: [0, 1, -1, 0, 1, 0],
  };

  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const T = (x, y) => [1, 0, 0, 1, x, y];
  const S = (x, y) => [x, 0, 0, y, 0, 0];
  const R = (deg) => {
    const k = ((deg / 90) % 4 + 4) % 4;
    const c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
    return [c, s, -s, c, 0, 0];
  };

  function newCell() {
    return {
      img: null, fit: 'cover', zoom: 1, panX: 0, panY: 0, rotate: 0, pad: 0, bg: '',
      caption: '', capPos: 'below', capFont: 'Helvetica', capSize: 9, capColor: '#111111', capAlign: 'center',
      overlay: 0, overlayColor: '#000000',
    };
  }

  const PRESETS = {
    full: { label: 'Full page', rows: 1, cols: 1 },
    vsplit: { label: 'Split vertically', rows: 1, cols: 2 },
    hsplit: { label: 'Split horizontally', rows: 2, cols: 1 },
    quad: { label: 'Quadrants', rows: 2, cols: 2 },
    six: { label: '2 × 3', rows: 3, cols: 2 },
    nine: { label: '3 × 3', rows: 3, cols: 3 },
    zine: { label: '8-page fold zine', rows: 2, cols: 4 },
    saddle: { label: 'Fold & staple book', rows: 1, cols: 1 },
  };

  function newSheet(preset) {
    const s = {
      mode: 'grid', orientation: 'portrait', rows: 2, cols: 2, colRatios: '', rowRatios: '',
      margin: 0, gutter: 0, guides: false, cells: [],
    };
    applyPreset(s, preset || 'quad');
    return s;
  }

  function applyPreset(s, key) {
    const p = PRESETS[key];
    if (key === 'saddle') {
      Object.assign(s, { mode: 'saddle', orientation: 'landscape', pageCount: s.pageCount || 8, bookSize: s.bookSize || 'half', view: 'booklet' });
      s.spreads = {};
      s.pageLayouts = s.pageLayouts || {};
      ensureCells(s);
      return;
    }
    if (key === 'zine') {
      Object.assign(s, { mode: 'zine', orientation: 'landscape', colRatios: '', rowRatios: '', guides: true });
      s.spreads = s.spreads || {};
      s.view = s.view || 'booklet';
    } else if (s.mode === 'zine' || s.mode === 'saddle') {
      Object.assign(s, { mode: 'grid', orientation: 'portrait', margin: 0, gutter: 0, guides: false });
    }
    s.rows = p.rows;
    s.cols = p.cols;
    ensureCells(s);
  }

  // Cells beyond rows*cols are kept (not deleted) so shrinking and re-growing a grid is non-destructive.
  function ensureCells(s) {
    while (s.cells.length < cellCount(s)) s.cells.push(newCell());
  }

  function ratios(str, n) {
    const v = String(str || '').split(/[\s,:]+/).map(Number).filter((x) => x > 0);
    const out = [];
    for (let i = 0; i < n; i++) out.push(v[i] || 1);
    const t = out.reduce((a, b) => a + b, 0);
    return out.map((x) => x / t);
  }

  function pageSize(paper, sheet) {
    let [w, h] = PAPERS[paper] || PAPERS.A4;
    if ((sheet.orientation === 'landscape') !== (w > h)) [w, h] = [h, w];
    return [w, h];
  }

  // Cell rectangles in points, y-down page space. `rot` includes the zine's 180° top row.
  function cellRects(paper, sheet) {
    const [W, H] = pageSize(paper, sheet);
    const zine = sheet.mode === 'zine';
    // Zine panels must sit exactly on the paper's fold lines, so no margin/gutter there;
    // breathing room comes from each cell's padding instead.
    const m = zine ? 0 : sheet.margin * MM;
    const g = zine ? 0 : sheet.gutter * MM;
    const { rows, cols } = sheet;
    const cr = ratios(zine ? '' : sheet.colRatios, cols);
    const rr = ratios(zine ? '' : sheet.rowRatios, rows);
    const aw = Math.max(1, W - 2 * m - g * (cols - 1));
    const ah = Math.max(1, H - 2 * m - g * (rows - 1));
    const xs = [], ys = [];
    let x = m, y = m;
    for (let c = 0; c < cols; c++) { xs.push(x); x += cr[c] * aw + g; }
    for (let r = 0; r < rows; r++) { ys.push(y); y += rr[r] * ah + g; }
    const rects = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const rot = (((sheet.cells[i].rotate || 0) + (zine && r === 0 ? 180 : 0)) % 360 + 360) % 360;
        rects.push({ i, x: xs[c], y: ys[r], w: cr[c] * aw, h: rr[r] * ah, rot });
      }
    }
    // A spread set to "one photo across" becomes one rect, owned by the left page's cell.
    if (zine) {
      for (const sp of ZINE_SPREADS) {
        if (!(sheet.spreads || {})[spreadKey(sp)]) continue;
        const a = rects.find((r) => r.i === ZINE_PAGES.indexOf(sp[0]));
        const bi = rects.findIndex((r) => r.i === ZINE_PAGES.indexOf(sp[1]));
        const b = rects[bi];
        Object.assign(a, { x: Math.min(a.x, b.x), w: a.w + b.w, spread: sp });
        rects.splice(bi, 1);
      }
    }
    return { W, H, rects, m, g, xs, ys, cr, rr, aw, ah };
  }

  // Right-hand page cells whose content is replaced by a spread-wide photo.
  function hiddenCells(sheet) {
    const out = new Set();
    if (sheet.mode === 'saddle') {
      const shown = new Set(readingCells(sheet));
      for (let i = 0; i < cellCount(sheet); i++) if (!shown.has(i)) out.add(i);
      return out;
    }
    if (sheet.mode !== 'zine') return out;
    for (const sp of ZINE_SPREADS) if ((sheet.spreads || {})[spreadKey(sp)]) out.add(ZINE_PAGES.indexOf(sp[1]));
    return out;
  }

  // Editor-only view of a zine as the reader sees it: cover, spreads 2–3, 4–5, 6–7, back cover.
  // Panels keep their printed size so crops and text look identical to the print.
  function bookletRects(paper, sheet) {
    const print = cellRects(paper, sheet);
    const pw = print.W / 4, ph = print.H / 2;
    const gap = pw * 0.18, lab = ph * 0.16;
    const slots = [[null, 1, 'Cover'], [2, 3, 'Pages 2–3'], [4, 5, 'Pages 4–5'], [6, 7, 'Pages 6–7'], [8, null, 'Back cover']];
    const rects = [], pages = [], labels = [];
    slots.forEach(([l, r], k) => {
      const sx = (k % 2) * (2 * pw + gap), sy = Math.floor(k / 2) * (ph + lab + gap);
      labels.push({ text: slots[k][2], x: sx + pw, y: sy + ph + lab * 0.62 });
      const merged = l && r && (sheet.spreads || {})[spreadKey([l, r])];
      [l, r].forEach((p, side) => {
        if (!p) return;
        pages.push({ x: sx + side * pw, y: sy, w: pw, h: ph });
        if (merged && side === 1) return;
        const i = ZINE_PAGES.indexOf(p);
        rects.push({ i, x: sx + side * pw, y: sy, w: merged ? 2 * pw : pw, h: ph, rot: ((sheet.cells[i].rotate || 0) % 360 + 360) % 360, spread: merged ? [l, r] : null });
      });
      if (l && r) labels[k].fold = { x: sx + pw, y1: sy, y2: sy + ph };
    });
    return { W: 4 * pw + gap, H: 3 * (ph + lab) + 2 * gap, rects, pages, labels, booklet: true };
  }

  // Local upright frame of a cell (y-down, origin top-left, size lw x lh) -> page space.
  function cellFrame(rect) {
    const swap = rect.rot === 90 || rect.rot === 270;
    const lw = swap ? rect.h : rect.w;
    const lh = swap ? rect.w : rect.h;
    const C = mul(T(rect.x + rect.w / 2, rect.y + rect.h / 2), mul(R(rect.rot), T(-lw / 2, -lh / 2)));
    return { lw, lh, C };
  }

  // Positions of the image and caption lines inside a cell's local frame.
  // `img` is { w, h } in upright pixels, or null.
  function cellLayout(cell, lw, lh, img) {
    const p = Math.max(0, Math.min(cell.pad * MM, lw / 2 - 1, lh / 2 - 1));
    let ax = p, ay = p, aw = lw - 2 * p, ah = lh - 2 * p;
    const text = cell.caption || '';
    const lines = text.trim() ? text.split('\n') : [];
    const sz = Number(cell.capSize) || 9;
    const lead = sz * 1.25;
    const textH = lines.length * lead;
    const pos = cell.capPos;
    const overlay = pos !== 'below' && pos !== 'above';

    if (lines.length && !overlay) {
      const band = Math.min(textH + sz * 0.5, ah * 0.8);
      ah -= band;
      if (pos === 'above') ay += band;
    }

    let ty;
    if (pos === 'below') ty = ay + ah + sz * 0.5;
    else if (pos === 'above') ty = p;
    else if (pos === 'overlay-top') ty = ay + sz * 0.6;
    else if (pos === 'overlay-bottom') ty = ay + ah - textH - sz * 0.6;
    else ty = ay + (ah - textH) / 2;

    const inset = overlay ? sz * 0.6 : 0;
    const tx = cell.capAlign === 'left' ? ax + inset : cell.capAlign === 'right' ? ax + aw - inset : ax + aw / 2;
    const out = {
      area: { x: ax, y: ay, w: Math.max(0, aw), h: Math.max(0, ah) },
      lines: lines.map((t, k) => ({ text: t, x: tx, y: ty + k * lead + sz * 0.8 })),
      size: sz,
      place: null,
      dpi: null,
    };

    if (img && aw > 0 && ah > 0) {
      const base = cell.fit === 'contain' ? Math.min(aw / img.w, ah / img.h) : Math.max(aw / img.w, ah / img.h);
      const s = base * (Number(cell.zoom) || 1);
      const dw = img.w * s, dh = img.h * s;
      out.place = {
        x: ax + ((aw - dw) / 2) * (1 + Number(cell.panX || 0)),
        y: ay + ((ah - dh) / 2) * (1 + Number(cell.panY || 0)),
        w: dw,
        h: dh,
      };
      out.dpi = Math.round(img.w / (dw / 72));
    }
    return out;
  }

  // ---------- EXIF orientation (JPEG) ----------
  function jpegOrientation(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) return 1;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xda || marker === 0xd9) return 1;
      if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        const t = i + 10;
        const le = b[t] === 0x49;
        const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
          : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      i += 2 + len;
    }
    return 1;
  }

  function sniff(b) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    return null;
  }

  const hexRgb = (hex) => {
    const h = String(hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  // ---------- Fold & staple (saddle-stitched) booklets ----------
  // Two pages per side of a landscape sheet; sheets nest and are stapled through the centre fold.
  // Each page owns two cells: (p-1)*2 and (p-1)*2+1. The second is only used by two-photo layouts.
  const PAGE_LAYOUTS = { single: 'One photo', stack: 'Two stacked', side: 'Two side by side' };
  const POCKET = [89, 140]; // mm
  const MAX_PAGES = 64; // 16 folded sheets; thicker than that won't staple

  const cellCount = (s) => (s.mode === 'saddle' ? s.pageCount * 2 : s.rows * s.cols);
  const pageLayout = (s, p) => (s.pageLayouts || {})[p] || 'single';
  const rotOf = (s, i) => (((s.cells[i] && s.cells[i].rotate) || 0) % 360 + 360) % 360;

  function bookPageSize(paper, s) {
    const [W, H] = pageSize(paper, { orientation: 'landscape' });
    return s.bookSize === 'pocket' ? [POCKET[0] * MM, POCKET[1] * MM] : [W / 2, H];
  }

  // Facing pages (left even, right odd) that are set to one photo across both.
  // The covers can wrap too: back cover (left) + front cover (right), the outside of sheet 1.
  function saddleSpreadOf(s, p) {
    if (p === 1 || p === s.pageCount) return (s.spreads || {}).wrap ? [s.pageCount, 1] : null;
    if (p < 2 || p >= s.pageCount) return null;
    const l = p % 2 === 0 ? p : p - 1;
    return (s.spreads || {})[spreadKey([l, l + 1])] ? [l, l + 1] : null;
  }

  // Rects for one page placed in `box`. A spread photo is a double-width rect clipped to this
  // page, so each half lands on whichever sheet that page prints on.
  function pageRects(s, p, box) {
    const sp = saddleSpreadOf(s, p);
    if (sp) {
      const i = spreadOwner(s, sp);
      return [{ i, x: p === sp[1] ? box.x - box.w : box.x, y: box.y, w: box.w * 2, h: box.h, rot: rotOf(s, i), clip: box }];
    }
    const a = (p - 1) * 2, b = a + 1, lay = pageLayout(s, p);
    if (lay === 'stack') {
      return [
        { i: a, x: box.x, y: box.y, w: box.w, h: box.h / 2, rot: rotOf(s, a) },
        { i: b, x: box.x, y: box.y + box.h / 2, w: box.w, h: box.h / 2, rot: rotOf(s, b) },
      ];
    }
    if (lay === 'side') {
      return [
        { i: a, x: box.x, y: box.y, w: box.w / 2, h: box.h, rot: rotOf(s, a) },
        { i: b, x: box.x + box.w / 2, y: box.y, w: box.w / 2, h: box.h, rot: rotOf(s, b) },
      ];
    }
    return [{ i: a, x: box.x, y: box.y, w: box.w, h: box.h, rot: rotOf(s, a) }];
  }

  // The cell holding a spread photo: the left page's, except a cover wrap, which belongs to the front cover.
  const spreadOwner = (s, sp) => (sp[1] === 1 ? 0 : (sp[0] - 1) * 2);

  // Print order. Sheet k (0-based) front: [N-2k | 1+2k], back: [2+2k | N-1-2k].
  // Backs are upright for duplex "flip on short edge".
  function saddleSides(paper, s) {
    const [W, H] = pageSize(paper, { orientation: 'landscape' });
    const [pw, ph] = bookPageSize(paper, s);
    const N = s.pageCount;
    const box = (k) => ({ x: k * (W / 2) + (W / 2 - pw) / 2, y: (H - ph) / 2, w: pw, h: ph });
    const out = [];
    for (let k = 0; k < N / 4; k++) {
      out.push({ sheetNo: k + 1, side: 'front', W, H, pages: [[N - 2 * k, box(0)], [1 + 2 * k, box(1)]] });
      out.push({ sheetNo: k + 1, side: 'back', W, H, pages: [[2 + 2 * k, box(0)], [N - 1 - 2 * k, box(1)]] });
    }
    return out;
  }

  // Short trim lines just outside each corner of a pocket page.
  function cropMarks(b) {
    const gap = 2 * MM, len = 5 * MM, out = [];
    for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) {
      const dx = x === b.x ? -1 : 1, dy = y === b.y ? -1 : 1;
      out.push([x + dx * gap, y, x + dx * (gap + len), y]);
      out.push([x, y + dy * gap, x, y + dy * (gap + len)]);
    }
    return out;
  }

  // Change a book's length (multiple of 4: one folded sheet = 4 pages). Pages are added or
  // removed just before the back cover, so the back cover stays last. Removed pages are parked
  // at the end of the cell list, not deleted, so growing the book again brings them back.
  function resizeBook(s, n) {
    n = Math.max(4, Math.min(MAX_PAGES, Math.round(n / 4) * 4));
    const old = s.pageCount;
    if (n === old) return;
    ensureCells(s);
    const cells = s.cells;
    const back = cells.slice((old - 1) * 2, old * 2);
    const inner = cells.slice(0, (old - 1) * 2);
    const parked = cells.slice(old * 2);
    let next;
    if (n > old) {
      const add = (n - old) * 2;
      const fill = parked.splice(0, add); // reuse previously removed pages first
      while (fill.length < add) fill.push(newCell());
      next = [...inner, ...fill, ...back, ...parked];
    } else {
      const keep = inner.slice(0, (n - 1) * 2), cut = inner.slice((n - 1) * 2);
      next = [...keep, ...back, ...cut, ...parked];
    }
    s.cells = next;
    const layouts = { ...(s.pageLayouts || {}) };
    const backLayout = layouts[old];
    for (const k of Object.keys(layouts)) if (Number(k) >= Math.min(old, n)) delete layouts[k];
    if (backLayout) layouts[n] = backLayout;
    s.pageLayouts = layouts;
    const spreads = {};
    for (const [k, v] of Object.entries(s.spreads || {})) {
      if (k === 'wrap') { spreads.wrap = v; continue; }
      const l = Number(k.slice(0, k.length / 2));
      if (l + 1 < n) spreads[k] = v; // still a pair of inner pages
    }
    s.spreads = spreads;
    s.pageCount = n;
  }

  const pageName = (s, p) => (p === 1 ? 'Cover' : p === s.pageCount ? 'Back cover' : `Page ${p}`);

  // Cells in reading order, skipping ones a layout or spread doesn't show.
  function readingCells(s) {
    if (s.mode === 'zine') {
      const hidden = hiddenCells(s);
      return [1, 2, 3, 4, 5, 6, 7, 8].map((p) => ZINE_PAGES.indexOf(p)).filter((i) => !hidden.has(i));
    }
    if (s.mode !== 'saddle') return [...Array(cellCount(s)).keys()];
    const out = [];
    for (let p = 1; p <= s.pageCount; p++) {
      const sp = saddleSpreadOf(s, p);
      if (sp) { if (p === Math.min(...sp)) out.push(spreadOwner(s, sp)); continue; }
      out.push((p - 1) * 2);
      if (pageLayout(s, p) !== 'single') out.push((p - 1) * 2 + 1);
    }
    return out;
  }

  // Editor: the book as it reads. Cover alone, facing spreads, back cover alone; two per row.
  function saddleReadingView(paper, s) {
    const [pw, ph] = bookPageSize(paper, s);
    const N = s.pageCount;
    const gap = pw * 0.22, lab = ph * 0.13;
    const slots = [[null, 1]];
    for (let p = 2; p < N; p += 2) slots.push([p, p + 1]);
    slots.push([N, null]);
    const rects = [], pages = [], labels = [];
    slots.forEach(([l, r], k) => {
      const sx = (k % 2) * (2 * pw + gap), sy = Math.floor(k / 2) * (ph + lab + gap);
      const text = l && r ? `Pages ${l}–${r}` : pageName(s, l || r);
      const label = { text, x: sx + pw, y: sy + ph + lab * 0.6 };
      if (l && r) label.fold = { x: sx + pw, y1: sy, y2: sy + ph };
      labels.push(label);
      [l, r].forEach((p, side) => {
        if (!p) return;
        const box = { x: sx + side * pw, y: sy, w: pw, h: ph };
        pages.push(box);
        rects.push(...pageRects(s, p, box));
      });
    });
    const rows = Math.ceil(slots.length / 2);
    return { W: 4 * pw + gap, H: rows * (ph + lab) + (rows - 1) * gap, rects, pages, labels, labelSize: ph * 0.05, booklet: true, tall: true };
  }

  // Editor: the printed sheets, front and back side by side, one sheet per row.
  function saddlePrintView(paper, s) {
    const sides = saddleSides(paper, s);
    const { W, H } = sides[0];
    const gap = W * 0.05, lab = H * 0.08;
    const rects = [], pages = [], labels = [], numbers = [], marks = [];
    sides.forEach((sd) => {
      const ox = (sd.side === 'front' ? 0 : 1) * (W + gap), oy = (sd.sheetNo - 1) * (H + lab + gap);
      pages.push({ x: ox, y: oy, w: W, h: H });
      labels.push({ text: `Sheet ${sd.sheetNo} · ${sd.side}`, x: ox + W / 2, y: oy + H + lab * 0.55 });
      for (const [p, b] of sd.pages) {
        const box = { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h };
        rects.push(...pageRects(s, p, box));
        numbers.push({ text: String(p), x: box.x, y: box.y });
        if (s.bookSize === 'pocket') marks.push(...cropMarks(box));
      }
      if (s.bookSize !== 'pocket') labels[labels.length - 1].fold = { x: ox + W / 2, y1: oy, y2: oy + H };
    });
    const rows = sides.length / 2;
    return { W: 2 * W + gap, H: rows * (H + lab) + (rows - 1) * gap, rects, pages, labels, numbers, marks, labelSize: H * 0.04, booklet: true, tall: true };
  }

  // ---------- PDF output pages ----------
  // kind: 'print' | 'reading' | 'proof' | 'fronts' | 'backs'
  // Each output page: { W, H, sheet, rects, boxes (physical pages, for proofs), marks, rotate }
  function outputPages(project, kind, rotateBacks) {
    const out = [];
    for (const sheet of project.sheets) {
      ensureCells(sheet);
      if (sheet.mode === 'saddle') {
        if (kind === 'reading') {
          const [pw, ph] = bookPageSize(project.paper, sheet);
          for (let p = 1; p <= sheet.pageCount; p++) {
            const box = { x: 0, y: 0, w: pw, h: ph };
            out.push({ W: pw, H: ph, sheet, rects: pageRects(sheet, p, box), boxes: [{ ...box, rot: 0, label: String(p) }], marks: [] });
          }
          continue;
        }
        for (const sd of saddleSides(project.paper, sheet)) {
          if (kind === 'fronts' && sd.side !== 'front') continue;
          if (kind === 'backs' && sd.side !== 'back') continue;
          const rects = [], boxes = [], marks = [];
          for (const [p, b] of sd.pages) {
            rects.push(...pageRects(sheet, p, b));
            boxes.push({ ...b, rot: 0, label: String(p) });
            if (sheet.bookSize === 'pocket') marks.push(...cropMarks(b));
          }
          out.push({ W: sd.W, H: sd.H, sheet, rects, boxes, marks, rotate: rotateBacks && kind === 'backs' && sd.side === 'back' });
        }
        continue;
      }
      if (kind === 'backs') continue; // single-sided sheets only print with the fronts
      if (sheet.mode === 'zine' && kind === 'reading') {
        const [W, H] = pageSize(project.paper, sheet);
        const pw = W / 4, ph = H / 2;
        for (let p = 1; p <= 8; p++) {
          const sp = ZINE_SPREADS.find((x) => x.includes(p) && (sheet.spreads || {})[spreadKey(x)]);
          const box = { x: 0, y: 0, w: pw, h: ph };
          const i = ZINE_PAGES.indexOf(sp ? sp[0] : p);
          const rect = sp
            ? { i, x: p === sp[1] ? -pw : 0, y: 0, w: 2 * pw, h: ph, rot: rotOf(sheet, i), clip: box }
            : { i, x: 0, y: 0, w: pw, h: ph, rot: rotOf(sheet, i) };
          out.push({ W: pw, H: ph, sheet, rects: [rect], boxes: [{ ...box, rot: 0, label: String(p) }], marks: [] });
        }
        continue;
      }
      const geo = cellRects(project.paper, sheet);
      const boxes = sheet.mode === 'zine'
        ? cellRects(project.paper, { ...sheet, spreads: {} }).rects.map((r) => ({ ...r, label: String(ZINE_PAGES[r.i]) }))
        : geo.rects.map((r) => ({ ...r, label: String(r.i + 1) }));
      out.push({ W: geo.W, H: geo.H, sheet, rects: geo.rects, boxes, marks: [] });
    }
    return out;
  }

  // ---------- PDF ----------
  // images: Map id -> { kind: 'jpg'|'png', bytes: Uint8Array, orientation, w, h }
  // JPEGs are embedded byte-for-byte (no recompression); PNGs are embedded losslessly.
  // Cropping is done with PDF clipping paths, so every original pixel is kept in the file.
  // opts.fontkit + opts.fontBytes(file) -> Uint8Array are needed for bundled fonts.
  async function buildPdf(PDFLib, project, images, opts = {}) {
    const { PDFDocument, rgb } = PDFLib;
    const cm = (m) => PDFLib.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]);
    const doc = await PDFDocument.create();
    if (opts.fontkit) doc.registerFontkit(opts.fontkit);
    doc.setTitle(project.title || 'Photobook');
    doc.setCreator('Photobook (local)');
    const embedded = new Map();
    const fonts = new Map();
    const getFont = async (key) => {
      const f = FONTS[key] || FONTS.Helvetica;
      const id = f.file || f.pdf;
      if (!fonts.has(id)) {
        // Full font, not a subset: fontkit's subsetter drops glyphs in some fonts.
        fonts.set(id, f.file ? await doc.embedFont(opts.fontBytes(f.file), { subset: false }) : await doc.embedFont(f.pdf));
      }
      return fonts.get(id);
    };
    const getImage = async (id) => {
      if (!embedded.has(id)) {
        const im = images.get(id);
        embedded.set(id, im.kind === 'jpg' ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes));
      }
      return embedded.get(id);
    };
    const safeText = (font, s) => {
      let out = '';
      const fk = font.embedder && font.embedder.font; // a fontkit font only for bundled TTFs
      const custom = fk && typeof fk.hasGlyphForCodePoint === 'function';
      for (const ch of s) {
        if (custom) { out += fk.hasGlyphForCodePoint(ch.codePointAt(0)) ? ch : '?'; continue; }
        try { font.encodeText(ch); out += ch; } catch (_) { out += '?'; }
      }
      return out;
    };

    // Proof: outlines + big page numbers + TOP marker, no photos. Checks order and flipping on cheap paper.
    async function drawProof(page, F, outPage) {
      const font = await getFont('Helvetica-Bold');
      for (const b of outPage.boxes) {
        const { lw, lh, C } = cellFrame(b);
        page.pushOperators(PDFLib.pushGraphicsState(), cm(F), cm(C), PDFLib.setLineWidth(0.8),
          PDFLib.setStrokingRgbColor(0.55, 0.55, 0.55), PDFLib.rectangle(4, 4, lw - 8, lh - 8), PDFLib.stroke(), cm([1, 0, 0, -1, 0, 0]));
        const size = Math.min(lw, lh) / 3;
        const w = font.widthOfTextAtSize(b.label, size);
        page.drawText(b.label, { x: (lw - w) / 2, y: -(lh / 2 + size * 0.35), size, font, color: rgb(0.2, 0.2, 0.2) });
        const tw = font.widthOfTextAtSize('TOP', 9);
        page.drawText('TOP', { x: (lw - tw) / 2, y: -18, size: 9, font, color: rgb(0.45, 0.45, 0.45) });
        page.pushOperators(PDFLib.popGraphicsState());
      }
      if (outPage.marks.length) {
        page.pushOperators(PDFLib.pushGraphicsState(), cm(F), PDFLib.setLineWidth(0.4));
        for (const [x1, y1, x2, y2] of outPage.marks) page.pushOperators(PDFLib.moveTo(x1, y1), PDFLib.lineTo(x2, y2), PDFLib.stroke());
        page.pushOperators(PDFLib.popGraphicsState());
      }
    }

    const kind = opts.kind || 'print';
    for (const outPage of outputPages(project, kind, opts.rotateBacks)) {
      const { W, H, sheet } = outPage;
      const page = doc.addPage([W, H]);
      // y-down page space -> PDF space (turned 180° for manual-duplex backs that print upside down)
      const F = outPage.rotate ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H];
      const pageClip = (r) => (r.clip ? [PDFLib.rectangle(r.clip.x, r.clip.y, r.clip.w, r.clip.h), PDFLib.clip(), PDFLib.endPath()] : []);

      if (kind === 'proof') {
        await drawProof(page, F, outPage);
        continue;
      }

      for (const rect of outPage.rects) {
        const cell = sheet.cells[rect.i];
        const { lw, lh, C } = cellFrame(rect);
        const im = cell.img && images.get(cell.img);
        const L = cellLayout(cell, lw, lh, im ? { w: im.w, h: im.h } : null);

        page.pushOperators(PDFLib.pushGraphicsState(), cm(F), ...pageClip(rect), cm(C));
        if (cell.bg) {
          const [r, g, b] = hexRgb(cell.bg);
          page.pushOperators(PDFLib.setFillingRgbColor(r, g, b), PDFLib.rectangle(0, 0, lw, lh), PDFLib.fill());
        }
        if (im && L.place) {
          const pimg = await getImage(cell.img);
          const name = page.node.newXObject('Im', pimg.ref);
          const a = L.area, pl = L.place;
          page.pushOperators(
            PDFLib.rectangle(a.x, a.y, a.w, a.h), PDFLib.clip(), PDFLib.endPath(),
            cm(T(pl.x, pl.y)), cm(S(pl.w, pl.h)),
            cm([1, 0, 0, -1, 0, 1]), // displayed unit square: y-down -> y-up
            cm(ORIENT[im.orientation] || ORIENT[1]),
            PDFLib.drawObject(name),
          );
        }
        page.pushOperators(PDFLib.popGraphicsState());

        // Tint over the photo so text on top stays readable.
        if (im && L.place && cell.overlay > 0) {
          const [r, g, b] = hexRgb(cell.overlayColor);
          page.pushOperators(PDFLib.pushGraphicsState(), cm(F), ...pageClip(rect), cm(C));
          page.drawRectangle({ x: L.area.x, y: L.area.y, width: L.area.w, height: L.area.h, color: rgb(r, g, b), opacity: Number(cell.overlay) });
          page.pushOperators(PDFLib.popGraphicsState());
        }

        if (L.lines.length) {
          const font = await getFont(cell.capFont);
          const [r, g, b] = hexRgb(cell.capColor);
          page.pushOperators(PDFLib.pushGraphicsState(), cm(F), ...pageClip(rect), cm(C), cm([1, 0, 0, -1, 0, 0]));
          for (const ln of L.lines) {
            const t = safeText(font, ln.text);
            const w = font.widthOfTextAtSize(t, L.size);
            const x = cell.capAlign === 'left' ? ln.x : cell.capAlign === 'right' ? ln.x - w : ln.x - w / 2;
            page.drawText(t, { x, y: -ln.y, size: L.size, font, color: rgb(r, g, b) });
          }
          page.pushOperators(PDFLib.popGraphicsState());
        }
      }

      if (outPage.marks.length) {
        page.pushOperators(PDFLib.pushGraphicsState(), cm(F), PDFLib.setLineWidth(0.4), PDFLib.setStrokingRgbColor(0, 0, 0));
        for (const [x1, y1, x2, y2] of outPage.marks) page.pushOperators(PDFLib.moveTo(x1, y1), PDFLib.lineTo(x2, y2), PDFLib.stroke());
        page.pushOperators(PDFLib.popGraphicsState());
      }
    }
    return doc.save();
  }

  // Printed guide lines (y-down). Zine: the centre cut. Grid: lines through the gutters.
  function guideLines(geo, sheet) {
    const { W, H } = geo;
    if (sheet.mode === 'zine') return [[W / 4, H / 2, (3 * W) / 4, H / 2]];
    const out = [];
    for (let c = 1; c < sheet.cols; c++) {
      const x = geo.xs[c] - geo.g / 2;
      out.push([x, 0, x, H]);
    }
    for (let r = 1; r < sheet.rows; r++) {
      const y = geo.ys[r] - geo.g / 2;
      out.push([0, y, W, y]);
    }
    return out;
  }

  root.PB = {
    MM, PAPERS, ZINE_PAGES, ZINE_SPREADS, spreadKey, hiddenCells, bookletRects, FONTS,
    PAGE_LAYOUTS, MAX_PAGES, resizeBook, cellCount, pageLayout, saddleSpreadOf, readingCells, saddleReadingView, saddlePrintView, saddleSides, outputPages, pageName, ORIENT, PRESETS, mul,
    newCell, newSheet, applyPreset, ensureCells, pageSize, cellRects, cellFrame, cellLayout,
    jpegOrientation, sniff, hexRgb, buildPdf, guideLines,
  };
})(typeof window !== 'undefined' ? window : globalThis);
