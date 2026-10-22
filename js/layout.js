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

  /* 分区（按类别/单位）用的配色 */
  var ZONE_COLORS = ['#e8f1ff', '#eafaf0', '#fff7e6', '#fdeef0', '#f2ecff', '#e8f7f9', '#f5f0e6', '#eef2f7'];

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function zoneColor(name, L) {
    if (!name) return '';
    var keys = Object.keys(L._zoneIdx || {});
    var i = keys.indexOf(name);
    if (i < 0) return '';
    return ZONE_COLORS[i % ZONE_COLORS.length];
  }

  function rebuildZoneIdx(L) {
    var names = [];
    L.seats.forEach(function (s) {
      var z = L.zoneMap && L.zoneMap[s.key];
      if (z && names.indexOf(z) < 0) names.push(z);
    });
    names.sort();
    L._zoneIdx = {};
    names.forEach(function (n, i) { L._zoneIdx[n] = i; });
    return names;
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

    var padX = 40, padY = 40;
    var aisleExtra = (style.aisleW === undefined || style.aisleW === null) ? 34 : Math.max(0, style.aisleW);
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
      style: { seatW: 112, seatH: 52, gapX: 10, gapY: 62, font: 12, aisleW: 34 },
      canvas: { w: 900, h: 600 },
      scenes: [{ id: 'main', name: '主会场', x: 0, y: 0, w: 900, h: 600 }],
      seats: [],
      assign: {}
    };
  }

  function normalize(layout) {
    var L = Object.assign(emptyLayout(), layout || {});
    L.style = Object.assign({ seatW: 112, seatH: 52, gapX: 10, gapY: 62, font: 12, aisleW: 34 }, L.style || {});
    L.canvas = Object.assign({ w: 900, h: 600 }, L.canvas || {});
    L.scenes = (L.scenes && L.scenes.length) ? L.scenes : [{ id: 'main', name: '主会场', x: 0, y: 0, w: 900, h: 600 }];
    L.seats = Array.isArray(L.seats) ? L.seats : [];
    L.assign = L.assign || {};
    L.zoneMap = L.zoneMap || {};
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
        '<select class="input" id="ly-fill-mode" style="width:132px;padding:4px 8px;font-size:12.5px">' +
          ['order:顺序排座', 'category:按类别分区', 'dept:按单位分区', 'random:随机排座'].map(function (x) {
            var kv = x.split(':');
            return '<option value="' + kv[0] + '"' +
              ((E.fillMode || 'order') === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
          }).join('') +
        '</select>' +
        '<button class="btn sm" id="ly-autofill">开始排座</button>' +
        '<button class="btn ghost sm" id="ly-clear">清空安排</button>' +
        '<button class="btn ghost sm" id="ly-zone-mode">划分区域</button>' +
        '<button class="btn ghost sm" id="ly-size">座位大小</button>' +
        '<button class="btn ghost sm" id="ly-del-seat">删除座位</button>' +
        '<button class="btn ghost sm" id="ly-unassign">清空该座</button>' +
        '<button class="btn ghost sm" id="ly-tpl-save">☆ 存为模板</button>' +
        '<button class="btn ghost sm" id="ly-tpl-use">套用模板</button>' +
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
          ('<button class="btn ghost sm" id="ly-add-seat">＋ 座位</button>' +
                    (isFree ? '<button class="btn ghost sm" id="ly-add-scene">＋ 加场景</button>' +
                    '<button class="btn ghost sm" id="ly-del-scene">－ 删场景</button>' : '')) +
          '<button class="btn ghost sm" id="ly-zoom-out">－</button>' +
          '<span class="mini" id="ly-zoom-label">100%</span>' +
          '<button class="btn ghost sm" id="ly-zoom-in">＋</button>' +
          '<button class="btn ghost sm" id="ly-zoom-fit">适应</button>' +
        '</div>' +
        zoneBarHtml(L) +
        legendHtml(L) +
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


  function zoneOptions(L) {
    var opts = [];
    E.people.forEach(function (p) {
      if (p.dept && opts.indexOf('单位·' + p.dept) < 0) opts.push('单位·' + p.dept);
      if (p.category && opts.indexOf('身份·' + p.category) < 0) opts.push('身份·' + p.category);
    });
    return opts.sort();
  }

  function zoneBarHtml(L) {
    if (!E.zoneMode) return '';
    var opts = zoneOptions(L);
    return '<div class="ly-zonebar">' +
      '<span class="mini">框选座位后选择分区：</span>' +
      '<select class="input" id="ly-zone-pick" style="width:190px;padding:4px 8px;font-size:12.5px">' +
        '<option value="">— 选择分区 —</option>' +
        opts.map(function (o) {
          return '<option value="' + h(o) + '"' + (E.zonePick === o ? ' selected' : '') + '>' + h(o) + '</option>';
        }).join('') +
      '</select>' +
      '<button class="btn sm" id="ly-zone-apply">应用到选中（' + (E.zoneSel || []).length + '）</button>' +
      '<button class="btn ghost sm" id="ly-zone-clear">取消选中</button>' +
      '<span class="mini">拖拽画框 = 框选座位</span>' +
    '</div>';
  }

  function legendHtml(L) {
    var names = rebuildZoneIdx(L);
    if (!names.length) return '';
    return '<div class="ly-legend">' + names.map(function (n) {
      var color = zoneColor(n, L);
      return '<span class="ly-legend-item"><i style="background:' + color + '"></i>' + h(n) + '</span>';
    }).join('') + '</div>';
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

    rebuildZoneIdx(L);
    L.seats.forEach(function (s) {
      var pk = L.assign[s.key];
      var person = null;
      if (pk) person = E.people.filter(function (p) { return personKey(p) === pk; })[0];
      var zc = zoneColor(L.zoneMap && L.zoneMap[s.key], L);
      var cls = 'ly-seat' + (E.pickedSeat === s.key ? ' sel' : '') + (pk ? ' taken' : '') + (person ? '' : (pk ? ' outside' : ''));
      parts.push('<div class="' + cls + '" data-seat="' + h(s.key) + '" ' +
        'style="left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;font-size:' + style.font + 'px;' + (zc ? 'background:' + zc + ';' : '') + '" ' +
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
    if (cfgBtn) cfgBtn.addEventListener('click', openRowConfig);

    var fillSel = q('ly-fill-mode');
    if (fillSel) fillSel.addEventListener('change', function () { E.fillMode = fillSel.value; });

    var auto = q('ly-autofill');
    if (auto) auto.addEventListener('click', function () {
      var sel = q('ly-fill-mode');
      autoFill(sel ? sel.value : 'order');
    });

    var unassign = q('ly-unassign');
    if (unassign) unassign.addEventListener('click', function () {
      if (!E.pickedSeat) return toast('先在画布上点一下座位', 'warn');
      delete E.layout.assign[E.pickedSeat];
      if (E.layout.zoneMap) delete E.layout.zoneMap[E.pickedSeat];
      E.dirty = true; MS().render(); toast('已清空该座', 'ok');
    });


    var zm = q('ly-zone-mode');
    if (zm) zm.addEventListener('click', function () {
      E.zoneMode = !E.zoneMode;
      E.zoneSel = [];
      E.pickedSeat = '';
      MS().render();
    });

    var zp = q('ly-zone-pick');
    if (zp) zp.addEventListener('change', function () { E.zonePick = zp.value; });

    var za = q('ly-zone-apply');
    if (za) za.addEventListener('click', function () {
      var name = (q('ly-zone-pick') || {}).value || '';
      if (!name) return toast('先选一个分区', 'warn');
      if (!(E.zoneSel || []).length) return toast('先框选座位', 'warn');
      E.layout.zoneMap = E.layout.zoneMap || {};
      E.zoneSel.forEach(function (k) { E.layout.zoneMap[k] = name; });
      E.dirty = true;
      E.zoneSel = [];
      MS().render();
      toast('已设置分区：' + name, 'ok');
    });

    var zc = q('ly-zone-clear');
    if (zc) zc.addEventListener('click', function () { E.zoneSel = []; MS().render(); });

    if (E.zoneMode) enableMarquee();

    function enableMarquee() {
      var canvas = q('ly-canvas');
      if (!canvas) return;
      var start = null, box = null;
      canvas.addEventListener('pointerdown', function (e) {
        if (!E.zoneMode) return;
        if (e.target.closest('[data-seat]')) return;
        var r = canvas.getBoundingClientRect();
        start = { x: (e.clientX - r.left) / E.zoom, y: (e.clientY - r.top) / E.zoom };
        box = document.createElement('div');
        box.className = 'ly-marquee';
        canvas.appendChild(box);
        e.preventDefault();
      });
      canvas.addEventListener('pointermove', function (e) {
        if (!start || !box) return;
        var r = canvas.getBoundingClientRect();
        var x = (e.clientX - r.left) / E.zoom, y = (e.clientY - r.top) / E.zoom;
        var l = Math.min(start.x, x), t = Math.min(start.y, y);
        var w = Math.abs(x - start.x), hh = Math.abs(y - start.y);
        box.style.cssText = 'left:' + l + 'px;top:' + t + 'px;width:' + w + 'px;height:' + hh + 'px';
        box._rect = { l: l, t: t, r: l + w, b: t + hh };
      });
      canvas.addEventListener('pointerup', function () {
        if (!box || !box._rect) { start = null; box = null; return; }
        var q2 = box._rect;
        var hit = E.layout.seats.filter(function (s) {
          return !(s.x + s.w < q2.l || s.x > q2.r || s.y + s.h < q2.t || s.y > q2.b);
        }).map(function (s) { return s.key; });
        box.remove();
        start = null; box = null;
        E.zoneSel = hit;
        MS().render();
      });
    }

    var delSeat = q('ly-del-seat');
    if (delSeat) delSeat.addEventListener('click', deleteSeat);

    var delScene = q('ly-del-scene');
    if (delScene) delScene.addEventListener('click', deleteScene);

    var sizeBtn = q('ly-size');
    if (sizeBtn) sizeBtn.addEventListener('click', openSeatSize);

    var clr = q('ly-clear');
    if (clr) clr.addEventListener('click', function () {
      MS().confirmBox('清空所有排座结果？\n（座位本身保留，人员名单不受影响）').then(function (ok) {
        if (!ok) return;
        E.layout.assign = {};
        E.layout.zoneMap = {};
        E.pickedSeat = '';
        E.pickedPerson = '';
        E.dirty = true;
        MS().render();
        toast('已清空排座结果', 'ok');
      });
    });

    var tplSave = q('ly-tpl-save');
    if (tplSave) tplSave.addEventListener('click', saveAsTemplate);
    var tplUse = q('ly-tpl-use');
    if (tplUse) tplUse.addEventListener('click', openTemplates);

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
    if (addSeat) addSeat.addEventListener('click', openAddSeat);
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
    enableSeatDrag();
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

    // 没有选中人员时：只是选中这个座位（供"删除座位""清空该座"使用）
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

  /* 排座：四种方式
       order    —— 按类别优先级 + 名单顺序
       category —— 按「类别」分成若干区，一区一段座位，座位按区分色
       dept     —— 按「单位（部门）」分成若干区
       random   —— 随机打乱顺序后填入
  */
  function autoFill(mode) {
    var L = E.layout;
    if (!L.seats.length) return toast('请先生成座位', 'warn');
    mode = mode || 'order';

    var taken = {};
    Object.keys(L.assign).forEach(function (k) { if (L.assign[k]) taken[L.assign[k]] = 1; });

    var freeSeats = L.seats.slice().sort(function (a, b) {
      if ((a.row || 0) !== (b.row || 0)) return (a.row || 0) - (b.row || 0);
      return (a.no || 0) - (b.no || 0);
    });
    var pending = E.people.filter(function (p) { return !taken[personKey(p)]; });
    if (!pending.length) return toast('所有人都已安排座位', 'ok');

    L.zoneMap = {};

    if (mode === 'random') {
      var shuffled = shuffle(pending);
      var n0 = 0;
      for (var i0 = 0; i0 < freeSeats.length && n0 < shuffled.length; i0++) {
        if (L.assign[freeSeats[i0].key]) continue;
        L.assign[freeSeats[i0].key] = personKey(shuffled[n0++]);
      }
      E.dirty = true; MS().render();
      return toast('已随机安排 ' + n0 + ' 人', 'ok');
    }

    if (mode === 'category' || mode === 'dept') {
      var keyFn = mode === 'category'
        ? function (p) { return p.category || '未分类'; }
        : function (p) { return p.dept || '未填单位'; };

      var groups = {};
      pending.forEach(function (p) {
        var k = keyFn(p);
        (groups[k] = groups[k] || []).push(p);
      });
      var names = Object.keys(groups).sort(function (a, b) {
        if (mode === 'category') {
          var ra = catRank(a), rb = catRank(b);
          if (ra !== rb) return ra - rb;
        }
        return a.localeCompare(b, 'zh');
      });

      var si = 0, placed = 0, shortBy = 0;
      names.forEach(function (nm) {
        var list = groups[nm];
        list.forEach(function (p) {
          while (si < freeSeats.length && L.assign[freeSeats[si].key]) si++;
          if (si >= freeSeats.length) { shortBy++; return; }
          var seat = freeSeats[si];
          L.assign[seat.key] = personKey(p);
          L.zoneMap[seat.key] = nm;
          placed++;
        });
      });

      E.dirty = true; MS().render();
      return toast('已按' + (mode === 'category' ? '类别' : '单位') + '分区安排 ' + placed + ' 人，共 ' +
        names.length + ' 个区' + (shortBy ? '；座位不足，' + shortBy + ' 人未安排' : ''), 'ok');
    }

    // 顺序排座
    var people = sortPeople(pending);
    var n = 0;
    for (var i = 0; i < freeSeats.length && n < people.length; i++) {
      if (L.assign[freeSeats[i].key]) continue;
      L.assign[freeSeats[i].key] = personKey(people[n++]);
    }
    E.dirty = true;
    MS().render();
    toast('已按顺序安排 ' + n + ' 人' + (n < people.length ? '，座位不够，剩余 ' + (people.length - n) + ' 人未安排' : ''), 'ok');
  }




  /* 存为模板 */
  function saveAsTemplate() {
    var L = E.layout;
    if (!L.seats.length) return toast('还没有座位，先排好再存模板', 'warn');
    MS().promptBox('给这个会议室样式起个名字（如：大礼堂-16排）', '').then(function (name) {
      if (!name) return;
      DB().saveTemplate(name.trim(), L.mode, L).then(function () {
        toast('模板已保存：' + name, 'ok');
      }).catch(function (e) { toast(String(e.message || e), 'err'); });
    });
  }

  /* 套用模板 */
  function openTemplates() {
    DB().listTemplates().then(function (list) {
      var rain = list || [];
      var rows = rain.map(function (t) {
        var seats = (t.layout && t.layout.seats) ? t.layout.seats.length : 0;
        return '<div class="tpl-row">' +
          '<div class="tpl-name">' + h(t.name) + '</div>' +
          '<div class="mini">' + (t.mode === 'free' ? '自由布局' : '排座式') + ' · ' + seats + ' 个座位</div>' +
          '<button class="btn sm" data-tpl-apply="' + h(t.id) + '">套用</button>' +
          '<button class="btn ghost sm" data-tpl-del="' + h(t.id) + '">删除</button>' +
        '</div>';
      }).join('');

      var mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal" style="max-width:560px"><div class="modal-body" style="white-space:normal">' +
        '<div class="modal-title">套用会议室模板</div>' +
        (rows || '<div class="empty">还没有模板。排好座位后点「☆ 存为模板」。</div>') +
        '<div class="hint" style="margin-top:10px">套用后只替换当前编辑中的布局，确认无误再点「保存布局」。</div>' +
        '</div><div class="modal-foot"><button class="btn ghost" data-x="0">关闭</button></div></div>';
      document.body.appendChild(mask);

      mask.addEventListener('click', function (e) {
        var t = e.target.closest('[data-x]');
        if (t || e.target === mask) mask.remove();

        var ap = e.target.closest('[data-tpl-apply]');
        if (ap) {
          var id = ap.getAttribute('data-tpl-apply');
          var hit = rain.filter(function (x) { return x.id === id; })[0];
          if (!hit) return;
          E.layout = normalize(hit.layout);
          E.layout.mode = hit.mode || 'grid';
          // 模板只套"会议室样式"：座位、分区、尺寸、编号；人员清空，避免串到别人
          E.layout.assign = {};
          E.layout.zoneMap = E.layout.zoneMap || {};
          E.pickedSeat = ''; E.pickedPerson = ''; E.zoneSel = [];
          E.dirty = true;
          mask.remove();
          MS().render();
          toast('已套用模板：' + hit.name + '（记得点保存布局）', 'ok');
          return;
        }

        var dl = e.target.closest('[data-tpl-del]');
        if (dl) {
          var did = dl.getAttribute('data-tpl-del');
          DB().deleteTemplate(did).then(function () {
            dl.closest('.tpl-row').remove();
            toast('模板已删除', 'ok');
          }).catch(function (err) { toast(String(err.message || err), 'err'); });
        }
      });
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  /* 存为模板 */
  /* 手动增加座位：可自己填排号与座位号 */
  function openAddSeat() {
    var L = E.layout;
    var maxRow = 0, maxNo = 0;
    L.seats.forEach(function (x) {
      maxRow = Math.max(maxRow, x.row || 0);
      maxNo = Math.max(maxNo, x.no || 0);
    });
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="max-width:400px"><div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">增加座位</div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr">' +
        '<label class="f"><span class="lb">排号</span>' +
          '<input class="input" id="as-row" type="number" min="1" max="99" value="' + (maxRow || 1) + '"></label>' +
        '<label class="f"><span class="lb">座位号</span>' +
          '<input class="input" id="as-no" type="number" min="1" max="99" value="' + (maxNo + 1) + '"></label>' +
      '</div>' +
      '<div class="hint">新座位会排在该排最右侧；已有「同排同号」时会提示重复。</div>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button>' +
      '<button class="btn" id="as-ok">添加</button></div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      var t = e.target.closest('[data-x]');
      if (t || e.target === mask) mask.remove();
    });
    mask.querySelector('#as-ok').addEventListener('click', function () {
      var row = Math.max(1, parseInt(mask.querySelector('#as-row').value, 10) || 1);
      var no  = Math.max(1, parseInt(mask.querySelector('#as-no').value, 10) || 1);
      mask.remove();

      var L2 = E.layout;
      var dup = L2.seats.some(function (x) { return x.row === row && x.no === no; });
      if (dup) return toast('第 ' + row + ' 排 ' + no + ' 号已经存在', 'warn');
      if (L2.seats.length >= MAX_SEATS) return toast('已达座位上限 ' + MAX_SEATS, 'warn');

      var st = L2.style;
      var sc = (L2.scenes && L2.scenes[0]) || { id: 'main', name: '主会场', x: 0, y: 0 };
      var sameRow = L2.seats.filter(function (x) { return x.row === row; });
      var y;
      if (sameRow.length) {
        y = sameRow[0].y;
      } else {
        var rowsMaxY = 0;
        L2.seats.forEach(function (x) { rowsMaxY = Math.max(rowsMaxY, x.y + x.h); });
        y = L2.seats.length ? rowsMaxY + st.gapY : 40;
      }
      var rightEdge = 40;
      sameRow.forEach(function (x) { rightEdge = Math.max(rightEdge, x.x + x.w + st.gapX); });

      var seat = {
        key: 'x' + Date.now().toString(36),
        sceneId: sc.id, sceneName: sc.name,
        row: row, no: no,
        x: rightEdge, y: y, w: st.seatW, h: st.seatH,
        label: '第' + row + '排 ' + no + '号'
      };
      L2.seats.push(seat);
      L2.canvas.w = Math.max(L2.canvas.w, seat.x + seat.w + 40);
      L2.canvas.h = Math.max(L2.canvas.h, seat.y + seat.h + 40);
      E.dirty = true;
      MS().render();
      toast('已添加 ' + seat.label, 'ok');
    });
  }

  /* 手动增加座位：可自己填排号与座位号 */
  /* 拖拽已排人员到另一个座位：目标有人则互换 */
  function enableSeatDrag() {
    document.querySelectorAll('[data-seat]').forEach(function (el) {
      el.addEventListener('pointerdown', function (e) {
        if (E.zoneMode) return;
        var k = el.getAttribute('data-seat');
        if (!E.layout.assign[k]) return;
        E.dragSrc = k;
        el.classList.add('dragging');
        e.preventDefault();
      });
    });
    if (enableSeatDrag._bound) return;
    enableSeatDrag._bound = true;
    document.addEventListener('pointerup', function (e) {
      var from = E.dragSrc;
      E.dragSrc = null;
      document.querySelectorAll('.dragging').forEach(function (x) { x.classList.remove('dragging'); });
      if (!from) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var t = el && el.closest ? el.closest('[data-seat]') : null;
      if (!t) return;
      var to = t.getAttribute('data-seat');
      if (!to || to === from) return;
      var L = E.layout;
      var a = L.assign[from], b = L.assign[to];
      if (b) L.assign[from] = b; else delete L.assign[from];
      L.assign[to] = a;
      E.dirty = true;
      MS().render();
      toast(b ? '两人座位已对调' : '已移动到该座位', 'ok');
    });
  }

  /* 删掉当前选中的座位 */
  function deleteSeat() {
    var L = E.layout;
    if (!E.pickedSeat) return toast('先在画布上点一下要删除的座位', 'warn');
    var seat = L.seats.filter(function (s) { return s.key === E.pickedSeat; })[0];
    if (!seat) return;
    MS().confirmBox('删除座位「' + seat.label + '」？\n（座位上的人会变回"未安排"）').then(function (ok) {
      if (!ok) return;
      L.seats = L.seats.filter(function (s) { return s.key !== E.pickedSeat; });
      delete L.assign[E.pickedSeat];
      if (L.zoneMap) delete L.zoneMap[E.pickedSeat];
      E.pickedSeat = '';
      E.dirty = true;
      MS().render();
      toast('已删除座位', 'ok');
    });
  }

  /* 删掉最后一个场景及其座位 */
  function deleteScene() {
    var L = E.layout;
    if (L.scenes.length <= 1) return toast('至少要保留 1 个场景', 'warn');
    var sc = L.scenes[L.scenes.length - 1];
    var n = L.seats.filter(function (s) { return s.sceneId === sc.id; }).length;
    MS().confirmBox('删除场景「' + sc.name + '」？\n' + (n ? '该场景下的 ' + n + ' 个座位也会一并删除。' : '')).then(function (ok) {
      if (!ok) return;
      L.scenes = L.scenes.filter(function (x) { return x.id !== sc.id; });
      L.seats = L.seats.filter(function (s) {
        if (s.sceneId !== sc.id) return true;
        delete L.assign[s.key];
        if (L.zoneMap) delete L.zoneMap[s.key];
        return false;
      });
      E.dirty = true;
      MS().render();
      toast('已删除场景', 'ok');
    });
  }

  /* 调整座位大小 */
  function openSeatSize() {
    var L = E.layout;
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="max-width:380px"><div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">座位大小与间距</div>' +
      '<label class="f"><span class="lb">座位宽度（px）</span>' +
        '<input class="input" id="sz-w" type="number" min="60" max="400" value="' + L.style.seatW + '"></label>' +
      '<label class="f"><span class="lb">座位高度（px）</span>' +
        '<input class="input" id="sz-h" type="number" min="30" max="300" value="' + L.style.seatH + '"></label>' +
      '<label class="f"><span class="lb">座位内字号（px）</span>' +
        '<input class="input" id="sz-f" type="number" min="8" max="28" value="' + L.style.font + '"></label>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr">' +
        '<label class="f"><span class="lb">座位间距（横向 px）</span>' +
          '<input class="input" id="sz-gx" type="number" min="0" max="120" value="' + (L.style.gapX || 10) + '"></label>' +
        '<label class="f"><span class="lb">行间距（纵向 px）</span>' +
          '<input class="input" id="sz-gy" type="number" min="0" max="200" value="' + (L.style.gapY || 62) + '"></label>' +
      '</div>' +
      '<label class="f"><span class="lb">过道宽度（px）</span>' +
        '<input class="input" id="sz-aw" type="number" min="0" max="300" value="' + (L.style.aisleW === undefined ? 34 : L.style.aisleW) + '"></label>' +
      '<div class="hint">排座式会按新尺寸与间距自动重排；自由布局直接缩放每个座位块，间距只影响后续生成的排座。</div>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button>' +
      '<button class="btn" id="sz-ok">应用</button></div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      var t = e.target.closest('[data-x]');
      if (t || e.target === mask) mask.remove();
    });
    mask.querySelector('#sz-ok').addEventListener('click', function () {
      var w = Math.max(60, Math.min(400, parseInt(mask.querySelector('#sz-w').value, 10) || 112));
      var hh = Math.max(30, Math.min(300, parseInt(mask.querySelector('#sz-h').value, 10) || 52));
      var f = Math.max(8, Math.min(28, parseInt(mask.querySelector('#sz-f').value, 10) || 12));
      var gx = Math.max(0, Math.min(120, parseInt((mask.querySelector('#sz-gx') || {}).value, 10) || 10));
      var gy = Math.max(0, Math.min(200, parseInt((mask.querySelector('#sz-gy') || {}).value, 10) || 62));
      var awv = (mask.querySelector('#sz-aw') || {}).value;
      var aw = Math.max(0, Math.min(300, awv === '' || awv === undefined ? 34 : (parseInt(awv, 10) || 0)));
      mask.remove();
      L.style.seatW = w; L.style.seatH = hh; L.style.font = f;
      L.style.gapX = gx; L.style.gapY = gy; L.style.aisleW = aw;

      if (L.mode === 'grid' && L.grid) {
        var keep = {};
        L.seats.forEach(function (s) { if (L.assign[s.key]) keep[s.label] = L.assign[s.key]; });
        var res = buildGrid(L.grid, L.style);
        if (res.error) return toast(res.error, 'err');
        L.seats = res.seats;
        L.canvas = res.canvas;
        L.scenes = res.scenes;
        L.assign = {};
        L.seats.forEach(function (s) { if (keep[s.label]) L.assign[s.key] = keep[s.label]; });
      } else {
        L.seats.forEach(function (s) { s.w = w; s.h = hh; });
      }
      E.dirty = true;
      MS().render();
      toast('座位大小已调整', 'ok');
    });
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


  /* 逐排配置（参考 V6 布局增强版）：每排座位数 + 点选走道 + 加排/删排 */
  function openRowConfig() {
    var L = E.layout;
    var rowsInit = (L.grid && L.grid.rows) ? String(L.grid.rows).split(/[,，\s]+/).filter(Boolean) : [];
    if (!rowsInit.length) rowsInit = ['10'];
    var aisleInit = (L.grid && L.grid.aisles) ? String(L.grid.aisles).split(/[,，\s]+/).filter(Boolean).map(Number) : [];
    var rc = rowsInit.map(function (n) { return { seats: Math.max(1, parseInt(n, 10) || 1), aisles: aisleInit.slice() }; });
    var g = L.grid || {};

    function rowHtml(cfg, i) {
      var dots = '';
      for (var k = 1; k < cfg.seats; k++) {
        dots += '<button type="button" class="aisle-dot' + (cfg.aisles.indexOf(k) >= 0 ? ' on' : '') +
          '" data-row="' + i + '" data-k="' + k + '">' + k + '</button>';
      }
      return '<div class="rc-row" data-i="' + i + '">' +
        '<span class="rc-no">第 ' + (i + 1) + ' 排</span>' +
        '<input class="input rc-seats" type="number" min="1" max="60" value="' + cfg.seats + '" data-i="' + i + '" style="width:78px">' +
        '<div class="rc-aisles">' + dots + '</div>' +
        '<button type="button" class="btn ghost sm rc-del" data-i="' + i + '">删除</button>' +
      '</div>';
    }

    function paint() {
      mask.querySelector('#rc-list').innerHTML = rc.map(rowHtml).join('');
    }

    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="max-width:760px"><div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">排座设置</div>' +
      '<div class="hint" style="margin-bottom:10px">每排填座位数；下面每个数字代表一个座位间隙，点一下就在那里留走道。</div>' +
      '<div id="rc-list"></div>' +
      '<div style="margin:10px 0 14px"><button type="button" class="btn ghost sm" id="rc-add">＋ 增加一排</button></div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr">' +
        '<label class="f"><span class="lb">编号方式</span><select class="input" id="lg-range">' +
          '<option value="unified"' + (g.range !== 'byrow' ? ' selected' : '') + '>统一编号（全局连续）</option>' +
          '<option value="byrow"' + (g.range === 'byrow' ? ' selected' : '') + '>按排编号（每排重新从1起）</option>' +
        '</select></label>' +
        '<label class="f"><span class="lb">序号方向</span><select class="input" id="lg-mode">' +
          '<option value="ltr"' + (g.numMode === 'ltr' ? ' selected' : '') + '>从左到右</option>' +
          '<option value="rtl"' + (g.numMode === 'rtl' ? ' selected' : '') + '>从右到左</option>' +
          '<option value="center"' + (g.numMode === 'center' ? ' selected' : '') + '>中间向两边</option>' +
        '</select></label>' +
      '</div>' +
      '<label style="display:block;margin:10px 0"><input type="checkbox" id="lg-bottom" ' +
        (g.firstRowAtBottom !== false ? 'checked' : '') + '> 第一排在最下方（面向主席台）</label>' +
      '<div class="hint">生成会覆盖现有座位与排座结果。</div>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button>' +
      '<button class="btn" id="lg-ok">生成座位</button></div></div>';
    document.body.appendChild(mask);
    paint();

    mask.addEventListener('click', function (e) {
      var del = e.target.closest('.rc-del');
      if (del) {
        if (rc.length <= 1) return toast('至少保留一排', 'warn');
        rc.splice(parseInt(del.getAttribute('data-i'), 10), 1);
        paint(); return;
      }
      var dot = e.target.closest('.aisle-dot');
      if (dot) {
        var i = parseInt(dot.getAttribute('data-row'), 10);
        var k = parseInt(dot.getAttribute('data-k'), 10);
        var arr = rc[i].aisles;
        var idx = arr.indexOf(k);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(k);
        dot.classList.toggle('on');
        return;
      }
      var t = e.target.closest('[data-x]');
      if (t || e.target === mask) mask.remove();
    });

    mask.addEventListener('change', function (e) {
      var inp = e.target.closest('.rc-seats');
      if (!inp) return;
      var i = parseInt(inp.getAttribute('data-i'), 10);
      rc[i].seats = Math.max(1, Math.min(60, parseInt(inp.value, 10) || 1));
      rc[i].aisles = rc[i].aisles.filter(function (x) { return x < rc[i].seats; });
      paint();
    });

    mask.querySelector('#rc-add').addEventListener('click', function () {
      var last = rc[rc.length - 1] || { seats: 10 };
      rc.push({ seats: last.seats, aisles: [] });
      paint();
    });

    mask.querySelector('#lg-ok').addEventListener('click', function () {
      var cfg = {
        rows: rc.map(function (x) { return x.seats; }).join(','),
        aisles: rc[0].aisles.join(','),
        range: mask.querySelector('#lg-range').value,
        numMode: mask.querySelector('#lg-mode').value,
        centerSide: 'left',
        firstRowAtBottom: mask.querySelector('#lg-bottom').checked
      };
      var res = buildGrid(cfg, E.layout.style);
      if (res.error) return toast(res.error, 'err');
      mask.remove();
      var keep = {};
      (E.layout.seats || []).forEach(function (s) { if (E.layout.assign[s.key]) keep[s.label] = E.layout.assign[s.key]; });
      E.layout.mode = 'grid';
      E.layout.grid = cfg;
      E.layout.seats = res.seats;
      E.layout.canvas = res.canvas;
      E.layout.scenes = res.scenes;
      E.layout.assign = {};
      E.layout.zoneMap = {};
      E.layout.seats.forEach(function (s) { if (keep[s.label]) E.layout.assign[s.key] = keep[s.label]; });
      E.dirty = true;
      MS().render();
      toast('已生成 ' + res.seats.length + ' 个座位（' + rc.length + ' 排）', 'ok');
    });
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
