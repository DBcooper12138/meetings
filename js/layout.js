/* ============================================================
 *  layout.js —— 会场布局（座位图）编辑器
 *
 *  两种模式：
 *    grid —— 排座式：按「每排座位数 + 走道」自动生成座位，可设编号规则
 *    free —— 自由布局：多场景画布 + 自由摆放座位块，可拖拽
 *
 *  统一数据模型（存 meeting_layouts.layout）：
 *   {
 *     mode: 'grid' | 'free',
 *     style: { seatW, seatH, gapX, gapY, font },
 *     canvas: { w, h },
 *     scenes: [{ id, name, x, y, w, h }],
 *     seats: [{ key, sceneId, sceneName, row, no, x, y, w, h, label }],
 *     assign: { seatKey: personKey }        // personKey = 'e:工号' | 'n:姓名'
 *   }
 *
 *  渲染用绝对定位 + transform 缩放；座位数上限 500。
 * ============================================================ */
(function (root) {
  'use strict';

  var MAX_SEATS = 500;
  var CAT_ORDER = ['处长', '院长', '办公室主任', '党总支书记'];

  function MS() { return root.MS; }
  function DB() { return root.MSDB; }
  function h(s) { return root.MSUtil.esc(s); }
  function q(id) { return document.getElementById(id); }
  function toast(m, t) { root.MSUtil.toast(m, t); }

  /* ================= 工具 ================= */
  function personKey(p) {
    var emp = String((p && p.emp_no) || '').replace(/\s+/g, '');
    if (emp) return 'e:' + emp.toLowerCase();
    var n = String((p && p.name) || '').replace(/\s+/g, '');
    return n ? 'n:' + n.toLowerCase() : '';
  }

  function catRank(c) {
    var i = CAT_ORDER.indexOf(c);
    return i < 0 ? 99 : i;
  }

  function sortPeople(list) {
    return list.slice().sort(function (a, b) {
      var ra = catRank(a.category), rb = catRank(b.category);
      if (ra !== rb) return ra - rb;
      return (a.sort_no || 0) - (b.sort_no || 0) ||
             String(a.dept || '').localeCompare(String(b.dept || ''), 'zh');
    });
  }

  /* 编号序列：返回 arr[物理列] = 排内编号 */
  function numberSequence(n, mode, side) {
    var arr = new Array(n);
    if (mode === 'rtl') {
      for (var i = 0; i < n; i++) arr[i] = n - i;
      return arr;
    }
    if (mode === 'center') {
      var mid = Math.floor(n / 2);
      var leftFirst = side !== 'right';
      for (var k = 0; k < n; k++) {
        var d = k - mid;
        // 中间为 1，向两侧递增；左右交替：1,2,3,4...
        var seq;
        if (d === 0) seq = 1;
        else if (d < 0) seq = leftFirst ? (Math.abs(d) * 2 + 1) : (Math.abs(d) * 2);
        else seq = leftFirst ? (d * 2) : (d * 2 + 1);
        arr[k] = seq;
      }
      // 修正为 1..n 的排列（万一奇偶导致重号）
      var used = {}, fix = 1;
      for (var m = 0; m < n; m++) {
        if (arr[m] > n || used[arr[m]]) { while (used[fix]) fix++; arr[m] = fix; }
        used[arr[m]] = 1;
      }
      return arr;
    }
    for (var j = 0; j < n; j++) arr[j] = j + 1;
    return arr;
  }

  /* ================= 生成座位 ================= */
  function buildGrid(cfg, style) {
    var rowSeats = String(cfg.rows || '')
      .split(/[,，\s]+/).filter(Boolean)
      .map(function (x) { return Math.max(1, Math.min(60, parseInt(x, 10) || 0)); })
      .filter(function (n) { return n > 0; });
    if (!rowSeats.length) rowSeats = [10];

    var aislesAt = String(cfg.aisles || '')
      .split(/[,，\s]+/).filter(Boolean)
      .map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { return n > 0; });

    var total = rowSeats.reduce(function (a, b) { return a + b; }, 0);
    if (total > MAX_SEATS) return { error: '座位总数 ' + total + ' 超过上限 ' + MAX_SEATS };

    var padX = 40, padY = 40, aisleExtra = 34;
    var maxW = 0;
    rowSeats.forEach(function (n) {
      var w = n * style.seatW + (n - 1) * style.gapX + aislesAt.filter(function (a) { return a < n; }).length * aisleExtra;
      if (w > maxW) maxW = w;
    });

    var seats = [];
    var nextNo = 1;
    var rows = rowSeats.length;
    for (var r = 0; r < rows; r++) {
      var n = rowSeats[r];
      var dispRow = r + 1;
      var y = padY + (cfg.firstRowAtBottom ? (rows - 1 - r) : r) * (style.seatH + style.gapY);
      var seq = numberSequence(n, cfg.numMode || 'ltr', cfg.centerSide || 'left');
      // 该排总宽（用于居中）
      var rowW = n * style.seatW + (n - 1) * style.gapX +
                 aislesAt.filter(function (a) { return a < n; }).length * aisleExtra;
      var startX = padX + Math.round((maxW - rowW) / 2);

      var x = startX;
      for (var c = 0; c < n; c++) {
        var seatNo = (cfg.range === 'byrow') ? seq[c] : nextNo;
        seats.push({
          key: 'r' + dispRow + '-c' + c,
          sceneId: 'main', sceneName: '主会场',
          row: dispRow, no: seatNo,
          x: x, y: y, w: style.seatW, h: style.seatH,
          label: '第' + dispRow + '排 ' + seatNo + '号'
        });
        x += style.seatW + style.gapX;
        if (aislesAt.indexOf(c + 1) >= 0) x += aisleExtra;
        nextNo++;
      }
    }

    var canvas = { w: padX * 2 + maxW, h: padY * 2 + rows * (style.seatH + style.gapY) };
    return {
      seats: seats,
      canvas: canvas,
      scenes: [{ id: 'main', name: '主会场', x: 0, y: 0, w: canvas.w, h: canvas.h }]
    };
  }

  /* ================= 编辑器状态 ================= */
  var E = {
    meetingId: '',
    meeting: null,
    layout: null,         // 正在编辑的布局
    people: [],           // 参会人（来自 invite）
    pickedPerson: '',     // 当前选中的人员 key
    pickedSeat: '',       // 当前选中的座位 key
    zoom: 1,
    dirty: false
  };

  function emptyLayout() {
    return {
      mode: 'grid',
      style: { seatW: 112, seatH: 52, gapX: 10, gapY: 62, font: 12 },
      canvas: { w: 900, h: 600 },
      scenes: [{ id: 'main', name: '主会场', x: 0, y: 0, w: 900, h: 600 }],
      seats: [],
      assign: {}
    };
  }

  function normalize(layout) {
    var L = Object.assign(emptyLayout(), layout || {});
    L.style = Object.assign({ seatW: 112, seatH: 52, gapX: 10, gapY: 62, font: 12 }, L.style || {});
    L.canvas = Object.assign({ w: 900, h: 600 }, L.canvas || {});
    L.scenes = (L.scenes && L.scenes.length) ? L.scenes : [{ id: 'main', name: '主会场', x: 0, y: 0, w: 900, h: 600 }];
    L.seats = Array.isArray(L.seats) ? L.seats : [];
    L.assign = L.assign || {};
    if (L.mode !== 'free') L.mode = 'grid';
    return L;
  }

  /* ================= 视图 ================= */
  function viewLayout() {
    var mid = E.meetingId;
    var m = E.meeting;
    if (!m) {
      return MS().shell('meetings', '会场布局', '<button class="btn ghost" data-go="#/meetings">返回</button>',
        '<div class="card"><div class="empty">会议不存在</div></div>');
    }
    var L = E.layout || emptyLayout();
    var isFree = L.mode === 'free';

    var assignedCount = Object.keys(L.assign).filter(function (k) { return L.assign[k]; }).length;
    var seatCount = L.seats.length;

    var toolbar =
      '<div class="btn-row" style="margin-bottom:12px;flex-wrap:wrap">' +
        '<button class="btn ghost sm" data-go="#/meeting/' + h(mid) + '">← 返回会议</button>' +
        '<span class="sp" style="flex:1"></span>' +
        '<button class="btn ' + (isFree ? 'ghost' : '') + ' sm" data-mode="grid">排座式</button>' +
        '<button class="btn ' + (isFree ? '' : 'ghost') + ' sm" data-mode="free">自由布局</button>' +
        '<span style="width:10px"></span>' +
        '<button class="btn ghost sm" id="ly-config">⚙ 排座参数</button>' +
        '<button class="btn sm" id="ly-autofill">自动排座</button>' +
        '<button class="btn ghost sm" id="ly-clear">清空座位</button>' +
        '<button class="btn ghost sm" id="ly-save">💾 保存布局</button>' +
      '</div>';

    var left =
      '<div class="ly-side">' +
        '<div class="ly-side-hd">参会人员 <span class="tag blue">' + E.people.length + '</span></div>' +
        '<div class="ly-hint">点人名 → 再点座位 = 安排座位；点已安排的座位可取消</div>' +
        '<div class="ly-people">' + peopleListHtml(L) + '</div>' +
      '</div>';

    var stage =
      '<div class="ly-stage-wrap">' +
        '<div class="ly-toolbar">' +
          '<span class="mini">座位 ' + seatCount + ' / 已排 ' + assignedCount + ' / 上限 ' + MAX_SEATS + '</span>' +
          '<span class="sp" style="flex:1"></span>' +
          (isFree ? '<button class="btn ghost sm" id="ly-add-seat">＋ 加座位</button>' +
                    '<button class="btn ghost sm" id="ly-add-scene">＋ 加场景</button>' : '') +
          '<button class="btn ghost sm" id="ly-zoom-out">－</button>' +
          '<span class="mini" id="ly-zoom-label">100%</span>' +
          '<button class="btn ghost sm" id="ly-zoom-in">＋</button>' +
          '<button class="btn ghost sm" id="ly-zoom-fit">适应</button>' +
        '</div>' +
        '<div class="ly-viewport" id="ly-viewport">' +
          '<div class="ly-canvas" id="ly-canvas" style="width:' + L.canvas.w + 'px;height:' + L.canvas.h +
            'px;transform:scale(' + E.zoom + ')">' + stageHtml(L) + '</div>' +
        '</div>' +
      '</div>';

    return MS().shell('meetings', '会场布局 · ' + (m.title || ''),
      '<button class="btn ghost sm" id="ly-export">⤓ 导出图片</button>',
      toolbar +
      (seatCount ? '' : '<div class="notice info" style="margin-bottom:12px">还没有座位。' +
        '点「⚙ 排座参数」生成排座，或切到「自由布局」自己摆放。</div>') +
      '<div class="ly-layout">' + left + stage + '</div>');
  }

  function peopleListHtml(L) {
    var assignedBy = {};
    Object.keys(L.assign).forEach(function (k) {
      if (L.assign[k]) assignedBy[L.assign[k]] = L.assign[k + '::label'] || '';
    });
    // 反查：某人在哪个座位
    var seatOf = {};
    Object.keys(L.assign).forEach(function (k) {
      var pk = L.assign[k];
      if (!pk) return;
      var s = L.seats.filter(function (x) { return x.key === k; })[0];
      seatOf[pk] = s ? s.label : '';
    });

    var list = sortPeople(E.people);
    if (!list.length) return '<div class="empty" style="padding:20px">名单是空的</div>';

    var groups = {};
    list.forEach(function (p) {
      var c = p.category || '未分类';
      (groups[c] = groups[c] || []).push(p);
    });

    return Object.keys(groups).map(function (c) {
      return '<div class="ly-grp">' + h(c) + '</div>' +
        groups[c].map(function (p) {
          var pk = personKey(p);
          var seat = seatOf[pk];
          var on = E.pickedPerson === pk;
          return '<div class="ly-p ' + (on ? 'on' : '') + '" data-person="' + h(pk) + '" data-name="' + h(p.name) + '">' +
            '<span class="ly-pn">' + h(p.name) + '</span>' +
            '<span class="ly-pe">' + h(p.emp_no || '') + '</span>' +
            (seat ? '<span class="tag green">' + h(seat) + '</span>' : '') +
          '</div>';
        }).join('');
    }).join('');
  }

  function stageHtml(L) {
    var style = L.style;
    var parts = [];

    // 场景框
    (L.mode === 'free' ? L.scenes : []).forEach(function (sc) {
      parts.push('<div class="ly-scene" style="left:' + sc.x + 'px;top:' + sc.y + 'px;width:' + sc.w +
        'px;height:' + sc.h + 'px"><span class="ly-scene-name">' + h(sc.name) + '</span></div>');
    });

    var byKey = {};
    L.seats.forEach(function (s) { byKey[s.key] = s; });

    L.seats.forEach(function (s) {
      var pk = L.assign[s.key];
      var person = null;
      if (pk) person = E.people.filter(function (p) { return personKey(p) === pk; })[0];
      var cls = 'ly-seat' + (E.pickedSeat === s.key ? ' sel' : '') + (pk ? ' taken' : '') + (person ? '' : (pk ? ' outside' : ''));
      parts.push('<div class="' + cls + '" data-seat="' + h(s.key) + '" ' +
        'style="left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;font-size:' + style.font + 'px" ' +
        'title="' + h(s.label) + '">' +
        '<div class="ly-seat-name">' + h(person ? person.name : (pk ? '（名单外）' : '')) + '</div>' +
        '<div class="ly-seat-label">' + h(s.label) + '</div>' +
      '</div>');
    });

    return parts.join('');
  }

  /* ================= 交互 ================= */
  function bindLayout() {
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-mode');
        if (E.layout.mode === mode) return;
        E.layout.mode = mode;
        if (mode === 'free' && !E.layout.seats.length) {
          E.layout.canvas = { w: 1000, h: 700 };
          E.layout.scenes = [{ id: 'main', name: '主会场', x: 20, y: 20, w: 960, h: 660 }];
        }
        E.dirty = true;
        MS().render();
      });
    });

    var cfgBtn = q('ly-config');
    if (cfgBtn) cfgBtn.addEventListener('click', openConfig);

    var auto = q('ly-autofill');
    if (auto) auto.addEventListener('click', autoFill);

    var clr = q('ly-clear');
    if (clr) clr.addEventListener('click', function () {
      MS().confirmBox('清空所有座位和排座结果？\n（人员名单不受影响）').then(function (ok) {
        if (!ok) return;
        E.layout.seats = [];
        E.layout.assign = {};
        E.pickedSeat = '';
        E.dirty = true;
        MS().render();
      });
    });

    var save = q('ly-save');
    if (save) save.addEventListener('click', saveLayout);

    var exp = q('ly-export');
    if (exp) exp.addEventListener('click', exportImage);

    // 缩放
    var zi = q('ly-zoom-in'), zo = q('ly-zoom-out'), zf = q('ly-zoom-fit');
    if (zi) zi.addEventListener('click', function () { setZoom(E.zoom + 0.1); });
    if (zo) zo.addEventListener('click', function () { setZoom(E.zoom - 0.1); });
    if (zf) zf.addEventListener('click', fitZoom);

    // 选人
    document.querySelectorAll('[data-person]').forEach(function (el) {
      el.addEventListener('click', function () {
        E.pickedPerson = (E.pickedPerson === el.getAttribute('data-person')) ? '' : el.getAttribute('data-person');
        document.querySelectorAll('[data-person]').forEach(function (x) { x.classList.remove('on'); });
        if (E.pickedPerson) el.classList.add('on');
      });
    });

    // 点座位
    document.querySelectorAll('[data-seat]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        onSeatClick(el.getAttribute('data-seat'));
      });
    });

    // 自由布局：加座位 / 加场景
    var addSeat = q('ly-add-seat');
    if (addSeat) addSeat.addEventListener('click', function () {
      if (E.layout.seats.length >= MAX_SEATS) return toast('已达座位上限 ' + MAX_SEATS, 'warn');
      var sc = E.layout.scenes[0];
      var n = E.layout.seats.length + 1;
      E.layout.seats.push({
        key: 'f' + Date.now().toString(36),
        sceneId: sc.id, sceneName: sc.name,
        row: null, no: n,
        x: sc.x + 40 + (n % 8) * 130, y: sc.y + 60 + Math.floor(n / 8) * 70,
        w: E.layout.style.seatW, h: E.layout.style.seatH,
        label: '座位 ' + n
      });
      E.dirty = true;
      MS().render();
    });
    var addScene = q('ly-add-scene');
    if (addScene) addScene.addEventListener('click', function () {
      if (E.layout.scenes.length >= 4) return toast('最多 4 个场景', 'warn');
      var names = ['主会场', '贵宾室', '分会场一', '分会场二'];
      var n = E.layout.scenes.length;
      E.layout.scenes.push({ id: 's' + (n + 1), name: names[n] || ('场景' + (n + 1)), x: 20, y: 20, w: 960, h: 660 });
      E.dirty = true;
      MS().render();
    });

    // 自由布局拖拽座位
    if (E.layout.mode === 'free') enableDrag();
  }

  function onSeatClick(seatKey) {
    var L = E.layout;
    var cur = L.assign[seatKey] || '';

    if (E.pickedPerson) {
      // 把选中的人放到这个座位（先移除他原来的座位）
      Object.keys(L.assign).forEach(function (k) {
        if (L.assign[k] === E.pickedPerson) delete L.assign[k];
      });
      if (cur && cur !== E.pickedPerson) delete L.assign[seatKey];  // 覆盖原占用人
      L.assign[seatKey] = E.pickedPerson;
      E.pickedPerson = '';
      E.dirty = true;
      MS().render();
      return;
    }

    if (cur) {
      MS().confirmBox('取消这个座位的安排？\n（' + (L.seats.filter(function (s) { return s.key === seatKey; })[0] || {}).label + '）')
        .then(function (ok) {
          if (!ok) return;
          delete L.assign[seatKey];
          E.dirty = true;
          MS().render();
        });
      return;
    }

    // 没选人也没人：选中座位，供点击"分配"使用
    E.pickedSeat = (E.pickedSeat === seatKey) ? '' : seatKey;
    document.querySelectorAll('[data-seat]').forEach(function (el) {
      el.classList.toggle('sel', el.getAttribute('data-seat') === E.pickedSeat);
    });
  }

  function setZoom(z) {
    E.zoom = Math.max(0.2, Math.min(2, Math.round(z * 10) / 10));
    var c = q('ly-canvas');
    if (c) c.style.transform = 'scale(' + E.zoom + ')';
    var lb = q('ly-zoom-label');
    if (lb) lb.textContent = Math.round(E.zoom * 100) + '%';
  }

  function fitZoom() {
    var vp = q('ly-viewport');
    if (!vp || !E.layout) return;
    var sx = (vp.clientWidth - 24) / Math.max(1, E.layout.canvas.w);
    var sy = (vp.clientHeight - 24) / Math.max(1, E.layout.canvas.h);
    setZoom(Math.min(sx, sy, 1));
  }

  /* 自由布局：拖拽座位 */
  function enableDrag() {
    var canvas = q('ly-canvas');
    if (!canvas) return;
    var drag = null;

    canvas.addEventListener('pointerdown', function (e) {
      var el = e.target.closest('[data-seat]');
      if (!el) return;
      if (E.layout.mode !== 'free') return;
      var key = el.getAttribute('data-seat');
      var s = E.layout.seats.filter(function (x) { return x.key === key; })[0];
      if (!s) return;
      drag = { key: key, dx: e.clientX / E.zoom - s.x, dy: e.clientY / E.zoom - s.y };
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var s = E.layout.seats.filter(function (x) { return x.key === drag.key; })[0];
      if (!s) return;
      s.x = Math.max(0, Math.round(e.clientX / E.zoom - drag.dx));
      s.y = Math.max(0, Math.round(e.clientY / E.zoom - drag.dy));
      var el = canvas.querySelector('[data-seat="' + drag.key + '"]');
      if (el) { el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; }
      E.dirty = true;
    });

    canvas.addEventListener('pointerup', function () { drag = null; });
    canvas.addEventListener('pointercancel', function () { drag = null; });
  }

  /* 排座参数 */
  function openConfig() {
    var L = E.layout;
    var g = L.grid || { rows: '', aisles: '', firstRowAtBottom: true, range: 'unified', numMode: 'ltr', centerSide: 'left' };
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="max-width:520px"><div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">排座参数</div>' +
      '<label class="f"><span class="lb">每排座位数（逗号分隔，可逐排不同）</span>' +
        '<input class="input" id="lg-rows" placeholder="如 12,12,12,10" value="' + h(g.rows || '') + '"></label>' +
      '<label class="f"><span class="lb">走道位置（座位序号，逗号分隔）</span>' +
        '<input class="input" id="lg-aisles" placeholder="如 6 表示第 6 座后留走道" value="' + h(g.aisles || '') + '"></label>' +
      '<label class="f"><span class="lb">编号方式</span>' +
        '<select class="input" id="lg-range">' +
          '<option value="unified"' + (g.range !== 'byrow' ? ' selected' : '') + '>全场上下一号到底（统一编号）</option>' +
          '<option value="byrow"' + (g.range === 'byrow' ? ' selected' : '') + '>每排从 1 开始（按排编号）</option>' +
        '</select></label>' +
      '<label class="f"><span class="lb">座位序号方向</span>' +
        '<select class="input" id="lg-mode">' +
          '<option value="ltr"' + (g.numMode === 'ltr' ? ' selected' : '') + '>从左到右 1,2,3…</option>' +
          '<option value="rtl"' + (g.numMode === 'rtl' ? ' selected' : '') + '>从右到左 1,2,3…</option>' +
          '<option value="center"' + (g.numMode === 'center' ? ' selected' : '') + '>中间向两边（1 号在中间）</option>' +
        '</select></label>' +
      '<label class="f" id="lg-side-wrap" style="display:' + (g.numMode === 'center' ? 'block' : 'none') + '">' +
        '<span class="lb">中间向两边时，1 号偏哪侧</span>' +
        '<select class="input" id="lg-side">' +
          '<option value="left"' + (g.centerSide !== 'right' ? ' selected' : '') + '>偏左</option>' +
          '<option value="right"' + (g.centerSide === 'right' ? ' selected' : '') + '>偏右</option>' +
        '</select></label>' +
      '<label style="display:block;margin-bottom:10px"><input type="checkbox" id="lg-bottom" ' +
        (g.firstRowAtBottom !== false ? 'checked' : '') + '> 第一排在最下方（面向主席台）</label>' +
      '<div class="hint">生成会覆盖现有座位和已排结果。</div>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button>' +
      '<button class="btn" id="lg-ok">生成座位</button></div></div>';
    document.body.appendChild(mask);

    mask.querySelector('#lg-mode').addEventListener('change', function () {
      mask.querySelector('#lg-side-wrap').style.display = this.value === 'center' ? 'block' : 'none';
    });
    mask.addEventListener('click', function (e) {
      var t = e.target.closest('[data-x]');
      if (t || e.target === mask) mask.remove();
    });
    mask.querySelector('#lg-ok').addEventListener('click', function () {
      var cfg = {
        rows: mask.querySelector('#lg-rows').value,
        aisles: mask.querySelector('#lg-aisles').value,
        range: mask.querySelector('#lg-range').value,
        numMode: mask.querySelector('#lg-mode').value,
        centerSide: mask.querySelector('#lg-side').value,
        firstRowAtBottom: mask.querySelector('#lg-bottom').checked
      };
      var res = buildGrid(cfg, E.layout.style);
      if (res.error) return toast(res.error, 'err');
      mask.remove();
      // 保留已有的人员安排（按"排-号"匹配）
      var oldAssign = E.layout.assign || {};
      var oldSeats = E.layout.seats || [];
      var oldByLabel = {};
      oldSeats.forEach(function (s) { if (oldAssign[s.key]) oldByLabel[s.label] = oldAssign[s.key]; });

      E.layout.mode = 'grid';
      E.layout.grid = cfg;
      E.layout.seats = res.seats;
      E.layout.canvas = res.canvas;
      E.layout.scenes = res.scenes;
      E.layout.assign = {};
      E.layout.seats.forEach(function (s) {
        if (oldByLabel[s.label]) E.layout.assign[s.key] = oldByLabel[s.label];
      });
      E.dirty = true;
      MS().render();
      toast('已生成 ' + res.seats.length + ' 个座位', 'ok');
    });
  }

  /* 自动排座：按类别顺序填入空座位 */
  function autoFill() {
    var L = E.layout;
    if (!L.seats.length) return toast('请先生成座位', 'warn');

    var taken = {};
    Object.keys(L.assign).forEach(function (k) { if (L.assign[k]) taken[L.assign[k]] = 1; });

    var free = L.seats.slice().sort(function (a, b) {
      if (a.row !== b.row) return (a.row || 0) - (b.row || 0);
      return (a.no || 0) - (b.no || 0);
    });
    var people = sortPeople(E.people).filter(function (p) { return !taken[personKey(p)]; });

    if (!people.length) return toast('所有人都已安排座位', 'ok');
    var n = 0;
    for (var i = 0; i < free.length && n < people.length; i++) {
      if (L.assign[free[i].key]) continue;
      L.assign[free[i].key] = personKey(people[n++]);
    }
    E.dirty = true;
    MS().render();
    toast('已自动安排 ' + n + ' 人' + (n < people.length ? '，座位不够，剩余 ' + (people.length - n) + ' 人未安排' : ''), 'ok');
  }

  function saveLayout() {
    var L = E.layout;
    var m = E.meeting;
    DB().saveLayout(m.id, L.mode, L).then(function () {
      E.dirty = false;
      toast('布局已保存', 'ok');
      return MS().refreshAll();
    }).then(function () { MS().render(); })
      .catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  /* 导出图片：把座位画到 canvas */
  function exportImage() {
    var L = E.layout;
    if (!L.seats.length) return toast('还没有座位', 'warn');
    var pad = 20;
    var w = L.canvas.w + pad * 2, hgt = L.canvas.h + pad * 2;
    var scale = 2;
    var cv = document.createElement('canvas');
    cv.width = w * scale; cv.height = hgt * scale;
    var ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
    ctx.translate(pad, pad);

    var personOf = {};
    E.people.forEach(function (p) { personOf[personKey(p)] = p; });

    L.seats.forEach(function (s) {
      var pk = L.assign[s.key];
      var p = pk ? personOf[pk] : null;
      ctx.fillStyle = p ? '#eef6ff' : '#f8fafc';
      ctx.strokeStyle = p ? '#7cb3f0' : '#dbe3ec';
      ctx.lineWidth = 1;
      roundRect(ctx, s.x, s.y, s.w, s.h, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = p ? '#0f172a' : '#94a3b8';
      ctx.font = '600 ' + Math.max(10, L.style.font) + 'px "Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p ? p.name : '空', s.x + s.w / 2, s.y + s.h / 2 - 6);
      ctx.fillStyle = '#64748b';
      ctx.font = '10px "Microsoft YaHei",sans-serif';
      ctx.fillText(s.label, s.x + s.w / 2, s.y + s.h / 2 + 10);
    });

    cv.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '会场布局_' + (E.meeting.title || '') + '.png';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
      toast('已导出图片', 'ok');
    }, 'image/png');
  }

  function roundRect(ctx, x, y, w, hgt, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hgt, r);
    ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
    ctx.arcTo(x, y + hgt, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================= 对外：打开编辑器 ================= */
  function open(meetingId) {
    var m = MS().state.meetings.filter(function (x) { return x.id === meetingId; })[0];
    E.meetingId = meetingId;
    E.meeting = m || null;
    E.pickedPerson = '';
    E.pickedSeat = '';
    E.zoom = 1;
    E.dirty = false;

    // 参会人来自本场会议的受邀快照
    E.people = ((m && m.invite) || []).map(function (p, i) {
      return { name: p.name, emp_no: p.emp_no || '', dept: p.dept || '', category: p.category || '', sort_no: i };
    });

    return DB().getLayout(meetingId).then(function (row) {
      if (row && row.layout && (row.layout.seats || []).length) {
        E.layout = normalize(row.layout);
      } else {
        // 没有布局：按名单生成一个默认排座方案
        E.layout = normalize(defaultLayoutFor(E.people));
      }
      return E.layout;
    }).catch(function () {
      E.layout = normalize(defaultLayoutFor(E.people));
      return E.layout;
    });
  }

  /* 根据名单人数，给出一个"刚好坐下"的默认排座 */
  function defaultLayoutFor(people) {
    var n = Math.max(1, (people || []).length);
    var perRow = n <= 20 ? Math.min(n, 10) : Math.min(16, Math.ceil(Math.sqrt(n * 1.6)));
    var rows = Math.max(1, Math.ceil(n / perRow));
    var cfg = {
      rows: new Array(rows).fill(perRow).join(','),
      aisles: perRow >= 10 ? String(Math.floor(perRow / 2)) : '',
      range: 'unified', numMode: 'ltr', centerSide: 'left', firstRowAtBottom: true
    };
    var style = { seatW: 112, seatH: 52, gapX: 10, gapY: 62, font: 12 };
    var res = buildGrid(cfg, style);
    var L = normalize({ mode: 'grid', style: style, grid: cfg });
    if (!res.error) {
      L.seats = res.seats;
      L.canvas = res.canvas;
      L.scenes = res.scenes;
    }
    return L;
  }

  root.MSLayout = {
    open: open,
    viewLayout: viewLayout,
    bindLayout: bindLayout,
    personKey: personKey,
    defaultLayoutFor: defaultLayoutFor,
    state: E
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
