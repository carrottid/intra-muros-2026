/* =====================================================================
   인트라 무로스 정산판 — 동작
   ===================================================================== */
(function () {
  'use strict';

  const STORAGE_KEY = 'im2026-settlement-v1';
  const SHOWS = SCHEDULE.filter(r => !r.off);
  const ROLE_IDX = Object.fromEntries(ROLES.map((r, i) => [r.key, i]));
  const HAS_BANDS = BANDS.length > 0;
  const HAS_TAGS = SCHEDULE.some(r => r.tags && r.tags.length);
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- 상태 ---------------- */
  let state = { version: 1, seats: {}, updatedAt: null };
  const selected = new Set();          // 'roleKey:actor'
  const missingImg = new Set();        // 없는 사진 경로 (재요청 방지)

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          state.seats = cleanSeats((obj.seats && typeof obj.seats === 'object') ? obj.seats : {});
          state.updatedAt = obj.updatedAt || null;
        }
      }
    } catch (e) { /* 저장소 사용 불가 — 메모리로만 동작 */ }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.updatedAt = new Date().toISOString();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        const t = new Date();
        $('#save-state').textContent = '저장됨 ' + t.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        $('#save-state').textContent = '이 브라우저에는 저장할 수 없습니다 — JSON 저장을 이용하세요';
      }
    }, 250);
  }

  /* ---------------- 좌석 코드 ---------------- */
  // B-3-12 / b 3 12 / B구역 3열 12번 / 1F-B-3-12 등 허용
  const SEAT_RE = /^\s*(?:1\s*(?:F|층)\s*[-\s/·.]*)?([ABC])\s*(?:구역)?\s*[-\s/·.]*\s*(\d{1,2})\s*(?:열)?\s*[-\s/·.]*\s*(\d{1,2})\s*(?:번)?\s*$/i;
  function parseSeat(str) {
    if (!str) return null;
    const m = SEAT_RE.exec(str);
    if (!m) return null;
    const key = `${m[1].toUpperCase()}-${+m[2]}-${+m[3]}`;
    const s = SEAT_INDEX[key];
    if (!s) return null;
    return { sec: s.sec, row: s.row, num: s.num, key };
  }

  /* ---------------- 집계 ---------------- */
  const NO_SEAT = '0000';   // 좌석 미기재: 관람으로 집계되지만 좌석배치도에는 표시하지 않음
  function normalizeSeat(str) {
    const v = (str || '').trim();
    if (!v) return '';
    if (v === NO_SEAT) return NO_SEAT;
    const p = parseSeat(v);
    return p ? p.key : null;          // null = 형식이 틀리거나 없는 좌석
  }
  function attended(id) { const n = normalizeSeat(state.seats[id]); return n != null && n !== ''; }
  function cleanSeats(seats) {        // 저장/불러오기 시 유효하지 않은 값 제거
    const out = {};
    Object.entries(seats || {}).forEach(([k, v]) => { const n = normalizeSeat(v); if (n) out[k] = n; });
    return out;
  }

  function computeStats() {
    const perActor = {};   // 'roleKey:actor' -> {total, seen}
    ROLES.forEach(r => r.actors.forEach(a => { perActor[r.key + ':' + a] = { total: 0, seen: 0 }; }));
    const seatCounts = {};
    let totalSeen = 0;
    for (const s of SHOWS) {
      const seen = attended(s.id);
      if (seen) totalSeen++;
      s.cast.forEach((a, i) => {
        const k = ROLES[i].key + ':' + a;
        if (!perActor[k]) perActor[k] = { total: 0, seen: 0 };
        perActor[k].total++; if (seen) perActor[k].seen++;
      });
      if (seen) {
        const p = parseSeat(state.seats[s.id]);
        if (p) seatCounts[p.key] = (seatCounts[p.key] || 0) + 1;
      }
    }
    const maxCount = Math.max(0, ...Object.values(seatCounts));
    return { perActor, seatCounts, maxCount, totalSeen, totalAll: SHOWS.length };
  }

  /* ---------------- 색 보간 (흰색 → 강조색) ---------------- */
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  const ACC = hexToRgb(ACCENT);
  function seatColor(count, max) {
    if (count <= 1 || max <= 1) return '#ffffff';
    const t = (count - 1) / (max - 1);            // 0 = 흰색, 1 = 강조색
    const c = [255, 255, 255].map((w, i) => Math.round(w + (ACC[i] - w) * t));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  /* ---------------- 필터 UI ---------------- */
  function renderFilter() {
    const box = $('#filter-groups');
    let html = '';
    ROLES.forEach(r => {
      html += `<div class="filter-group"><span class="filter-role">${esc(r.name)}</span><div class="filter-chips">`;
      r.actors.forEach(a => {
        const k = r.key + ':' + a;
        html += `<button type="button" class="chip${selected.has(k) ? ' on' : ''}" data-k="${esc(k)}">${esc(a)}</button>`;
      });
      html += '</div></div>';
    });
    html += `<div class="filter-group"><span class="filter-role"></span><div class="filter-chips"><button type="button" class="chip all${selected.size ? '' : ' on'}" data-k="__all">전체 보기</button></div></div>`;
    box.innerHTML = html;
  }

  function visibleRows() {
    if (!selected.size) return SCHEDULE.slice();
    const byRole = {};
    selected.forEach(k => { const [rk, a] = k.split(':'); (byRole[rk] = byRole[rk] || new Set()).add(a); });
    return SCHEDULE.filter(r => !r.off && Object.entries(byRole).every(([rk, set]) => set.has(r.cast[ROLE_IDX[rk]])));
  }

  function renderSummary(stats) {
    const el = $('#filter-summary');
    if (!selected.size) {
      el.innerHTML = `전체 <b>${stats.totalAll}</b>회 중 <b>${stats.totalSeen}</b>회 관람`;
      return;
    }
    const byRole = {};
    selected.forEach(k => { const [rk, a] = k.split(':'); (byRole[rk] = byRole[rk] || []).push(a); });
    const parts = ROLES.filter(r => byRole[r.key]).map(r => byRole[r.key].join(' / '));
    const rows = visibleRows();
    const seen = rows.filter(r => attended(r.id)).length;
    el.innerHTML = `<span class="pair"><b>${parts.map(esc).join(' × ')}</b></span> — 해당 회차 <b>${rows.length}</b>회 중 <b>${seen}</b>회 관람`;
  }

  /* ---------------- 스케줄표 ---------------- */
  const ORDER = Object.fromEntries(SCHEDULE.map((r, i) => [r.id, i]));
  function bandOf(col, id) {
    const i = ORDER[id];
    return BANDS.find(b => b.col === col && i >= ORDER[b.from] && i <= ORDER[b.to]) || null;
  }
  const pad2 = n => String(n).padStart(2, '0');
  function dateLong(d) { const [m, day] = d.split('.'); return `${m}월 ${pad2(day)}일`; }

  function renderSchedule() {
    const rows = visibleRows();
    // 밴드 셀 계획: rowspan 계산 (BANDS 가 있을 때만)
    const plan = rows.map(() => [null, null]);
    if (HAS_BANDS) {
      for (const col of [0, 1]) {
        let i = 0;
        while (i < rows.length) {
          const b = bandOf(col, rows[i].id);
          if (!b) { plan[i][col] = { empty: true }; i++; continue; }
          let j = i;
          while (j < rows.length && bandOf(col, rows[j].id) === b) j++;
          plan[i][col] = { band: b, span: j - i };
          for (let k = i + 1; k < j; k++) plan[k][col] = { skip: true };
          i = j;
        }
      }
    }
    const bandCell = p => {
      if (p.skip) return '';
      if (p.empty) return '<td class="band"></td>';
      const label = p.span >= 3 ? esc(p.band.label) : '';
      return `<td class="band" rowspan="${p.span}"><div class="band-in" style="background:${p.band.color}" title="${esc(p.band.label)}"><span>${label}</span></div></td>`;
    };
    const bandCells = idx => HAS_BANDS ? bandCell(plan[idx][0]) + bandCell(plan[idx][1]) : '';

    let html = '<thead><tr>' + (HAS_BANDS ? '<th class="band"></th><th class="band"></th>' : '') +
      '<th class="date">일시</th><th class="wd">요일</th><th class="time">시간</th>';
    ROLES.forEach(r => { html += `<th class="cast">${esc(r.name)}</th>`; });
    html += '<th class="seat">좌석</th>' + (HAS_TAGS ? '<th class="tags"></th>' : '') + '</tr></thead><tbody>';

    rows.forEach((r, idx) => {
      const prev = rows[idx - 1];
      const cont = !!prev && !prev.off && !r.off && prev.d === r.d;        // 같은 날의 두 번째 회차
      let span = 1;
      if (!cont && !r.off) { let j = idx + 1; while (j < rows.length && !rows[j].off && rows[j].d === r.d) { span++; j++; } }
      const dcls = r.off ? 'off' : (r.hol || r.w === '일') ? 'sun' : r.w === '토' ? 'sat' : '';
      const dateCells = `<td class="cell date ${dcls}" rowspan="${span}"><span class="d-long">${esc(dateLong(r.d))}</span><span class="d-short">${esc(r.d)}</span><span class="w">${esc(r.w)}</span></td><td class="cell wd ${dcls}" rowspan="${span}">${esc(r.w)}</td>`;
      if (r.off) {
        html += `<tr class="off">${bandCells(idx)}${dateCells}<td class="cell offcell" colspan="${ROLES.length + 2}">공연없음</td>${HAS_TAGS ? '<td class="tags"></td>' : ''}</tr>`;
        return;
      }
      const seen = attended(r.id);
      html += `<tr data-id="${r.id}" class="${seen ? 'seen' : ''}${cont ? ' cont' : ''}">${bandCells(idx)}${cont ? '' : dateCells}`;
      const val = state.seats[r.id] || '';
      const cls = val.trim() ? (normalizeSeat(val) ? 'filled' : 'invalid') : '';
      const tagsHtml = (r.tags || []).map(t => `<span class="tag" style="background:${TAGS[t].color}">${esc(TAGS[t].label)}</span>`).join('');
      html += `<td class="cell time ${dcls}"><span class="t">${esc(r.t)}</span>${tagsHtml ? `<div class="d-tags">${tagsHtml}</div>` : ''}</td>`;
      r.cast.forEach((a, i) => {
        const hit = selected.has(ROLES[i].key + ':' + a);
        let badge = '';
        if (r.first && r.first.includes(i)) badge = '<span class="badge first">첫공</span>';
        else if (r.last && r.last.includes(i)) badge = '<span class="badge last">막공</span>';
        html += `<td class="cell cast${hit ? ' hit' : ''}"><span class="nm">${esc(a)}${badge}</span></td>`;
      });
      html += `<td class="cell seat"><input class="seat-input${cls ? ' ' + cls : ''}" data-id="${r.id}" value="${esc(val)}" placeholder="B-3-12" autocomplete="off" spellcheck="false"></td>`;
      if (HAS_TAGS) html += `<td class="tags">${tagsHtml}</td>`;
      html += '</tr>';
    });
    html += '</tbody>';
    $('#sched').innerHTML = html;
  }

  /* ---------------- 사진 슬롯 ---------------- */
  function photo(src, name) {
    if (missingImg.has(src)) return `<div class="p-photo"><span class="ph">${esc(name)}</span></div>`;
    return `<div class="p-photo"><img src="${src}" alt="" data-src="${src}"><span class="ph">${esc(name)}</span></div>`;
  }
  function bindPhotos(root) {
    $$('.p-photo img', root).forEach(img => {
      const mark = () => { img.parentElement.classList.add('has-img'); };
      if (img.complete && img.naturalWidth > 0) mark();
      else {
        img.addEventListener('load', mark);
        img.addEventListener('error', () => { missingImg.add(img.dataset.src); img.remove(); });
      }
    });
  }
  const countHtml = (seen, total) => `<div class="p-count"><span class="seen${seen ? '' : ' zero'}">${seen}</span><span class="of">/ ${total}</span></div>`;

  /* ---------------- 좌석배치도 SVG ---------------- */
  function seatmapSvg(stats) {
    const P = 12, S = 10, M = 6;                 // 칸 간격, 좌석 크기, 여백
    const X = gx => M + gx * P, Y = gy => M + gy * P;
    const W = M * 2 + SEATMAP.cols * P, H = M * 2 + SEATMAP.rows * P;
    const emptyFill = '#182e46', emptyStroke = '#2e4a66';
    let out = '';
    const st = SEATMAP.stage;
    const sx = X(st.gx0), sy = Y(st.gy0), sw = (st.gx1 - st.gx0) * P - (P - S), sh = (st.gy1 - st.gy0) * P - (P - S);
    out += `<rect class="stage" x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="2"/>`;
    out += `<text class="stage-t" x="${sx + sw / 2}" y="${sy + sh / 2 + 4}" font-size="11" text-anchor="middle">STAGE</text>`;
    SEATMAP.labels.forEach(l => {
      out += `<text class="lbl" x="${X(l.gx) + S / 2}" y="${Y(l.gy) + S / 2 + 3}" font-size="8.5" text-anchor="middle">${esc(l.text)}</text>`;
    });
    (SEATMAP.wheelchair || []).forEach(w => {
      out += `<rect class="wc" x="${X(w.gx)}" y="${Y(w.gy)}" width="${S}" height="${S}" rx="1.5"/>`;
    });
    SEATS.forEach(s => {
      const c = stats.seatCounts[s.key];
      const fill = c ? seatColor(c, stats.maxCount) : emptyFill;
      const stroke = c ? 'rgba(0,0,0,.35)' : emptyStroke;
      out += `<rect x="${X(s.gx)}" y="${Y(s.gy)}" width="${S}" height="${S}" rx="1.5" fill="${fill}" stroke="${stroke}" stroke-width=".8"/>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`;
  }

  function legendHtml(stats) {
    const max = stats.maxCount;
    if (max < 1) return '<span><span class="sw" style="background:#fff"></span>1회</span>';
    if (max <= 7) {
      let h = '';
      for (let c = 1; c <= Math.max(max, 2); c++) h += `<span><span class="sw" style="background:${seatColor(c, Math.max(max, 2))}"></span>${c}회</span>`;
      return h;
    }
    return `<span>1회<span class="bar" style="background:linear-gradient(to right,#ffffff,${ACCENT})"></span>${max}회</span>`;
  }

  /* ---------------- 정산판 ---------------- */
  function renderPoster(stats) {
    const actorHtml = (r, a, i) => {
      const st = stats.perActor[r.key + ':' + a];
      return `<div class="p-actor">${photo(`images/cast/${r.key}-${i + 1}.jpg`, a)}<div class="p-name">${esc(a)}</div>${countHtml(st.seen, st.total)}</div>`;
    };
    const title = (name, en) => `<div class="p-group-title"><span>${esc(name)}</span>${en ? `<small>${esc(en)}</small>` : ''}</div>`;
    const group = r => `<div class="p-group">${title(r.name, r.en)}<div class="p-row">${r.actors.map((a, i) => actorHtml(r, a, i)).join('')}</div></div>`;

    // 가로형: 1줄 앙쥬·케빈·알리스 / 2줄 리샤르·잔느·(좌석배치도 + 관람 기록)
    ROLES.forEach((r, i) => {
      const cell = $(`#posterA .p-cell[data-role="${i}"]`);
      cell.innerHTML = group(r);
      bindPhotos(cell);
    });
  }

  /* ---------------- 공통 렌더 ---------------- */
  function renderPosters() {
    const stats = computeStats();
    renderPoster(stats);
    $$('[data-total-seen]').forEach(el => { el.textContent = stats.totalSeen; });
    $$('[data-total-all]').forEach(el => { el.textContent = stats.totalAll; });
    const svg = seatmapSvg(stats), legend = legendHtml(stats);
    $$('[data-seatmap]').forEach(el => { el.innerHTML = svg; });
    $$('[data-legend]').forEach(el => { el.innerHTML = legend; });
    renderSummary(stats);
    fitPosters();
  }

  function fitPosters() {
    $$('.poster-viewport').forEach(vp => {
      const poster = $('.poster', vp);
      const w = +vp.dataset.w;
      vp.style.width = '';                                   // 사용 가능한 폭을 먼저 재고
      const scale = Math.min(1, vp.clientWidth / w);
      poster.style.transform = `scale(${scale})`;
      vp.style.width = Math.round(w * scale) + 'px';         // 축소된 정산판 폭에 맞춰 가운데 정렬 (margin: 0 auto)
      vp.style.height = Math.ceil(poster.offsetHeight * scale) + 'px';
    });
  }

  /* ---------------- PNG 저장 ----------------
     html2canvas는 글꼴의 기준선(baseline)을 자체 프로브로 측정하는데, 한글 폰트에서
     실제와 다르게 나와 글자가 위아래로 어긋날 수 있다. 내보내기 직전에 요소별로
     (html2canvas가 쓸 기준선 − 브라우저의 실제 기준선)만큼 글자를 보정한다. */
  const H2C_SMALL_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const probeCache = new Map();
  function h2cBaseline(fontFamily, fontSize) {
    const key = fontFamily + '|' + fontSize;
    if (probeCache.has(key)) return probeCache.get(key);
    const c = document.createElement('div'), img = document.createElement('img'), span = document.createElement('span');
    c.style.cssText = 'visibility:hidden;margin:0;padding:0;white-space:nowrap;position:absolute;top:0;left:-9999px';
    c.style.fontFamily = fontFamily; c.style.fontSize = fontSize;
    document.body.appendChild(c);
    img.src = H2C_SMALL_IMAGE; img.width = 1; img.height = 1;
    img.style.cssText = 'margin:0;padding:0;vertical-align:baseline';
    span.style.cssText = 'margin:0;padding:0';
    span.style.fontFamily = fontFamily; span.style.fontSize = fontSize;
    span.appendChild(document.createTextNode('Hidden Text'));
    c.appendChild(span); c.appendChild(img);
    const baseline = img.offsetTop - span.offsetTop + 2;
    c.remove();
    probeCache.set(key, baseline);
    return baseline;
  }
  const measureCtx = document.createElement('canvas').getContext('2d');
  function compensateText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(node => {
      const el = node.parentElement;
      if (!el) return;
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;   // SVG 텍스트(좌석배치도 라벨)는 건드리지 않음
      const cs = getComputedStyle(el);
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = measureCtx.measureText(node.textContent);
      const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
      if (!asc) return;
      const natural = asc + desc;
      const lh = cs.lineHeight === 'normal' ? natural : parseFloat(cs.lineHeight);
      const browserBaseline = (lh - natural) / 2 + asc;          // 브라우저가 그리는 기준선
      const canvasBaseline = h2cBaseline(cs.fontFamily, cs.fontSize);  // html2canvas가 쓸 기준선
      const shift = canvasBaseline - browserBaseline;
      if (Math.abs(shift) < 0.5) return;
      const wrap = document.createElement('span');
      wrap.style.cssText = `position:relative;top:${(-shift).toFixed(2)}px`;
      node.parentNode.replaceChild(wrap, node);
      wrap.appendChild(node);
    });
  }

  async function exportPoster(id, name, btn) {
    const src = document.getElementById(id);
    btn.disabled = true; const label = btn.textContent; btn.textContent = '생성 중…';
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:-100000px;top:0;width:${src.offsetWidth}px;`;
    const clone = src.cloneNode(true);
    clone.style.transform = 'none';
    clone.classList.add('exporting');
    holder.appendChild(clone);
    document.body.appendChild(holder);
    compensateText(clone);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const canvas = await html2canvas(clone, {
        scale: 2, backgroundColor: '#0a1c2e', useCORS: true, logging: false,
        width: src.offsetWidth, height: src.offsetHeight, windowWidth: src.offsetWidth, windowHeight: src.offsetHeight,
      });
      await new Promise(res => canvas.toBlob(blob => { downloadBlob(blob, name + '.png'); res(); }, 'image/png'));
    } catch (e) {
      alert('이미지 생성에 실패했습니다.\n' + (e && e.message ? e.message : e));
    } finally {
      holder.remove();
      btn.disabled = false; btn.textContent = label;
    }
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- JSON ---------------- */
  function exportJson() {
    const data = { app: 'intra-muros-2026', version: 1, seats: state.seats, exportedAt: new Date().toISOString() };
    const d = new Date(), ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `인트라무로스-정산-${ymd}.json`);
  }
  /* 지원하는 JSON 형식
     1) 이 사이트의 저장 파일: { seats: { "1110-2000": "B-3-12", ... } }
     2) 회차 목록 배열: [ { sid: "1110-2000", ..., seats: ["B-3-12"] }, ... ]  (seats 배열의 첫 좌석 사용, 비어 있으면 미관람) */
  const KNOWN_IDS = new Set(SHOWS.map(s => s.id));
  function seatsFromAnyJson(obj) {
    if (Array.isArray(obj)) {
      const out = {};
      obj.forEach(item => {
        if (!item || typeof item !== 'object' || !KNOWN_IDS.has(item.sid)) return;
        const list = Array.isArray(item.seats) ? item.seats : (typeof item.seats === 'string' ? [item.seats] : []);
        const first = list.find(v => typeof v === 'string' && v.trim());
        if (first) out[item.sid] = first.trim();
      });
      return out;
    }
    if (obj && typeof obj === 'object' && obj.seats && typeof obj.seats === 'object' && !Array.isArray(obj.seats)) return obj.seats;
    return null;
  }
  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        const raw = seatsFromAnyJson(obj);
        if (!raw) throw new Error('형식이 맞지 않습니다');
        const cleaned = cleanSeats(raw);
        const n = Object.keys(cleaned).length;
        if (!confirm(`불러온 데이터(관람 ${n}회)로 현재 기록을 덮어씁니다. 계속할까요?`)) return;
        state.seats = cleaned;
        save(); renderSchedule(); renderPosters();
      } catch (e) { alert('JSON을 읽을 수 없습니다: ' + e.message); }
    };
    reader.readAsText(file);
  }

  /* ---------------- 안내 토스트 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.innerHTML = msg; el.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
  }

  /* ---------------- 이벤트 ---------------- */
  function bind() {
    $('#filter-groups').addEventListener('click', e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      const k = btn.dataset.k;
      if (k === '__all') selected.clear();
      else if (selected.has(k)) selected.delete(k); else selected.add(k);
      renderFilter(); renderSchedule(); renderSummary(computeStats());
    });

    const table = $('#sched');
    table.addEventListener('input', e => {
      const inp = e.target.closest('.seat-input'); if (!inp) return;
      const id = inp.dataset.id, v = inp.value;
      if (v.trim()) state.seats[id] = v; else delete state.seats[id];
      const ok = !!normalizeSeat(v);
      const tr = inp.closest('tr');
      tr.classList.toggle('seen', ok);
      $$('.seat-input', tr).forEach(el => {
        if (el !== inp) el.value = v;
        el.classList.toggle('filled', ok);
        el.classList.toggle('invalid', !!v.trim() && !ok);
      });
      save();
      clearTimeout(bind._t); bind._t = setTimeout(renderPosters, 200);
    });
    table.addEventListener('change', e => {
      const inp = e.target.closest('.seat-input'); if (!inp) return;
      const tr = inp.closest('tr'), id = inp.dataset.id;
      const n = normalizeSeat(inp.value);
      if (n) {                                   // 유효한 좌석 또는 0000 → 정리해서 저장
        $$('.seat-input', tr).forEach(el => { el.value = n; el.classList.add('filled'); el.classList.remove('invalid'); });
        state.seats[id] = n; tr.classList.add('seen'); save();
      } else if (n === null) {                   // 형식이 틀리거나 없는 좌석 → 삭제
        $$('.seat-input', tr).forEach(el => { el.value = ''; el.classList.remove('filled', 'invalid'); });
        delete state.seats[id]; tr.classList.remove('seen'); save();
        toast('잘못된 형식입니다. <br class="m">다시 입력해 주십시오.');
      }
      clearTimeout(bind._t); bind._t = setTimeout(renderPosters, 100);
    });
    table.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target.classList.contains('seat-input')) return;
      const inputs = $$('.seat-input', table).filter(el => el.offsetParent !== null); const i = inputs.indexOf(e.target);
      if (i >= 0 && inputs[i + 1]) { e.preventDefault(); inputs[i + 1].focus(); inputs[i + 1].select(); }
    });

    $('#btn-export').addEventListener('click', exportJson);
    $('#btn-import').addEventListener('click', () => $('#file-import').click());
    $('#file-import').addEventListener('change', e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('모든 좌석 기록을 지웁니다. 계속할까요?')) return;
      state.seats = {}; save(); renderSchedule(); renderPosters();
    });
    $$('.poster-toolbar .dl').forEach(btn => btn.addEventListener('click', () => exportPoster(btn.dataset.target, btn.dataset.name, btn)));

    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(fitPosters, 80); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPosters);
    window.addEventListener('load', fitPosters);
  }

  /* ---------------- 시작 ---------------- */
  load();
  renderFilter();
  renderSchedule();
  renderPosters();
  bind();
})();
