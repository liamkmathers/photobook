(function () {
  'use strict';
  const { MM, PRESETS, ZINE_PAGES, FONTS, newSheet, newCell, applyPreset, ensureCells, cellRects, cellFrame, cellLayout } = PB;

  const PREVIEW_MAX = 2000; // px, long side of the on-screen copy (export always uses the original file)

  const state = {
    paper: 'A4',
    sheets: [newSheet('zine')],
    current: 0,
    selected: null,
  };
  const images = new Map(); // id -> { id, name, kind, bytes, orientation, w, h, preview, thumb }
  let nextId = 1;

  const $ = (id) => document.getElementById(id);
  const sheet = () => state.sheets[state.current];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function status(msg, ms) {
    const el = $('status');
    el.textContent = msg;
    el.hidden = !msg;
    clearTimeout(status.t);
    if (msg && ms) status.t = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- images ----------
  async function decode(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function scaledCopy(img, max) {
    const k = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k));
    c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // Keeps the original bytes. JPEG/PNG go into the PDF untouched; anything else
  // (WebP, GIF, AVIF, HEIC in Safari...) is converted once to lossless PNG at full resolution.
  async function addImage(bytes, name, meta) {
    let kind = PB.sniff(bytes);
    let img = await decode(new Blob([bytes]));
    let orientation = kind === 'jpg' ? PB.jpegOrientation(bytes) : 1;
    if (!kind) {
      const full = scaledCopy(img, Infinity);
      const png = await new Promise((res) => full.toBlob(res, 'image/png'));
      bytes = new Uint8Array(await png.arrayBuffer());
      kind = 'png';
      orientation = 1;
      img = full;
    }
    const id = (meta && meta.id) || 'img' + nextId++;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const rec = {
      id, name, kind, bytes, orientation, w, h,
      preview: scaledCopy(img, PREVIEW_MAX),
      thumb: scaledCopy(img, 160),
    };
    images.set(id, rec);
    return rec;
  }

  async function ingestFiles(files) {
    const out = [];
    const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|bmp|tiff?)$/i.test(f.name));
    for (let k = 0; k < list.length; k++) {
      const f = list[k];
      status(`Loading ${k + 1}/${list.length}: ${f.name}`);
      try {
        out.push(await addImage(new Uint8Array(await f.arrayBuffer()), f.name));
      } catch (e) {
        console.error(e);
        alertLater(`Couldn't read ${f.name} — this browser can't decode that format.`);
      }
    }
    status('');
    renderLibrary();
    return out;
  }

  function alertLater(msg) { status(msg, 5000); }

  // Put photos into empty cells starting at (sheetIdx, cellIdx); grows the document with
  // sheets of the same layout if they don't fit.
  function fillCells(recs, sheetIdx, cellIdx, forceFirst) {
    let s = sheetIdx, c = cellIdx || 0;
    for (let k = 0; k < recs.length; k++) {
      while (true) {
        if (s >= state.sheets.length) {
          const tpl = state.sheets[state.sheets.length - 1];
          state.sheets.push(cloneLayout(tpl));
        }
        const sh = state.sheets[s];
        ensureCells(sh);
        const order = cellOrder(sh);
        if (c >= order.length) { s++; c = 0; continue; }
        const cell = sh.cells[order[c]];
        if (!cell.img || (forceFirst && k === 0)) { cell.img = recs[k].id; c++; break; }
        c++;
      }
    }
  }

  // Cell indices in "reading" order: zine sheets follow page numbers 1..8.
  const cellOrder = (sh) => PB.readingCells(sh);

  const rectFor = (geo, i) => geo && geo.rects.find((r) => r.i === i);
  const zinePageName = (rect) => rect.spread ? `Pages ${rect.spread[0]}–${rect.spread[1]}` : ({ 1: "Front cover", 8: "Back cover" })[ZINE_PAGES[rect.i]] || `Page ${ZINE_PAGES[rect.i]}`;
  const isBooklet = (sh) => sh.mode === "zine" && sh.view !== "print";

  function cloneLayout(sh) {
    const s = JSON.parse(JSON.stringify(sh));
    s.cells = s.cells.map((c) => ({ ...c, img: null, caption: '' }));
    return s;
  }

  // ---------- sheet rendering (all sheets stacked in one scrolling column) ----------
  const wrap = $('canvasWrap');
  const views = []; // one per sheet: { idx, frame, label, canvas, ctx, geo, scale, css }
  const curGeo = () => views[state.current] && views[state.current].geo;

  function syncFrames() {
    while (views.length < state.sheets.length) {
      const frame = document.createElement('div');
      frame.className = 'sheet-frame';
      const label = document.createElement('div');
      label.className = 'sheet-label';
      const canvas = document.createElement('canvas');
      frame.append(label, canvas);
      wrap.appendChild(frame);
      const v = { idx: views.length, frame, label, canvas, ctx: canvas.getContext('2d'), geo: null, scale: 1, css: 1 };
      bindCanvas(v);
      views.push(v);
    }
    while (views.length > state.sheets.length) views.pop().frame.remove();
    views.forEach((v, i) => { v.idx = i; v.frame.classList.toggle('active', i === state.current); });
  }

  // Each sheet is sized to fit the visible area, so scrolling moves one sheet at a time.
  // Normal sheets fit the visible area. Tall views (a whole stapled book) fit the width and scroll.
  function fitCanvas(v, W, H, tall) {
    let dpr = window.devicePixelRatio || 1;
    const k = tall
      ? Math.min((wrap.clientWidth - 48) / W, 1000 / W)
      : Math.min((wrap.clientWidth - 48) / W, (wrap.clientHeight - 56) / H);
    if (H * k * dpr > 16000) dpr = 16000 / (H * k); // stay under browser canvas limits for long books
    const cw = Math.max(50, Math.floor(W * k)), chh = Math.max(50, Math.floor(H * k));
    v.canvas.style.width = cw + 'px';
    v.canvas.style.height = chh + 'px';
    v.canvas.width = Math.round(cw * dpr);
    v.canvas.height = Math.round(chh * dpr);
    v.scale = v.canvas.width / W;
    v.css = cw / W;
  }

  const draw = () => drawSheet(state.current);
  function drawAll() { for (let i = 0; i < views.length; i++) drawSheet(i); }

  function drawSheet(si) {
    const v = views[si], sh = state.sheets[si];
    if (!v || !sh) return;
    const ctx = v.ctx;
    ensureCells(sh);
    v.label.textContent = `Sheet ${sheetName(sh, si)}`;
    const geo = (v.geo = sh.mode === 'saddle'
      ? (sh.view === 'print' ? PB.saddlePrintView(state.paper, sh) : PB.saddleReadingView(state.paper, sh))
      : isBooklet(sh) ? PB.bookletRects(state.paper, sh) : cellRects(state.paper, sh));
    fitCanvas(v, geo.W, geo.H, geo.tall);
    v.canvas.classList.toggle('booklet', !!geo.booklet);
    const s = v.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
    if (geo.booklet) {
      // Paper pages with a soft shadow, and the spread names underneath.
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.18)';
      ctx.shadowBlur = 8 * (window.devicePixelRatio || 1);
      ctx.shadowOffsetY = 2 * (window.devicePixelRatio || 1);
      ctx.fillStyle = '#fff';
      for (const p of geo.pages) ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.restore();
      ctx.fillStyle = '#74726c';
      ctx.font = `500 ${geo.labelSize || geo.H / 52}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const l of geo.labels) ctx.fillText(l.text.toUpperCase(), l.x, l.y);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, v.canvas.width, v.canvas.height);
    }

    for (const rect of geo.rects) {
      paintCell(ctx, sh, rect, s, true, geo.booklet);
    }

    // Cell outlines + selection + guides, in page space
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.lineWidth = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    for (const r of geo.rects) { const b = r.clip || r; ctx.strokeRect(b.x, b.y, b.w, b.h); }
    if (geo.marks) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      for (const [x1, y1, x2, y2] of geo.marks) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      ctx.setLineDash([3, 3]);
    }
    if (geo.numbers) {
      // Page numbers on the print view, so the imposition is easy to read
      const fs = (geo.labelSize || 10) * 0.9;
      ctx.font = `600 ${fs}px -apple-system, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const n of geo.numbers) {
        const tw = ctx.measureText(n.text).width;
        ctx.fillStyle = 'rgba(226,85,43,.92)';
        ctx.fillRect(n.x + 4, n.y + 4, tw + fs * 0.8, fs * 1.4);
        ctx.fillStyle = '#fff';
        ctx.fillText(n.text, n.x + 4 + fs * 0.4, n.y + 4 + fs * 0.22);
      }
    }
    if (geo.booklet) {
      // Where the paper folds inside each spread
      ctx.strokeStyle = 'rgba(0,0,0,.28)';
      for (const l of geo.labels) if (l.fold) { ctx.beginPath(); ctx.moveTo(l.fold.x, l.fold.y1); ctx.lineTo(l.fold.x, l.fold.y2); ctx.stroke(); }
    } else if (sh.binding === 'fold' && sh.mode === 'grid') {
      // Where each cut-out piece will be folded
      ctx.strokeStyle = 'rgba(226,85,43,.8)';
      for (const r of geo.rects) { ctx.beginPath(); ctx.moveTo(r.x + r.w / 2, r.y); ctx.lineTo(r.x + r.w / 2, r.y + r.h); ctx.stroke(); }
    } else if (sh.mode === 'zine') {
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      for (const [x1, y1, x2, y2] of PB.guideLines(geo, sh)) {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    let hi = null;
    if (dragState && dragState.moved) hi = dragState.over && dragState.over.s === si ? dragState.over.i : null;
    else if (si === state.current) hi = state.selected;
    if (hi != null) {
      const px = 1 / v.css;
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = '#e2552b';
      for (const rr of geo.rects) {
        if (rr.i !== hi) continue;
        const r = rr.clip || rr;
        ctx.strokeRect(r.x + px, r.y + px, r.w - 2 * px, r.h - 2 * px);
      }
    }
  }

  // Draws one cell at scale s. Shared by the editor and the flip-through preview;
  // `editor` adds placeholders, zine page badges and dpi warnings, none of which print.
  function paintCell(ctx, sh, rect, s, editor, booklet) {
    const cell = sh.cells[rect.i];
    const { lw, lh, C } = cellFrame(rect);
    const im = cell.img && images.get(cell.img);
    const L = cellLayout(cell, lw, lh, im);
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (rect.clip) { ctx.beginPath(); ctx.rect(rect.clip.x, rect.clip.y, rect.clip.w, rect.clip.h); ctx.clip(); }
    ctx.transform(...C);
    if (cell.bg) { ctx.fillStyle = cell.bg; ctx.fillRect(0, 0, lw, lh); }
    if (im && L.place) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.area.x, L.area.y, L.area.w, L.area.h);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im.preview, L.place.x, L.place.y, L.place.w, L.place.h);
      if (cell.overlay > 0) {
        ctx.globalAlpha = cell.overlay;
        ctx.fillStyle = cell.overlayColor;
        ctx.fillRect(L.area.x, L.area.y, L.area.w, L.area.h);
      }
      ctx.restore();
    } else if (editor && !cell.caption.trim()) {
      ctx.fillStyle = '#f4f3f0';
      ctx.fillRect(L.area.x, L.area.y, L.area.w, L.area.h);
      ctx.fillStyle = '#b3b0a8';
      ctx.font = `${Math.min(lw, lh) / 9}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+ photo', lw / 2, lh / 2);
    }
    if (L.lines.length) {
      const f = FONTS[cell.capFont] || FONTS.Helvetica;
      ctx.fillStyle = cell.capColor;
      ctx.font = `${f.style} ${f.weight} ${L.size}px ${f.css}`;
      ctx.textAlign = cell.capAlign;
      ctx.textBaseline = 'alphabetic';
      for (const ln of L.lines) ctx.fillText(ln.text, ln.x, ln.y);
    }
    // Editor-only overlays (not exported)
    if (editor && sh.mode === 'zine' && !booklet) {
      const p = ZINE_PAGES[rect.i];
      const label = rect.spread ? `${rect.spread[0]}–${rect.spread[1]}` : p === 1 ? '1 · cover' : p === 8 ? '8 · back' : String(p);
      const fs = Math.min(lw, lh) / 14;
      ctx.font = `600 ${fs}px -apple-system, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(194,65,12,.85)';
      ctx.fillRect(4, 4, tw + fs * 0.8, fs * 1.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, 4 + fs * 0.4, 4 + fs * 0.25);
    }
    if (editor && im && L.dpi && L.dpi < 240) {
      const fs = Math.min(lw, lh) / 16;
      const t = `${L.dpi} dpi`;
      ctx.font = `600 ${fs}px -apple-system, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = L.dpi < 150 ? 'rgba(185,28,28,.9)' : 'rgba(180,83,9,.9)';
      ctx.fillRect(lw - 4 - tw - fs * 0.8, 4, tw + fs * 0.8, fs * 1.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(t, lw - 4 - fs * 0.4, 4 + fs * 0.25);
    }
    ctx.restore();
  }

  // Which sheet + cell is under a screen point, across all sheets.
  function hit(clientX, clientY) {
    for (const v of views) {
      if (!v.geo) continue;
      const b = v.canvas.getBoundingClientRect();
      if (clientX < b.left || clientX > b.right || clientY < b.top || clientY > b.bottom) continue;
      const x = (clientX - b.left) / v.css, y = (clientY - b.top) / v.css;
      const r = v.geo.rects.find((rr) => { const r = rr.clip || rr; return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; });
      return r ? { s: v.idx, i: r.i } : null;
    }
    return null;
  }
  const sameHit = (a, b) => (a && b ? a.s === b.s && a.i === b.i : a === b);

  function setCurrent(si, scroll) {
    state.current = si;
    views.forEach((v, i) => v.frame.classList.toggle('active', i === si));
    if (scroll && views[si]) {
      scrollLock = Date.now() + 700; // don't let the smooth scroll re-pick the sheet on its way past
      views[si].frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---------- file picker for a cell ----------
  let pickTarget = null;
  function openPicker(s, i) {
    pickTarget = { s, i };
    $('cellPicker').click();
  }
  $('cellPicker').onchange = async (e) => {
    const t = pickTarget;
    pickTarget = null;
    const recs = await ingestFiles(e.target.files);
    e.target.value = '';
    if (!recs.length || !t) return;
    placeFrom(recs, t.s, t.i);
    renderAll();
  };

  // First photo goes into the chosen cell; any extras fill the following empty cells.
  function placeFrom(recs, s, i) {
    const sh = state.sheets[s];
    sh.cells[i].img = recs[0].id;
    setCurrent(s);
    state.selected = i;
    fillCells(recs.slice(1), s, cellOrder(sh).indexOf(i) + 1);
  }

  // ---------- canvas interaction ----------
  let dragState = null, justDragged = false, scrollLock = 0;

  function bindCanvas(v) {
    const c = v.canvas;
    // How far a cell's photo can slide: the overflow (in points, local cell frame) on each axis.
    const panInfo = (h) => {
      const cell = state.sheets[h.s].cells[h.i];
      const im = cell.img && images.get(cell.img);
      const rect = rectFor(views[h.s].geo, h.i);
      if (!im || !rect) return null;
      const { lw, lh } = cellFrame(rect);
      const L = cellLayout(cell, lw, lh, im);
      if (!L.place) return null;
      const ox = L.area.w - L.place.w, oy = L.area.h - L.place.h;
      if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) return null;
      return { cell, ox, oy, rot: rect.rot };
    };

    c.addEventListener('pointerdown', (e) => {
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      c.setPointerCapture(e.pointerId);
      // Dragging a cropped photo slides it inside its cell; Option/Alt-drag swaps cells instead.
      const pan = !e.altKey && panInfo(h);
      dragState = {
        from: h, over: h, x: e.clientX, y: e.clientY, moved: false,
        pan: pan ? { ...pan, px: pan.cell.panX, py: pan.cell.panY } : null,
      };
    });
    c.addEventListener('pointermove', (e) => {
      if (!dragState) {
        const h = hit(e.clientX, e.clientY);
        c.style.cursor = !h ? 'default' : !e.altKey && panInfo(h) ? 'grab' : 'pointer';
        return;
      }
      if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) > 4) dragState.moved = true;
      if (!dragState.moved) return;
      c.style.cursor = dragState.pan ? 'grabbing' : 'move';
      if (dragState.pan) {
        const p = dragState.pan;
        const dx = (e.clientX - dragState.x) / views[dragState.from.s].css;
        const dy = (e.clientY - dragState.y) / views[dragState.from.s].css;
        // Screen delta -> the cell's own (possibly rotated) frame.
        const k = p.rot / 90, cs = [1, 0, -1, 0][k], sn = [0, 1, 0, -1][k];
        const lx = cs * dx + sn * dy, ly = -sn * dx + cs * dy;
        const clamp = (v) => Math.max(-1, Math.min(1, v));
        if (Math.abs(p.ox) >= 0.5) p.cell.panX = clamp(p.px + lx / (p.ox / 2));
        if (Math.abs(p.oy) >= 0.5) p.cell.panY = clamp(p.py + ly / (p.oy / 2));
        drawSheet(dragState.from.s);
        return;
      }
      const o = hit(e.clientX, e.clientY);
      if (!sameHit(o, dragState.over)) {
        const prev = dragState.over;
        dragState.over = o;
        if (prev) drawSheet(prev.s);
        if (o && (!prev || o.s !== prev.s)) drawSheet(o.s);
      }
    });
    c.addEventListener('pointerup', () => {
      if (!dragState) return;
      const d = dragState;
      dragState = null;
      c.style.cursor = d.pan ? 'grab' : 'pointer';
      justDragged = d.moved;
      if (!d.pan && d.moved && d.over && !sameHit(d.over, d.from)) {
        // Swap content, also between sheets. Zine flips live in the geometry, not the cell.
        const A = state.sheets[d.from.s].cells, B = state.sheets[d.over.s].cells;
        [A[d.from.i], B[d.over.i]] = [B[d.over.i], A[d.from.i]];
        setCurrent(d.over.s);
        state.selected = d.over.i;
      } else {
        setCurrent(d.from.s);
        state.selected = d.from.i;
      }
      renderAll();
    });
    // File pickers must open from a click, so empty-cell picking lives here rather than in pointerup.
    c.addEventListener('click', (e) => {
      if (justDragged) { justDragged = false; return; }
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      const cell = state.sheets[h.s].cells[h.i];
      if (!cell.img && !cell.caption.trim()) openPicker(h.s, h.i);
    });
    c.addEventListener('dblclick', (e) => {
      const h = hit(e.clientX, e.clientY);
      if (h) openPicker(h.s, h.i);
    });
  }

  // As you scroll, the sheet nearest the middle becomes the one the side panels edit.
  let scrollRaf = 0;
  wrap.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => {
      if (Date.now() < scrollLock) return;
      const b = wrap.getBoundingClientRect(), mid = b.top + b.height / 2;
      let best = state.current, bestD = Infinity;
      views.forEach((v, i) => {
        const r = v.frame.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best !== state.current) {
        const prev = state.current;
        setCurrent(best);
        state.selected = null;
        drawSheet(prev);
        renderSheets(); renderSheetPanel(); renderCellPanel();
      }
    });
  });

  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
  wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dragover'); });
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    wrap.classList.remove('dragover');
    const target = hit(e.clientX, e.clientY);
    const libId = e.dataTransfer.getData('text/x-photo');
    if (libId) {
      if (target) { state.sheets[target.s].cells[target.i].img = libId; setCurrent(target.s); state.selected = target.i; }
      return renderAll();
    }
    const recs = await ingestFiles(e.dataTransfer.files);
    if (!recs.length) return;
    if (target) placeFrom(recs, target.s, target.i);
    else fillCells(recs, state.current, 0);
    renderAll();
  });

  // ---------- library ----------
  function renderLibrary() {
    const lib = $('library');
    lib.innerHTML = '';
    const uses = new Map();
    for (const sh of state.sheets) for (const c of sh.cells.slice(0, PB.cellCount(sh))) if (c.img) uses.set(c.img, (uses.get(c.img) || 0) + 1);
    $('libCount').textContent = images.size ? `· ${images.size}` : '';
    // First tile always adds more photos to the gallery.
    const add = document.createElement('button');
    add.className = 'thumb add';
    add.title = 'Add photos to the gallery';
    add.innerHTML = '<span>+</span><small>Add</small>';
    add.onclick = () => $('libPhotos').click();
    lib.appendChild(add);
    if (!images.size) {
      lib.insertAdjacentHTML('beforeend', '<span class="empty">Add photos here, or drop them in from Finder. Then drag a photo onto any page, or click it to fill the selected cell.</span>');
      return;
    }
    for (const im of images.values()) {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.title = `${im.name} — ${im.w}×${im.h}px${im.kind === 'jpg' ? ' (JPEG, embedded unchanged)' : ' (lossless PNG)'}`;
      d.draggable = true;
      const c = document.createElement('canvas');
      c.width = im.thumb.width; c.height = im.thumb.height;
      c.getContext('2d').drawImage(im.thumb, 0, 0);
      d.appendChild(c);
      if (uses.get(im.id)) d.insertAdjacentHTML('beforeend', `<span class="uses">×${uses.get(im.id)}</span>`);
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.title = 'Remove photo';
      x.onclick = (e) => {
        e.stopPropagation();
        images.delete(im.id);
        for (const sh of state.sheets) for (const cell of sh.cells) if (cell.img === im.id) cell.img = null;
        renderAll();
      };
      d.appendChild(x);
      d.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-photo', im.id));
      d.addEventListener('click', () => {
        if (state.selected == null) return status('Select a cell first', 2000);
        sheet().cells[state.selected].img = im.id;
        renderAll();
      });
      lib.appendChild(d);
    }
  }

  // Gallery-only adds: photos land in the strip, ready to drag onto pages.
  $('libPhotos').onchange = async (e) => {
    await ingestFiles(e.target.files);
    e.target.value = '';
    renderLibrary();
  };
  const libBox = $('libraryBox');
  const hasFiles = (e) => [...(e.dataTransfer.types || [])].includes('Files');
  libBox.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); libBox.classList.add('over'); } });
  libBox.addEventListener('dragleave', (e) => { if (!libBox.contains(e.relatedTarget)) libBox.classList.remove('over'); });
  libBox.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    libBox.classList.remove('over');
    await ingestFiles(e.dataTransfer.files);
    renderLibrary();
  });

  // ---------- sheet list + sheet panel ----------
  // Helpful links per format, shown under the layout controls. Add more here: { title, by, url }.
  const RESOURCES = {
    hsplit: [
      { title: 'How to make a Handmade Photobook', by: 'Heegs · YouTube', url: 'https://www.youtube.com/watch?v=3lisDYwlI_8' },
    ],
    zine: [
      { title: 'Folding instructions for an A4 8 page photo zine', by: 'Alison Spence Montillet · YouTube', url: 'https://www.youtube.com/watch?v=MKM3PfFhsbQ' },
      { title: 'Dirty Little Zine — fold guide and zine maker', by: 'dirtylittlezine.com', url: 'https://dirtylittlezine.com/' },
    ],
    saddle: [
      { title: 'How to make an Easy DIY Booklet Style Photo Book', by: 'Travel Journal Company · YouTube', url: 'https://www.youtube.com/watch?v=NRK_grvS7Ag' },
      { title: 'Fold & Staple — A5 and pocket photo zines', by: 'foldstaple.com', url: 'https://foldstaple.com/' },
    ],
  };

  function presetOf(sh) {
    if (sh.mode === 'saddle' || sh.mode === 'zine') return sh.mode;
    const p = Object.entries(PRESETS).find(([k, v]) => k !== 'zine' && k !== 'saddle' && v.rows === sh.rows && v.cols === sh.cols);
    return p ? p[0] : null;
  }

  function sheetName(sh, i) {
    if (sh.mode === 'saddle') return `${i + 1}. Fold & staple · ${sh.pageCount} pages`;
    const k = presetOf(sh);
    return `${i + 1}. ${k ? PRESETS[k].label : `${sh.rows} × ${sh.cols} grid`}`;
  }

  function renderSheets() {
    const ol = $('sheetList');
    ol.innerHTML = '';
    state.sheets.forEach((sh, i) => {
      const li = document.createElement('li');
      li.className = i === state.current ? 'active' : '';
      li.innerHTML = `<span class="name">${esc(sheetName(sh, i))}</span><span class="tools">
        <button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button>
        <button data-a="dup" title="Duplicate">⧉</button><button data-a="del" title="Delete">✕</button></span>`;
      li.onclick = (e) => {
        const a = e.target.dataset.a;
        if (a === 'up' && i > 0) { [state.sheets[i - 1], state.sheets[i]] = [state.sheets[i], state.sheets[i - 1]]; state.current = i - 1; }
        else if (a === 'down' && i < state.sheets.length - 1) { [state.sheets[i + 1], state.sheets[i]] = [state.sheets[i], state.sheets[i + 1]]; state.current = i + 1; }
        else if (a === 'dup') { state.sheets.splice(i + 1, 0, JSON.parse(JSON.stringify(sh))); state.current = i + 1; }
        else if (a === 'del') {
          if (state.sheets.length === 1) return status('A project needs at least one sheet', 2000);
          state.sheets.splice(i, 1);
          state.current = Math.min(state.current, state.sheets.length - 1);
        } else if (!a) state.current = i;
        state.selected = null;
        renderAll();
        setCurrent(state.current, true);
      };
      ol.appendChild(li);
    });
  }

  function renderSheetPanel() {
    const sh = sheet();
    const zine = sh.mode === 'zine';
    const presetKey = presetOf(sh);
    const saddle = sh.mode === 'saddle';
    const links = RESOURCES[presetKey] || [];
    const p = $('sheetPanel');
    p.innerHTML = `
      <h2>Layout</h2>
      <div class="presets">${Object.entries(PRESETS).map(([k, v]) =>
        `<button class="btn ${presetKey === k ? 'on' : ''}" data-preset="${k}">${v.label}</button>`).join('')}</div>
      ${saddle ? `
      <label class="field">Book size
        <div class="seg"><button data-bs="half" class="${sh.bookSize !== 'pocket' ? 'on' : ''}">${state.paper === 'A4' ? 'A5' : 'Half sheet'}</button><button data-bs="pocket" class="${sh.bookSize === 'pocket' ? 'on' : ''}">Pocket</button></div>
      </label>
      <label class="field">Pages
        <div class="stepper"><button data-pc="-4" title="Remove a sheet (4 pages)" ${sh.pageCount <= 4 ? 'disabled' : ''}>−</button>
          <span><b>${sh.pageCount} pages</b> · ${sh.pageCount / 4} sheet${sh.pageCount > 4 ? 's' : ''}</span>
          <button data-pc="4" title="Add a sheet (4 pages)" ${sh.pageCount >= PB.MAX_PAGES ? 'disabled' : ''}>+</button></div>
      </label>
      <label class="field">View
        <div class="seg"><button data-v="booklet" class="${sh.view !== 'print' ? 'on' : ''}">Reading order</button><button data-v="print" class="${sh.view === 'print' ? 'on' : ''}">Print sheets</button></div>
      </label>
      <p class="note">${sh.view === 'print'
        ? 'How the sheets print. Each row is one sheet of paper: front on the left, back on the right.'
        : 'Build the book as it reads: cover, spreads, back cover. The PDF works out the print order.'}
        ${sh.bookSize === 'pocket' ? ' Pocket pages (89 × 140 mm) print centred with crop marks for trimming.' : ''}</p>
      <p class="note"><b>To print:</b> 100% scale, double-sided, flip on short edge. Fold the sheets in half together, nest them, staple through the fold.</p>
      <p class="note">Click a page to pick its layout (one photo, two stacked, two side by side) or join facing pages into one photo.</p>` : zine ? `
      <label class="field">View
        <div class="seg"><button data-v="booklet" class="${isBooklet(sh) ? 'on' : ''}">Booklet</button><button data-v="print" class="${isBooklet(sh) ? '' : 'on'}">Print sheet</button></div>
      </label>
      <p class="note">${isBooklet(sh) ? 'You edit the zine as it reads. The PDF puts every page in its folding position automatically (top row upside down).' : 'This is the actual printed sheet. The top row is upside down on purpose — it reads correctly once folded.'}</p>
      <h2 style="margin-bottom:6px">Spreads</h2>
      ${PB.ZINE_SPREADS.map((sp) => `<label class="field">Pages ${sp[0]}–${sp[1]}
        <div class="seg"><button data-sp="${PB.spreadKey(sp)}" data-on="0" class="${(sh.spreads || {})[PB.spreadKey(sp)] ? '' : 'on'}">Two photos</button><button data-sp="${PB.spreadKey(sp)}" data-on="1" class="${(sh.spreads || {})[PB.spreadKey(sp)] ? 'on' : ''}">One across</button></div></label>`).join('')}` : `
      <label class="field">Orientation
        <div class="seg"><button data-o="portrait" class="${sh.orientation === 'portrait' ? 'on' : ''}">Portrait</button><button data-o="landscape" class="${sh.orientation === 'landscape' ? 'on' : ''}">Landscape</button></div>
      </label>
      <div class="pair">
        <label class="field">Rows<input type="number" min="1" max="12" data-s="rows" value="${sh.rows}"></label>
        <label class="field">Columns<input type="number" min="1" max="12" data-s="cols" value="${sh.cols}"></label>
      </div>
      <label class="field">Column widths <input type="text" data-s="colRatios" placeholder="equal — e.g. 2,1" value="${esc(sh.colRatios)}"></label>
      <label class="field">Row heights <input type="text" data-s="rowRatios" placeholder="equal — e.g. 1,1,2" value="${esc(sh.rowRatios)}"></label>
      <div class="pair">
        <label class="field">Page margin (mm)<input type="number" min="0" step="0.5" data-s="margin" value="${sh.margin}"></label>
        <label class="field">Gutter (mm)<input type="number" min="0" step="0.5" data-s="gutter" value="${sh.gutter}"></label>
      </div>
      <label class="field">Binding
        <div class="seg"><button data-bind="pages" class="${sh.binding === 'fold' ? '' : 'on'}">Page after page</button><button data-bind="fold" class="${sh.binding === 'fold' ? 'on' : ''}">Cut &amp; fold each piece</button></div>
      </label>
      <p class="note">${sh.binding === 'fold'
        ? 'Each cell is cut out and folded down the middle (dashed line), then glued back to back with the next. Each piece opens as one spread. Preview book shows it that way.'
        : 'Each sheet is one page of the book.'}</p>`}
      <button class="btn small" id="applyAll">Apply selected cell's style to every cell</button>
      ${links.length ? `<div class="resources"><h2>Resources</h2>
        ${links.map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener"><b>${esc(r.title)}</b><small>${esc(r.by)} ↗</small></a>`).join('')}</div>` : ''}
    `;
    p.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { applyPreset(sh, b.dataset.preset); state.selected = null; renderAll(); }));
    p.querySelectorAll('[data-bs]').forEach((b) => (b.onclick = () => { sh.bookSize = b.dataset.bs; renderAll(); }));
    p.querySelectorAll('[data-pc]').forEach((b) => (b.onclick = () => {
      PB.resizeBook(sh, sh.pageCount + Number(b.dataset.pc));
      state.selected = null;
      renderAll();
    }));
    p.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { sh.view = b.dataset.v; renderAll(); }));
    p.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = () => setSpread(sh, b.dataset.sp, b.dataset.on === '1')));
    p.querySelectorAll('[data-bind]').forEach((b) => (b.onclick = () => { sh.binding = b.dataset.bind; renderAll(); }));
    p.querySelectorAll('[data-o]').forEach((b) => (b.onclick = () => { sh.orientation = b.dataset.o; renderAll(); }));
    p.querySelectorAll('[data-s]').forEach((el) => {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const k = el.dataset.s;
        if (el.type === 'checkbox') sh[k] = el.checked;
        else if (el.type === 'number') {
          let v = parseFloat(el.value);
          if (!isFinite(v)) return;
          if (k === 'rows' || k === 'cols') v = Math.max(1, Math.min(12, Math.round(v)));
          sh[k] = Math.max(0, v);
        } else sh[k] = el.value;
        ensureCells(sh);
        if (state.selected != null && state.selected >= PB.cellCount(sh)) state.selected = null;
        draw(); renderSheets(); renderCellPanel(); renderLibrary();
      });
    });
    $('applyAll').onclick = () => {
      if (state.selected == null) return status('Select a cell first', 2000);
      const src = sh.cells[state.selected];
      const keys = ['fit', 'pad', 'bg', 'capPos', 'capFont', 'capSize', 'capColor', 'capAlign'];
      for (const c of sh.cells) for (const k of keys) c[k] = src[k];
      draw();
    };
  }

  // ---------- cell panel ----------
  const icon = (d) => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = {
    left: icon('<path d="M3 5h14M3 9h9M3 13h14M3 17h9"/>'),
    center: icon('<path d="M3 5h14M5.5 9h9M3 13h14M5.5 17h9"/>'),
    right: icon('<path d="M3 5h14M8 9h9M3 13h14M8 17h9"/>'),
    above: icon('<rect x="4" y="8" width="12" height="9" rx="1"/><path d="M6.5 4.5h7"/>'),
    'overlay-top': icon('<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M7.5 6.5h5"/>'),
    center_v: icon('<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M7.5 10h5"/>'),
    'overlay-bottom': icon('<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M7.5 13.5h5"/>'),
    below: icon('<rect x="4" y="3" width="12" height="9" rx="1"/><path d="M6.5 15.5h7"/>'),
  };
  const NUMERIC = new Set(['rotate', 'capSize', 'zoom', 'pad', 'overlay', 'panX', 'panY']);

  function renderCellPanel() {
    const p = $('cellPanel');
    const sh = sheet();
    const i = state.selected;
    if (i != null && PB.hiddenCells(sh).has(i)) state.selected = null;
    if (i == null || !sh.cells[i] || i >= PB.cellCount(sh) || state.selected == null) {
      p.innerHTML = `
        <div class="empty-panel">
          <div class="big">←</div>
          <p><b>Pick a page or cell</b> on the sheet to add a photo, crop it, or set text.</p>
          <p class="note">Photos go into the PDF at full quality: JPEGs byte-for-byte, PNGs lossless. A badge appears on any photo printing below 240 dpi.</p>
        </div>`;
      return;
    }
    const c = sh.cells[i];
    const im = c.img && images.get(c.img);
    const geo = curGeo();
    const rect = rectFor(geo, i);
    const fr = rect && cellFrame(rect);
    const L = fr && cellLayout(c, fr.lw, fr.lh, im);
    const saddle = sh.mode === 'saddle';
    const pg = saddle ? Math.floor(i / 2) + 1 : null;
    const ssp = saddle && PB.saddleSpreadOf(sh, pg);
    const lay = saddle && PB.pageLayout(sh, pg);
    const title = saddle
      ? (ssp ? (ssp[1] === 1 ? 'Wraparound cover' : `Pages ${ssp[0]}–${ssp[1]}`) : PB.pageName(sh, pg) + (lay !== 'single' ? (i % 2 ? ' · photo 2' : ' · photo 1') : ''))
      : sh.mode === 'zine' && rect ? zinePageName(rect) : `Cell ${i + 1}`;
    const sizeMm = fr ? `${(fr.lw / MM).toFixed(0)} × ${(fr.lh / MM).toFixed(0)} mm` : '';
    const sp = sh.mode === 'zine' ? PB.ZINE_SPREADS.find((x) => x.includes(ZINE_PAGES[i]))
      : saddle && pg > 1 && pg < sh.pageCount ? (pg % 2 === 0 ? [pg, pg + 1] : [pg - 1, pg]) : null;
    const layoutCtl = saddle && !ssp ? `<div class="group"><label class="lbl">${esc(PB.pageName(sh, pg))} layout</label>
      <div class="seg">${Object.entries(PB.PAGE_LAYOUTS).map(([k, t]) => `<button data-pl="${k}" class="${lay === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>` : '';
    const spOn = sp && (sh.spreads || {})[PB.spreadKey(sp)];

    const isOn = (key, v) => String(c[key]).toLowerCase() === String(v).toLowerCase();
    const seg = (key, opts, cls = '') => `<div class="seg ${cls}">${opts.map(([v, label, tip]) =>
      `<button data-set="${key}" data-val="${esc(v)}" class="${isOn(key, v) ? 'on' : ''}" title="${esc(tip || '')}">${label}</button>`).join('')}</div>`;
    const swatches = (key, colors, allowNone) => {
      const cur = String(c[key] || '').toLowerCase();
      const custom = cur && !colors.includes(cur);
      return `<div class="swatches">
        ${allowNone ? `<button class="sw none ${!cur ? 'on' : ''}" data-set="${key}" data-val="" title="None"></button>` : ''}
        ${colors.map((col) => `<button class="sw ${cur === col ? 'on' : ''}" style="--sw:${col}" data-set="${key}" data-val="${col}" title="${col}"></button>`).join('')}
        <label class="sw custom ${custom ? 'on' : ''}" title="Pick any colour" style="--sw:${custom ? cur : 'transparent'}"><input type="color" data-k="${key}" value="${cur || '#ffffff'}"></label>
      </div>`;
    };
    let quality = '';
    if (im && L && L.dpi) {
      const cls = L.dpi < 150 ? 'bad' : L.dpi < 240 ? 'warn' : '';
      quality = `<div class="quality ${cls}">${L.dpi} dpi — ${L.dpi < 150 ? 'will look soft in print' : L.dpi < 240 ? 'OK, not crisp' : 'sharp'}</div>`;
    }
    const fontChips = Object.entries(FONTS).filter(([, f]) => !f.hidden).map(([n, f]) =>
      `<button class="chip ${c.capFont === n ? 'on' : ''}" data-set="capFont" data-val="${esc(n)}" style="font-family:${esc(f.css)}">${esc(n.replace('-Roman', ''))}</button>`).join('');

    p.innerHTML = `
      <div class="panel-head"><h3>${esc(title)}</h3><span>${sizeMm}</span></div>
      ${layoutCtl}
      ${saddle && (pg === 1 || pg === sh.pageCount) ? `<div class="group"><label class="lbl">Front + back cover</label>
        <div class="seg"><button data-csp="0" class="${ssp ? '' : 'on'}">Separate</button><button data-csp="1" class="${ssp ? 'on' : ''}">One photo wraps around</button></div></div>` : ''}
      ${sp ? `<div class="group"><label class="lbl">Pages ${sp[0]}–${sp[1]}</label>
        <div class="seg"><button data-csp="0" class="${spOn ? '' : 'on'}">Two photos</button><button data-csp="1" class="${spOn ? 'on' : ''}">One across both</button></div></div>` : ''}

      <div class="group">
        ${im ? `<div class="cell-img"><canvas id="cellThumb" width="${im.thumb.width}" height="${im.thumb.height}"></canvas>
            <div class="meta"><div title="${esc(im.name)}">${esc(im.name)}</div><div class="muted">${im.w}×${im.h}px · ${im.kind === 'jpg' ? 'JPEG' : 'PNG'}</div>
            <div class="links"><button class="link" id="pickImg">Replace</button><button class="link danger" id="clearImg">Remove</button></div></div></div>${quality}`
          : `<button class="dropbox" id="pickImg"><span>↑ Choose photo</span><small>or drop one here</small></button>`}
      </div>

      ${im ? `<div class="group">
        <label class="lbl">Photo</label>
        <div class="row2">${seg('fit', [['cover', 'Fill'], ['contain', 'Fit']])}${seg('rotate', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']])}</div>
        <label class="lbl">Zoom <span class="val" id="zoomVal">${Math.round(c.zoom * 100)}%</span></label>
        <input type="range" min="1" max="4" step="0.01" data-k="zoom" value="${c.zoom}">
        <label class="lbl">Position <span class="hintx">or drag the photo</span></label>
        <div class="row2"><input type="range" min="-1" max="1" step="0.01" data-k="panX" value="${c.panX}" title="Left / right"><input type="range" min="-1" max="1" step="0.01" data-k="panY" value="${c.panY}" title="Up / down"></div>
        <button class="link" id="resetCell">Reset crop</button>
      </div>` : ''}

      <div class="group">
        <div class="row2">
          <div><label class="lbl">Padding mm</label><input class="num" type="number" min="0" step="0.5" data-k="pad" value="${c.pad}"></div>
          <div><label class="lbl">Background</label>${swatches('bg', ['#ffffff', '#111111'], true)}</div>
        </div>
      </div>

      <div class="group">
        <label class="lbl">Text</label>
        <textarea data-k="caption" placeholder="Title, caption or sign text">${esc(c.caption)}</textarea>
        <label class="lbl">Font</label>
        <div class="chips">${fontChips}</div>
        <div class="row2">
          <div><label class="lbl">Size</label><div class="sizes">${seg('capSize', [[9, 'S'], [16, 'M'], [28, 'L']])}<input class="num" type="number" min="4" max="400" step="0.5" data-k="capSize" value="${c.capSize}" title="Points"></div></div>
          <div><label class="lbl">Colour</label>${swatches('capColor', ['#ffffff', '#111111'])}</div>
        </div>
        <div class="row2">
          <div><label class="lbl">Horizontal</label>${seg('capAlign', [['left', ICONS.left, 'Left'], ['center', ICONS.center, 'Centre'], ['right', ICONS.right, 'Right']], 'icons')}</div>
          <div><label class="lbl">Placement</label>${seg('capPos', [['above', ICONS.above, 'Above the photo'], ['overlay-top', ICONS['overlay-top'], 'On photo, top'], ['center', ICONS.center_v, 'On photo, middle'], ['overlay-bottom', ICONS['overlay-bottom'], 'On photo, bottom'], ['below', ICONS.below, 'Below the photo']], 'icons')}</div>
        </div>
        ${im ? `<label class="lbl">Overlay <span class="val" id="ovVal">${Math.round(c.overlay * 100)}%</span></label>
        <div class="overlay-row"><input type="range" min="0" max="0.8" step="0.05" data-k="overlay" value="${c.overlay}">${swatches('overlayColor', ['#ffffff', '#000000'])}</div>` : ''}
      </div>
    `;

    if (im) $('cellThumb').getContext('2d').drawImage(im.thumb, 0, 0);
    p.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.set, v = b.dataset.val;
      c[k] = NUMERIC.has(k) ? Number(v) : v;
      draw();
      renderCellPanel();
    }));
    p.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      el.addEventListener('input', () => {
        if (NUMERIC.has(k)) {
          const v = parseFloat(el.value);
          if (!isFinite(v)) return;
          c[k] = v;
        } else c[k] = el.value;
        if (k === 'zoom') $('zoomVal').textContent = Math.round(c.zoom * 100) + '%';
        if (k === 'overlay') $('ovVal').textContent = Math.round(c.overlay * 100) + '%';
        draw();
        updateQuality();
      });
      // Re-render after colour picks / typed sizes so swatch + S/M/L highlights follow.
      if (el.type === 'color' || (el.type === 'number' && k === 'capSize')) el.addEventListener('change', () => renderCellPanel());
    });
    p.querySelectorAll('[data-pl]').forEach((b) => (b.onclick = () => {
      sh.pageLayouts = { ...(sh.pageLayouts || {}), [pg]: b.dataset.pl };
      if (b.dataset.pl === 'single') state.selected = (pg - 1) * 2;
      renderAll();
    }));
    p.querySelectorAll('[data-csp]').forEach((b) => (b.onclick = () => setSpread(sh, sp ? PB.spreadKey(sp) : 'wrap', b.dataset.csp === '1')));
    const pick = $('pickImg');
    pick.onclick = () => openPicker(state.current, i);
    if (!im) {
      pick.addEventListener('dragover', (e) => { e.preventDefault(); pick.classList.add('over'); });
      pick.addEventListener('dragleave', () => pick.classList.remove('over'));
      pick.addEventListener('drop', async (e) => {
        e.preventDefault();
        const lib = e.dataTransfer.getData('text/x-photo');
        if (lib) { c.img = lib; return renderAll(); }
        const recs = await ingestFiles(e.dataTransfer.files);
        if (recs.length) { placeFrom(recs, state.current, i); renderAll(); }
      });
    }
    if (im) {
      $('clearImg').onclick = () => { c.img = null; renderAll(); };
      $('resetCell').onclick = () => { Object.assign(c, { zoom: 1, panX: 0, panY: 0 }); draw(); renderCellPanel(); };
    }
  }

  function updateQuality() {
    const sh = sheet(), i = state.selected, c = sh.cells[i];
    const im = c && c.img && images.get(c.img);
    const el = document.querySelector('#cellPanel .quality');
    const geo = curGeo();
    if (!im || !el || !geo) return;
    const fr = cellFrame(rectFor(geo, i));
    const L = cellLayout(c, fr.lw, fr.lh, im);
    if (!L.dpi) return;
    el.className = 'quality ' + (L.dpi < 150 ? 'bad' : L.dpi < 240 ? 'warn' : '');
    el.textContent = `${L.dpi} dpi — ${L.dpi < 150 ? 'will look soft in print' : L.dpi < 240 ? 'OK, not crisp' : 'sharp'}`;
  }

  // Switching a spread to "one across" keeps the left page's photo (or takes the right one's
  // if the left is empty); the right page's content is kept, just hidden, so switching back restores it.
  function setSpread(sh, key, on) {
    let L, R;
    if (sh.mode === 'saddle' && key === 'wrap') {
      L = 0; R = (sh.pageCount - 1) * 2; // front cover keeps the photo; back cover's is hidden
    } else if (sh.mode === 'saddle') {
      const l = Number(key.slice(0, key.length / 2)); // keys are "23", "45", ... "1011"
      L = (l - 1) * 2; R = l * 2;
    } else {
      const sp = PB.ZINE_SPREADS.find((x) => PB.spreadKey(x) === key);
      L = ZINE_PAGES.indexOf(sp[0]); R = ZINE_PAGES.indexOf(sp[1]);
    }
    sh.spreads = { ...(sh.spreads || {}), [key]: on };
    if (on && !sh.cells[L].img && sh.cells[R].img) { sh.cells[L].img = sh.cells[R].img; sh.cells[R].img = null; }
    if (state.selected === R && on) state.selected = L;
    renderAll();
  }

  function renderAll() {
    $('paper').value = state.paper;
    syncFrames();
    drawAll();
    renderSheets();
    renderSheetPanel();
    renderCellPanel();
    renderLibrary();
  }

  // ---------- top bar ----------
  $('paper').onchange = (e) => { state.paper = e.target.value; renderAll(); };
  $('addSheet').onclick = () => {
    // On a fold & staple book, "+ Sheet" adds one more folded sheet (4 pages) to that book.
    const cur = sheet();
    if (cur.mode === 'saddle') {
      if (cur.pageCount >= PB.MAX_PAGES) return status(`A stapled book tops out at ${PB.MAX_PAGES} pages`, 3000);
      PB.resizeBook(cur, cur.pageCount + 4);
      renderAll();
      return status(`Added a sheet — now ${cur.pageCount} pages. New pages go before the back cover.`, 3500);
    }
    state.sheets.push(cloneLayout(sheet()));
    state.current = state.sheets.length - 1;
    state.selected = null;
    renderAll();
    setCurrent(state.current, true);
  };
  $('addPhotos').onchange = async (e) => {
    const recs = await ingestFiles(e.target.files);
    e.target.value = '';
    fillCells(recs, state.current, 0);
    renderAll();
  };

  // ---------- flip-through preview ----------
  // Zines and stapled books are one book each; runs of ordinary sheets are read page after page,
  // like loose prints glued into a book. Pages are drawn with the same code as the editor.
  function previewBooks() {
    const books = [];
    let glued = null;
    state.sheets.forEach((sh, si) => {
      if (sh.mode === 'grid') {
        const fold = sh.binding === 'fold';
        if (!glued || glued.fold !== fold) { glued = { sheets: [], first: si, last: si, fold }; books.push(glued); }
        glued.sheets.push(sh);
        glued.last = si;
        const range = glued.first === glued.last ? `Sheet ${si + 1}` : `Sheets ${glued.first + 1}–${glued.last + 1}`;
        glued.title = `${range} · ${fold ? 'cut, folded & glued back to back' : glued.first === glued.last ? 'single page' : 'page after page'}`;
        if (fold) glued.pages = () => foldedPages(glued.sheets);
      } else {
        glued = null;
        books.push({ sheets: [sh], first: si, last: si, title: `Sheet ${si + 1} · ${sh.mode === 'zine' ? '8-page zine' : `fold & staple, ${sh.pageCount} pages`}` });
      }
    });
    return books;
  }

  // Cut & fold binding: every cell is cut out and folded in half, photo inside, and the folded
  // pieces are glued back to back. Each piece is one open spread; the outsides are blank paper.
  function foldedPages(sheets) {
    const pieces = [];
    for (const sh of sheets) {
      const geo = cellRects(state.paper, sh);
      for (const r of geo.rects) pieces.push({ sh, r });
    }
    if (!pieces.length) return [];
    const blank = (w, h) => ({ W: w, H: h, rects: [] });
    const first = pieces[0].r;
    const pages = [blank(first.w / 2, first.h)];
    for (const { sh, r } of pieces) {
      const half = { x: 0, y: 0, w: r.w / 2, h: r.h };
      pages.push({ W: half.w, H: half.h, sheet: sh, rects: [{ ...r, x: 0, y: 0, clip: half }] });
      pages.push({ W: half.w, H: half.h, sheet: sh, rects: [{ ...r, x: -half.w, y: 0, clip: half }] });
    }
    const last = pieces[pieces.length - 1].r;
    pages.push(blank(last.w / 2, last.h));
    return pages;
  }

  const viewer = { el: $('viewer'), books: [], book: 0, flipped: 0, leaves: [] };

  function openViewer() {
    viewer.books = previewBooks();
    viewer.book = Math.max(0, viewer.books.findIndex((b) => state.current >= b.first && state.current <= b.last));
    $('bookPick').innerHTML = viewer.books.map((b, k) => `<option value="${k}">${esc(b.title)}</option>`).join('');
    $('bookPick').value = String(viewer.book);
    viewer.el.hidden = false;
    buildBook();
  }

  function closeViewer() { viewer.el.hidden = true; $('book').innerHTML = ''; }

  function buildBook() {
    const b = viewer.books[viewer.book];
    const pages = b.pages ? b.pages() : PB.outputPages({ paper: state.paper, sheets: b.sheets }, 'reading');
    // Size so an open spread fits the screen.
    const pw = Math.max(...pages.map((p) => p.W)), ph = Math.max(...pages.map((p) => p.H));
    const stage = $('bookStage');
    const k = Math.min((stage.clientWidth - 140) / (2 * pw), (stage.clientHeight - 40) / ph);
    const dpr = window.devicePixelRatio || 1;
    const book = $('book');
    book.innerHTML = '';
    book.style.width = 2 * pw * k + 'px';
    book.style.height = ph * k + 'px';

    const pageCanvas = (pg) => {
      const c = document.createElement('canvas');
      if (!pg) return c; // blank inside of the back cover
      c.width = Math.round(pg.W * k * dpr);
      c.height = Math.round(pg.H * k * dpr);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      for (const rect of pg.rects) paintCell(ctx, pg.sheet, rect, k * dpr, false, true);
      return c;
    };

    // Leaf n carries page 2n+1 on its front (right-hand side) and 2n+2 on its back.
    viewer.leaves = [];
    const n = Math.ceil(pages.length / 2);
    for (let i = 0; i < n; i++) {
      const leaf = document.createElement('div');
      leaf.className = 'leaf';
      const front = document.createElement('div'), back = document.createElement('div');
      front.className = 'face front';
      back.className = 'face back';
      front.appendChild(pageCanvas(pages[2 * i]));
      back.appendChild(pageCanvas(pages[2 * i + 1]));
      if (!pages[2 * i + 1]) back.classList.add('blank');
      leaf.append(front, back);
      book.appendChild(leaf);
      viewer.leaves.push(leaf);
    }
    viewer.pages = pages;
    viewer.flipped = 0;
    layoutLeaves(true);
  }

  function layoutLeaves(instant) {
    const n = viewer.leaves.length, f = viewer.flipped;
    viewer.leaves.forEach((leaf, i) => {
      if (instant) leaf.style.transition = 'none';
      const flipped = i < f;
      const was = leaf.classList.contains('flipped');
      leaf.classList.toggle('flipped', flipped);
      // A turning leaf rides above everything until it lands, then settles into its stack.
      const settled = flipped ? i + 1 : n - i;
      if (!instant && was !== flipped) {
        leaf.style.zIndex = 2 * n + 5;
        clearTimeout(leaf._t);
        leaf._t = setTimeout(() => (leaf.style.zIndex = settled), 820);
      } else leaf.style.zIndex = settled;
      if (instant) { void leaf.offsetWidth; leaf.style.transition = ''; }
    });
    // Closed book: only the cover shows, so slide it to the middle. Same for the back cover.
    const book = $('book');
    book.classList.toggle('closed-front', f === 0);
    book.classList.toggle('closed-back', f === n && viewer.pages.length % 2 === 0);
    const total = viewer.pages.length;
    const left = f > 0 ? 2 * f : null, right = f < n ? 2 * f + 1 : null;
    const name = (p) => (p === 1 && total > 1 ? 'Cover' : p === total && total > 2 ? 'Back cover' : `Page ${p}`);
    $('pageInfo').textContent = left && right && right <= total ? `Pages ${left}–${right} of ${total}` : name(left || right) + ` · ${total} pages`;
    $('flipPrev').disabled = f === 0;
    $('flipNext').disabled = f === n;
  }

  function flip(dir) {
    const f = viewer.flipped + dir;
    if (f < 0 || f > viewer.leaves.length) return;
    viewer.flipped = f;
    layoutLeaves(false);
  }

  $('previewBtn').onclick = openViewer;
  $('closeViewer').onclick = closeViewer;
  $('flipPrev').onclick = () => flip(-1);
  $('flipNext').onclick = () => flip(1);
  $('bookPick').onchange = (e) => { viewer.book = Number(e.target.value); buildBook(); };
  $('book').addEventListener('click', (e) => {
    const b = $('book').getBoundingClientRect();
    flip(e.clientX > b.left + b.width / 2 ? 1 : -1);
  });
  viewer.el.addEventListener('click', (e) => { if (e.target === viewer.el || e.target.id === 'bookStage') closeViewer(); });
  document.addEventListener('keydown', (e) => {
    if (viewer.el.hidden) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); flip(1); }
    else if (e.key === 'ArrowLeft') flip(-1);
    else if (e.key === 'Escape') closeViewer();
  });
  window.addEventListener('resize', () => { if (!viewer.el.hidden) buildBook(); });

  // Export menu: print (imposed), reading order, proof, and manual-duplex halves.
  const menu = $('exportMenu');
  $('exportPdf').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  menu.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { menu.hidden = true; exportPdf(b.dataset.kind); }));

  // Shows the generated file in the browser's own PDF viewer before saving it.
  let pdfUrl = null;
  function showPdf(bytes, name, tip) {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    pdfUrl = URL.createObjectURL(blob);
    $('pdfFrame').src = pdfUrl + '#view=Fit'; // open showing whole pages
    $('pdfName').textContent = name;
    const size = bytes.length >= 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
    $('pdfInfo').textContent = `${size} · ${tip}`;
    $('pdfDownload').onclick = () => download(blob, name);
    $('pdfModal').hidden = false;
  }
  function closePdf() {
    $('pdfModal').hidden = true;
    $('pdfFrame').src = 'about:blank';
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
  }
  $('pdfClose').onclick = closePdf;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pdfModal').hidden) closePdf(); });

  async function exportPdf(kind) {
    const btn = $('exportPdf');
    btn.disabled = true;
    status('Building PDF…');
    try {
      const bytes = await PB.buildPdf(PDFLib, { paper: state.paper, sheets: state.sheets, title: 'Photobook' }, images,
        { fontkit: window.fontkit, fontBytes, kind, rotateBacks: $('rotateBacks').checked });
      const tip = kind === 'reading' ? 'Pages in reading order.'
        : kind === 'backs' ? 'Put the printed stack back in, then print this.'
        : 'Print at 100% / "Actual size"' + (state.sheets.some((s) => s.mode === 'saddle') && kind !== 'fronts' ? ', double-sided, flip on short edge.' : '.');
      status('');
      showPdf(bytes, kind === 'print' ? 'photobook.pdf' : `photobook-${kind}.pdf`, tip);
    } catch (err) {
      console.error(err);
      status('Export failed: ' + err.message, 8000);
    } finally {
      btn.disabled = false;
    }
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  const toB64 = (bytes) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1));
    r.readAsDataURL(new Blob([bytes]));
  });
  const fromB64 = async (b64) => new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer());

  $('saveProject').onclick = async () => {
    status('Saving…');
    const imgs = [];
    for (const im of images.values()) imgs.push({ id: im.id, name: im.name, data: await toB64(im.bytes) });
    const json = JSON.stringify({ app: 'photobook', version: 1, paper: state.paper, sheets: state.sheets, images: imgs });
    download(new Blob([json], { type: 'application/json' }), 'photobook-project.json');
    status('Project saved (photos included at full quality)', 3000);
  };

  $('openProject').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'photobook') throw new Error('not a Photobook project file');
      images.clear();
      for (let k = 0; k < data.images.length; k++) {
        const it = data.images[k];
        status(`Loading photo ${k + 1}/${data.images.length}`);
        await addImage(await fromB64(it.data), it.name, { id: it.id });
        const n = parseInt(String(it.id).replace(/\D/g, ''), 10);
        if (n >= nextId) nextId = n + 1;
      }
      state.paper = data.paper;
      state.sheets = data.sheets.map((s) => ({ ...s, cells: s.cells.map((c) => ({ ...newCell(), ...c })) }));
      state.current = 0;
      state.selected = null;
      status('');
      renderAll();
    } catch (err) {
      status("Couldn't open project: " + err.message, 6000);
    }
  };

  window.addEventListener('resize', () => drawAll());
  // Pasting images from the clipboard
  window.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    const recs = await ingestFiles(files);
    if (state.selected != null && recs[0]) sheet().cells[state.selected].img = recs[0].id;
    else fillCells(recs, state.current, 0);
    renderAll();
  });

  // Bundled fonts are registered from data (file:// pages can't fetch font files), then sheets redraw.
  function fontBytes(file) {
    return Uint8Array.from(atob(window.PB_FONT_DATA[file]), (ch) => ch.charCodeAt(0));
  }
  const faces = [];
  for (const [name, f] of Object.entries(FONTS)) {
    if (!f.file || !window.PB_FONT_DATA || !window.PB_FONT_DATA[f.file]) continue;
    const face = new FontFace(`PB ${name}`, fontBytes(f.file).buffer);
    document.fonts.add(face);
    faces.push(face.load().catch(() => {}));
  }
  Promise.all(faces).then(() => drawAll());

  renderAll();
})();
