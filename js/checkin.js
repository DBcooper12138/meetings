/* ============================================================
 *  checkin.js —— 签到管理（会议创建者视角）
 *
 *  · 设置签到开放/截止时间
 *  · 二维码 + 链接（与参会确认同一个链接，一码两用）
 *  · 实时签到名单（含座位）+ 未签到名单 + 手动补签/撤销
 * ============================================================ */
(function (root) {
  'use strict';

  function MS() { return root.MS; }
  function DB() { return root.MSDB; }
  function U() { return root.MSUtil; }
  function QR() { return root.MSQR; }
  function P() { return root.MSParser; }
  function h(s) { return U().esc(s); }
  function q(id) { return document.getElementById(id); }
  function toast(m, t) { U().toast(m, t); }

  var C = { meetingId: '', meeting: null, checkins: [], responses: [] };

  function shareUrl(token) {
    return location.href.split('#')[0] + '#/s/' + token;
  }

  /* 人员键：工号优先 */
  function pk(emp, name) {
    var e = String(emp || '').replace(/\s+/g, '').toLowerCase();
    if (e) return 'e:' + e;
    var n = String(name || '').replace(/\s+/g, '').toLowerCase();
    return n ? 'n:' + n : '';
  }

  function open(meetingId) {
    var m = MS().state.meetings.filter(function (x) { return x.id === meetingId; })[0];
    C.meetingId = meetingId;
    C.meeting = m || null;
    if (!m) return Promise.resolve(null);
    return Promise.all([DB().listCheckins(meetingId), DB().listResponses(meetingId)])
      .then(function (r) {
        C.checkins = r[0] || [];
        C.responses = r[1] || [];
        return C;
      }).catch(function () { C.checkins = []; C.responses = []; return C; });
  }

  function reload() {
    return open(C.meetingId).then(function () { MS().render(); });
  }

  /* ================= 视图 ================= */
  function viewCheckin() {
    var m = C.meeting;
    if (!m) return MS().shell('meetings', '签到', '', '<div class="card"><div class="empty">会议不存在</div></div>');

    var url = shareUrl(m.share_token);
    var now = Date.now();
    var st = m.checkin_start ? new Date(m.checkin_start).getTime() : null;
    var en = m.checkin_end ? new Date(m.checkin_end).getTime() : null;
    var openNow = m.layout_enabled && (st === null || now >= st) && (en === null || now <= en);

    var statusTag = !m.layout_enabled
      ? '<span class="tag gray">未开启</span>'
      : (openNow ? '<span class="tag green">签到进行中</span>'
                 : (st !== null && now < st ? '<span class="tag amber">未到开放时间</span>'
                                            : '<span class="tag red">已结束</span>'));

    var att = P().buildAttendance(m, C.responses);
    var shouldCome = att.rows.filter(function (r) { return r.status !== 'no'; });
    var checkedSet = {};
    C.checkins.forEach(function (c) { checkedSet[c.person_key] = c; });

    var checkedRows = C.checkins.map(function (c) {
      return '<tr>' +
        '<td class="mini">' + h(c.emp_no || '—') + '</td>' +
        '<td class="name">' + h(c.name) + (c.source === 'manual' ? ' <span class="tag gray">补签</span>' : '') + '</td>' +
        '<td>' + (c.seat_label ? h(c.seat_label) : '<span class="mini">未排座</span>') + '</td>' +
        '<td>' + h(c.scene_name || '') + '</td>' +
        '<td class="mini">' + U().fmtDateTime(c.checked_in_at) + '</td>' +
        '<td class="ctr"><button class="btn ghost sm" data-undo="' + h(c.id) + '">撤销</button></td>' +
      '</tr>';
    }).join('');

    var notYet = shouldCome.filter(function (r) {
      return !checkedSet[pk(r.emp_no, r.name)];
    });
    var notYetRows = notYet.map(function (r) {
      return '<tr>' +
        '<td class="mini">' + h(r.emp_no || '—') + '</td>' +
        '<td class="name">' + h(r.name) + '</td>' +
        '<td>' + h(r.category || '—') + '</td>' +
        '<td class="mini">' + h(r.status === 'yes' ? '已确认参会' : '未确认') + '</td>' +
        '<td class="ctr"><button class="btn ghost sm" data-manual="' + h(pk(r.emp_no, r.name)) +
          '" data-name="' + h(r.name) + '" data-emp="' + h(r.emp_no || '') + '">补签</button></td>' +
      '</tr>';
    }).join('');

    var body =
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn ghost sm" data-go="#/meeting/' + h(m.id) + '">← 返回会议</button>' +
        '<button class="btn ghost sm" data-go="#/meeting/' + h(m.id) + '/layout">🪑 会场布局</button>' +
        '<span class="sp" style="flex:1"></span>' +
        '<button class="btn ghost sm" id="ck-refresh">⟳ 刷新</button>' +
      '</div>' +

      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + shouldCome.length + '</div><div class="t">应到人数</div></div>' +
        '<div class="stat green"><div class="n">' + C.checkins.length + '</div><div class="t">已签到</div></div>' +
        '<div class="stat amber"><div class="n">' + notYet.length + '</div><div class="t">未签到</div></div>' +
      '</div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>签到设置</h2>' + statusTag + '</div>' +
        '<div class="card-b">' +
          (m.layout_enabled ? '' : '<div class="notice warn">这场会议没有开启「会场布局」，签到不可用。' +
            '先到 <a href="#/meeting/' + h(m.id) + '/layout">会场布局</a> 排好座位，或在编辑会议里勾选「需要会场布局」。</div>') +
          '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">' +
            '<label class="f"><span class="lb">签到开放时间</span>' +
              '<input type="datetime-local" class="input" id="ck-start" value="' + h(U().toLocalInput(m.checkin_start)) + '"></label>' +
            '<label class="f"><span class="lb">签到截止时间</span>' +
              '<input type="datetime-local" class="input" id="ck-end" value="' + h(U().toLocalInput(m.checkin_end)) + '"></label>' +
          '</div>' +
          '<div class="btn-row">' +
            '<button class="btn sm" id="ck-save">保存时间</button>' +
            '<button class="btn ghost sm" id="ck-quick">设为"现在开始，2 小时后截止"</button>' +
          '</div>' +
          '<div class="hint" style="margin-top:8px">参会人扫码打开的是同一个确认链接；' +
          '在签到时间内，页面会多出「我要签到」按钮，签完直接显示座位。</div>' +
        '</div></div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>签到二维码</h2></div>' +
        '<div class="card-b">' +
          '<div class="linkbox">' +
            '<input class="input" readonly value="' + h(url) + '" id="ck-url">' +
            '<button class="btn" id="ck-copy">复制链接</button>' +
            '<button class="btn ghost" id="ck-qr">显示二维码</button>' +
          '</div>' +
          '<div id="ck-qr-box" style="display:none;margin-top:14px">' +
            '<img class="qr-img" id="ck-qr-img" alt="签到二维码">' +
            '<div class="hint">投到投影上，或打印出来贴在门口。</div>' +
          '</div>' +
        '</div></div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>已签到（' + C.checkins.length + '）</h2></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>工号</th><th>姓名</th><th>座位</th><th>场景</th><th>签到时间</th><th></th>' +
        '</tr></thead><tbody>' +
          (checkedRows || '<tr><td colspan="6"><div class="empty">还没有人签到</div></td></tr>') +
        '</tbody></table></div></div>' +

      '<div class="card"><div class="card-h"><h2>未签到（' + notYet.length + '）</h2>' +
        '<span class="hint">有人到了但没扫码？点「补签」</span></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>工号</th><th>姓名</th><th>类别</th><th>回执状态</th><th></th>' +
        '</tr></thead><tbody>' +
          (notYetRows || '<tr><td colspan="5"><div class="empty">大家都签到了</div></td></tr>') +
        '</tbody></table></div></div>';

    return MS().shell('meetings', '签到 · ' + (m.title || ''), '', body);
  }

  /* ================= 绑定 ================= */
  function bindCheckin() {
    var save = q('ck-save');
    if (save) save.addEventListener('click', function () {
      var s = U().fromLocalInput(q('ck-start').value);
      var e = U().fromLocalInput(q('ck-end').value);
      if (s && e && new Date(s) >= new Date(e)) return toast('截止时间要晚于开放时间', 'warn');
      save.disabled = true;
      DB().updateMeeting(C.meetingId, { checkin_start: s, checkin_end: e })
        .then(function () { return MS().refreshAll(); })
        .then(function () { return reload(); })
        .then(function () { toast('签到时间已保存', 'ok'); })
        .catch(function (err) { toast(String(err.message || err), 'err'); save.disabled = false; });
    });

    var quick = q('ck-quick');
    if (quick) quick.addEventListener('click', function () {
      var now = new Date();
      var end = new Date(now.getTime() + 2 * 3600 * 1000);
      DB().updateMeeting(C.meetingId, {
        checkin_start: now.toISOString(), checkin_end: end.toISOString(),
        layout_enabled: true
      }).then(function () { return MS().refreshAll(); })
        .then(function () { return reload(); })
        .then(function () { toast('已从当前时间开启签到，2 小时后截止', 'ok'); })
        .catch(function (err) { toast(String(err.message || err), 'err'); });
    });

    var cp = q('ck-copy');
    if (cp) cp.addEventListener('click', function () {
      var v = q('ck-url').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(function () { toast('链接已复制', 'ok'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = v; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove(); toast('链接已复制', 'ok');
      }
    });

    var qb = q('ck-qr');
    if (qb) qb.addEventListener('click', function () {
      var box = q('ck-qr-box');
      if (box.style.display === 'none') {
        try { q('ck-qr-img').src = QR().toPngDataUrl(q('ck-url').value, 6); }
        catch (e) { return toast('二维码生成失败：' + e.message, 'err'); }
        box.style.display = 'block';
      } else box.style.display = 'none';
    });

    var rf = q('ck-refresh');
    if (rf) rf.addEventListener('click', function () {
      rf.disabled = true;
      reload().then(function () { toast('已刷新', 'ok'); })
        .catch(function (e) { toast(String(e.message || e), 'err'); rf.disabled = false; });
    });

    document.querySelectorAll('[data-undo]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-undo');
        MS().confirmBox('撤销这条签到？').then(function (ok) {
          if (!ok) return;
          DB().deleteCheckin(id).then(function () { return reload(); })
            .then(function () { toast('已撤销', 'ok'); })
            .catch(function (e) { toast(String(e.message || e), 'err'); });
        });
      });
    });

    document.querySelectorAll('[data-manual]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-name');
        var emp = b.getAttribute('data-emp');
        DB().manualCheckin(C.meetingId, { name: name, emp_no: emp })
          .then(function () { return reload(); })
          .then(function () { toast('已补签：' + name, 'ok'); })
          .catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });
  }

  root.MSCheckin = {
    open: open,
    viewCheckin: viewCheckin,
    bindCheckin: bindCheckin,
    state: C,
    personKey: pk
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
