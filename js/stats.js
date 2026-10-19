/* ============================================================
 *  stats.js —— 统计信息
 *
 *   ① 按会议：时间段 + 关键字 + （超管）按用户 筛选会议
 *              → 汇总卡片 + 单场明细 + 导出
 *   ② 按人员：选一个人，可再叠加时间段
 *              → 被邀请/参会/请假/未确认/出席率 + 逐场明细 + 导出
 *
 *   超级管理员：可看全部用户的会议，也可只看某一个用户的。
 * ============================================================ */
(function (root) {
  'use strict';

  function MS() { return root.MS; }
  function P() { return root.MSParser; }
  function X() { return root.MSXlsx; }
  function U() { return root.MSUtil; }
  function DB() { return root.MSDB; }

  function q(id) { return MS().q(id); }
  function h(s) { return MS().h(s); }
  function toast(m, t) { MS().toast(m, t); }
  function S() { return MS().state; }

  /* ================= 筛选 ================= */
  function isSuper() { return !!(S().profile && S().profile.is_super); }

  function filteredMeetings() {
    var st = S();
    var from = st.statsFrom || '';
    var to = st.statsTo || '';
    var kw = String(st.statsKw || '').trim().toLowerCase();
    var owner = st.statsOwner || '';

    return (st.meetings || []).filter(function (m) {
      var d = m.meet_date || '';
      if (from && (!d || d < from)) return false;
      if (to && (!d || d > to)) return false;
      if (owner && m.owner_id !== owner) return false;
      if (kw) {
        var hay = [m.title, m.location, m.convene_dept, m.host, m.contact]
          .map(function (x) { return String(x || ''); }).join(' ').toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
  }

  function responsesOf(meetingId) {
    return (S().responsesCache && S().responsesCache[meetingId]) || [];
  }

  function personList() {
    return P().buildPersonStats(filteredMeetings(), S().allResponses || []);
  }

  function hasFilter() {
    var st = S();
    return !!(st.statsFrom || st.statsTo || String(st.statsKw || '').trim() || st.statsOwner);
  }

  /* ================= 视图 ================= */
  function viewStats() {
    var tab = S().statsTab || 'meeting';
    var tabBar = '<div class="btn-row" style="margin-bottom:12px">' +
      '<button class="btn ' + (tab === 'meeting' ? '' : 'ghost') + ' sm" data-stab="meeting">按会议统计</button>' +
      '<button class="btn ' + (tab === 'person' ? '' : 'ghost') + ' sm" data-stab="person">按人员统计</button>' +
      '<span class="sp" style="flex:1"></span>' +
      '<button class="btn ghost sm" id="st-export-all">⤓ 导出当前会议集</button>' +
      '<button class="btn ghost sm" id="st-export-roster">⤓ 导出名单</button>' +
      '</div>';

    var ps = MS().planState ? MS().planState() : { canExport: true };
    var exportNotice = ps.canExport ? '' :
      '<div class="notice warn" style="margin-bottom:12px">' +
      '导出属于<b>会员功能</b>：你当前套餐未开通或已过期，统计仍可正常查看，' +
      '但点击导出会提示购买。<a href="#/account">去「我的账户」看看套餐 →</a></div>';

    return MS().shell('stats', '统计信息', '', exportNotice + filterBar() + tabBar +
      (tab === 'meeting' ? viewByMeeting() : viewByPerson()));
  }

  function filterBar() {
    var st = S();
    var owners = st.statsOwners || [];
    var ownerSel = '';
    if (isSuper()) {
      ownerSel = '<select class="input" id="st-owner" style="width:190px">' +
        '<option value="">全部用户</option>' +
        owners.map(function (u) {
          return '<option value="' + h(u.id) + '"' + (st.statsOwner === u.id ? ' selected' : '') + '>' +
            h(u.name + '（' + (u.emp_no || '无工号') + '）') + '</option>';
        }).join('') + '</select>';
    }
    return '<div class="card" style="margin-bottom:14px"><div class="card-b" ' +
      'style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
      '<span class="hint">会议时间段</span>' +
      '<input type="date" class="input" id="st-from" style="width:150px" value="' + h(st.statsFrom || '') + '">' +
      '<span class="hint">至</span>' +
      '<input type="date" class="input" id="st-to" style="width:150px" value="' + h(st.statsTo || '') + '">' +
      '<input class="input" id="st-kw" style="width:200px" placeholder="关键字：会议名/地点/部门" value="' + h(st.statsKw || '') + '">' +
      ownerSel +
      '<button class="btn ghost sm" id="st-clear">清除筛选</button>' +
      '<span class="sp" style="flex:1"></span>' +
      '<span class="hint">共筛选出 <b>' + filteredMeetings().length + '</b> 场会议' +
        (isSuper() && !st.statsOwner ? '（全部用户）' : '') + '</span>' +
      '</div></div>';
  }

  /* ---------------- 按会议 ---------------- */
  function viewByMeeting() {
    var meetings = filteredMeetings().slice().sort(function (a, b) {
      return String(b.meet_date || '') < String(a.meet_date || '') ? -1 : 1;
    });
    if (!meetings.length) {
      return '<div class="card"><div class="empty"><span class="big">📊</span>' +
        (hasFilter() ? '没有符合筛选条件的会议' : '还没有会议，先去发布一场') + '</div></div>';
    }

    var sel = S().statsMeetingId || meetings[0].id;
    if (!meetings.some(function (m) { return m.id === sel; })) sel = meetings[0].id;

    // 筛选集合的整体汇总
    var total = { invited: 0, yes: 0, no: 0, pending: 0 };
    meetings.forEach(function (m) {
      var st = P().buildAttendance(m, responsesOf(m.id)).stats;
      total.invited += st.invited; total.yes += st.yes; total.no += st.no; total.pending += st.pending;
    });

    var opts = meetings.map(function (m) {
      return '<option value="' + h(m.id) + '"' + (m.id === sel ? ' selected' : '') + '>' +
        h((m.meet_date || '未定日期') + '　' + (m.title || '未命名会议')) + '</option>';
    }).join('');

    var m = meetings.filter(function (x) { return x.id === sel; })[0];
    var att = P().buildAttendance(m, responsesOf(m.id));
    var st1 = att.stats;
    var filter = S().statsFilter || 'all';
    var rows = P().sortRows(att.rows).filter(function (r) {
      if (filter === 'yes') return r.status === 'yes';
      if (filter === 'no') return r.status === 'no';
      if (filter === 'pending') return r.status === 'pending';
      return true;
    });

    var tbl = rows.map(function (r, i) {
      return '<tr>' +
        '<td class="ctr mini">' + (i + 1) + '</td>' +
        '<td class="mini">' + h(r.emp_no || '—') + '</td>' +
        '<td class="name">' + h(r.name) + (r.on_list ? '' : ' <span class="tag amber">名单外</span>') + '</td>' +
        '<td>' + h(r.category || '—') + '</td>' +
        '<td>' + h(r.dept || '—') + '</td>' +
        '<td>' + tagOf(r.status) + '</td>' +
        '<td>' + (r.reason ? h(r.reason) : '<span class="mini">—</span>') + '</td>' +
        '<td>' + (r.note ? h(r.note) : '<span class="mini">—</span>') + '</td>' +
        '<td class="mini">' + (r.updated_at ? MS().fmtDateTime(r.updated_at) : '—') + '</td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat"><div class="n">' + meetings.length + '</div><div class="t">筛选出的会议数</div></div>' +
        '<div class="stat blue"><div class="n">' + total.invited + '</div><div class="t">受邀人次合计</div></div>' +
        '<div class="stat green"><div class="n">' + total.yes + '</div><div class="t">参会人次合计</div></div>' +
        '<div class="stat red"><div class="n">' + total.no + '</div><div class="t">请假人次合计</div></div>' +
        '<div class="stat amber"><div class="n">' + total.pending + '</div><div class="t">未确认人次合计</div></div>' +
      '</div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-b" ' +
        'style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<span class="hint">选择会议：</span>' +
        '<select class="input" id="st-meeting" style="flex:1;min-width:240px;max-width:520px">' + opts + '</select>' +
        '<button class="btn sm" id="st-do-export">⤓ 导出本场</button>' +
      '</div></div>' +

      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + st1.invited + '</div><div class="t">本场受邀</div></div>' +
        '<div class="stat green"><div class="n">' + st1.yes + '</div><div class="t">确认参会</div></div>' +
        '<div class="stat red"><div class="n">' + st1.no + '</div><div class="t">确认不参会</div></div>' +
        '<div class="stat amber"><div class="n">' + st1.pending + '</div><div class="t">尚未确认</div></div>' +
      '</div>' +

      '<div class="card"><div class="card-h"><h2>' + h(m.title || '会议') + '　明细</h2>' +
        '<span class="sp" style="flex:1"></span>' +
        [['all', '全部'], ['yes', '已参会'], ['no', '已请假'], ['pending', '待确认']].map(function (t) {
          return '<button class="btn ' + (filter === t[0] ? '' : 'ghost') + ' sm" data-sfilter="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
      '</div><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>#</th><th>工号</th><th>姓名</th><th>类别</th><th>部门</th><th>是否参会</th>' +
        '<th>请假原因</th><th>备注</th><th>回执时间</th>' +
      '</tr></thead><tbody>' +
        (tbl || '<tr><td colspan="9"><div class="empty">这个分类下暂时没有人</div></td></tr>') +
      '</tbody></table></div></div>';
  }

  function tagOf(status) {
    if (status === 'yes') return '<span class="tag green">参加</span>';
    if (status === 'no') return '<span class="tag red">不参加</span>';
    return '<span class="tag amber">待确认</span>';
  }

  /* ---------------- 按人员 ---------------- */
  function viewByPerson() {
    var list = personList();
    if (!list.length) {
      return '<div class="card"><div class="empty"><span class="big">👤</span>' +
        (hasFilter() ? '该筛选范围内没有参会人数据' : '还没有参会人数据') + '</div></div>';
    }

    var kw = String(S().statsPersonKw || '').trim().toLowerCase();
    var filtered = !kw ? list : list.filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
             (p.dept || '').toLowerCase().indexOf(kw) >= 0 ||
             (String(p.emp_no || '')).toLowerCase().indexOf(kw) >= 0;
    });

    var selKey = S().statsPerson || (filtered[0] && filtered[0].key);
    var person = filtered.filter(function (p) { return p.key === selKey; })[0] || filtered[0];

    var listHtml = filtered.slice(0, 500).map(function (p) {
      var on = person && p.key === person.key;
      return '<div class="pl-item ' + (on ? 'on' : '') + '" data-person="' + h(p.key) + '">' +
        '<div class="pl-main"><b>' + h(p.name) + '</b>' +
          (p.emp_no ? ' <span class="mini">' + h(p.emp_no) + '</span>' : '') +
          '<div class="mini">' + h(p.dept || '—') + ' · ' + h(p.category || '—') + '</div></div>' +
        '<div class="pl-nums"><span class="tag green">' + p.attended + '</span>' +
          '<span class="tag red">' + p.declined + '</span>' +
          '<span class="tag amber">' + p.pending + '</span></div>' +
      '</div>';
    }).join('') || '<div class="empty">没有匹配的人</div>';

    var detail = '';
    if (person) {
      var rows = person.meetings.map(function (x, i) {
        return '<tr>' +
          '<td class="ctr mini">' + (i + 1) + '</td>' +
          '<td class="mini">' + h(MS().fmtDate(x.meeting.meet_date) || '未定') + '</td>' +
          '<td>' + h(x.meeting.title || '') + '</td>' +
          '<td>' + h(x.meeting.location || '—') + '</td>' +
          '<td>' + tagOf(x.status) + '</td>' +
          '<td>' + (x.reason ? h(x.reason) : '<span class="mini">—</span>') + '</td>' +
          '<td class="mini">' + (x.updated_at ? MS().fmtDateTime(x.updated_at) : '—') + '</td>' +
        '</tr>';
      }).join('');

      detail = '' +
        '<div class="card" style="margin-bottom:14px"><div class="card-h">' +
          '<h2>' + h(person.name) + (person.emp_no ? '（' + h(person.emp_no) + '）' : '') + '</h2>' +
          '<span class="tag blue">' + h(person.dept || '部门未填') + '</span>' +
          '<span class="tag gray">' + h(person.category || '类别未填') + '</span>' +
          '<span class="sp" style="flex:1"></span>' +
          '<button class="btn sm" id="st-person-export">⤓ 导出此人统计</button>' +
        '</div><div class="card-b">' +
          '<div class="grid c3">' +
            '<div class="stat blue"><div class="n">' + person.invited + '</div><div class="t">被邀请次数</div></div>' +
            '<div class="stat green"><div class="n">' + person.attended + '</div><div class="t">总参会次数</div></div>' +
            '<div class="stat red"><div class="n">' + person.declined + '</div><div class="t">请假次数</div></div>' +
            '<div class="stat amber"><div class="n">' + person.pending + '</div><div class="t">未确认次数</div></div>' +
            '<div class="stat ' + (person.rate >= 80 ? 'green' : person.rate >= 50 ? 'amber' : 'red') + '">' +
              '<div class="n">' + person.rate + '%</div><div class="t">出席率（占已回复）</div></div>' +
          '</div>' +
          '<div class="hint" style="margin-top:12px">' +
            (hasFilter() ? '以上数字**只统计当前筛选范围内**的会议。' : '') +
            '出席率 = 已参会 ÷（已参会 + 已请假），未确认不计入分母。</div>' +
        '</div></div>' +

        '<div class="card"><div class="card-h"><h2>参会明细（' + person.meetings.length + ' 场）</h2></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
            '<th>#</th><th>会议日期</th><th>会议名称</th><th>地点</th><th>状态</th><th>请假原因</th><th>回执时间</th>' +
          '</tr></thead><tbody>' +
            (rows || '<tr><td colspan="7"><div class="empty">没有记录</div></td></tr>') +
          '</tbody></table></div></div>';
    }

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" ' +
        'style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<input class="input" id="st-pkw" style="flex:1;min-width:220px;max-width:380px" ' +
          'placeholder="搜索姓名 / 工号 / 部门" value="' + h(S().statsPersonKw || '') + '">' +
        '<span class="hint">共 ' + list.length + ' 位参会人</span>' +
        '<span class="sp" style="flex:1"></span>' +
        '<button class="btn ghost sm" id="st-person-all">⤓ 导出全体人员统计</button>' +
      '</div></div>' +

      '<div class="grid" style="grid-template-columns:300px 1fr;gap:14px;align-items:start" id="person-layout">' +
        '<div class="card"><div class="card-h"><h2>人员列表</h2></div>' +
          '<div class="pl-list">' + listHtml + '</div></div>' +
        '<div>' + detail + '</div>' +
      '</div>';
  }

  /* ================= 绑定 ================= */
  function bindStats() {
    // 超级管理员：加载用户列表供筛选
    if (isSuper() && !S().statsOwners) {
      DB().admin.listUsers().then(function (us) {
        S().statsOwners = us || [];
        MS().render();
      }).catch(function () { S().statsOwners = []; });
    }

    document.querySelectorAll('[data-stab]').forEach(function (b) {
      b.addEventListener('click', function () {
        S().statsTab = b.getAttribute('data-stab');
        MS().render();
      });
    });

    function applyFilter() {
      S().statsFrom = (q('st-from') || {}).value || '';
      S().statsTo = (q('st-to') || {}).value || '';
      S().statsKw = (q('st-kw') || {}).value || '';
      var ow = q('st-owner');
      if (ow) S().statsOwner = ow.value;
      MS().render();
    }

    var from = q('st-from'), to = q('st-to');
    if (from) from.addEventListener('change', applyFilter);
    if (to) to.addEventListener('change', applyFilter);
    var kw = q('st-kw');
    if (kw) kw.addEventListener('change', applyFilter);
    var ow = q('st-owner');
    if (ow) ow.addEventListener('change', applyFilter);
    var clr = q('st-clear');
    if (clr) clr.addEventListener('click', function () {
      S().statsFrom = ''; S().statsTo = ''; S().statsKw = ''; S().statsOwner = '';
      MS().render();
    });

    var sel = q('st-meeting');
    if (sel) sel.addEventListener('change', function () {
      S().statsMeetingId = sel.value;
      MS().render();
    });
    document.querySelectorAll('[data-sfilter]').forEach(function (b) {
      b.addEventListener('click', function () {
        S().statsFilter = b.getAttribute('data-sfilter');
        MS().render();
      });
    });
    var e1 = q('st-do-export');
    if (e1) e1.addEventListener('click', function () {
      var ms = filteredMeetings();
      var m = ms.filter(function (x) { return x.id === (S().statsMeetingId || (ms[0] || {}).id); })[0];
      if (m) exportMeeting(m, responsesOf(m.id));
    });

    var pkw = q('st-pkw');
    if (pkw) pkw.addEventListener('input', function () {
      var pos = pkw.selectionStart;
      S().statsPersonKw = pkw.value;
      MS().render();
      var el = q('st-pkw');
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
    });
    document.querySelectorAll('[data-person]').forEach(function (el) {
      el.addEventListener('click', function () {
        S().statsPerson = el.getAttribute('data-person');
        MS().render();
      });
    });

    var pe = q('st-person-export');
    if (pe) pe.addEventListener('click', function () {
      var list = personList();
      var p = list.filter(function (x) { return x.key === S().statsPerson; })[0] || list[0];
      if (p) exportPerson(p);
    });
    var pa = q('st-person-all');
    if (pa) pa.addEventListener('click', function () { exportPersonSummary(personList()); });

    var ea = q('st-export-all');
    if (ea) ea.addEventListener('click', exportAllMeetings);
    var er = q('st-export-roster');
    if (er) er.addEventListener('click', exportRoster);
  }

  /* ================= 导出 ================= */
  /* 导出的统一拦截：免费/过期用户不能导出（与后端 check_meeting_allowed 的口径一致） */
  function guardExport() {
    var ps = MS().planState ? MS().planState() : { canExport: true };
    if (ps.canExport) return true;
    MS().requireExport();
    return false;
  }

  function xlsxBlob(bytes) {
    return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function sheetFromMeeting(m, rs) {
    return {
      name: P().sheetName(m.title, m.meet_date),
      rows: P().meetingSheetRows(m, rs),
      colWidths: [8, 12, 14, 14, 26, 11, 26, 22, 18]
    };
  }
  function allPairs() {
    return filteredMeetings().map(function (m) {
      return { m: m, rs: responsesOf(m.id) };
    });
  }

  function exportMeeting(m, rs) {
    if (!guardExport()) return;
    try {
      var bytes = X().buildXlsx([sheetFromMeeting(m, rs)]);
      U().download(U().safeFileName('参会情况_' + (m.title || '会议') + '_' + (m.meet_date || '')) + '.xlsx', xlsxBlob(bytes));
      toast('已导出本场会议', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportAllMeetings() {
    if (!guardExport()) return;
    var pairs = allPairs();
    if (!pairs.length) return toast('当前筛选范围内没有会议', 'warn');
    try {
      var sheets = [{
        name: '总览', rows: P().summarySheetRows(pairs),
        colWidths: [6, 30, 14, 14, 22, 20, 10, 10, 12, 10, 9]
      }];
      pairs.forEach(function (p) { sheets.push(sheetFromMeeting(p.m, p.rs)); });
      var bytes = X().buildXlsx(sheets);
      U().download('会议统计汇总_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('已导出 ' + pairs.length + ' 场会议', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportRoster() {
    if (!guardExport()) return;
    try {
      var bytes = X().buildXlsx([{
        name: '人员名单', rows: P().rosterSheetRows(S().roster || []),
        colWidths: [7, 30, 14, 12, 12, 16, 24]
      }]);
      U().download('人员名单_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('名单已导出', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportPerson(p) {
    if (!guardExport()) return;
    try {
      var bytes = X().buildXlsx([{
        name: String(p.name).slice(0, 20) + '_参会统计',
        rows: P().personSheetRows(p),
        colWidths: [10, 14, 30, 22, 11, 24, 22, 18]
      }]);
      U().download('参会统计_' + U().safeFileName(p.name) + '_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('已导出「' + p.name + '」的统计', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportPersonSummary(list) {
    if (!guardExport()) return;
    try {
      var bytes = X().buildXlsx([{
        name: '人员统计', rows: P().personSummaryRows(list),
        colWidths: [6, 12, 12, 26, 14, 12, 10, 10, 10, 10]
      }]);
      U().download('全体人员参会统计_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('已导出 ' + list.length + ' 人的统计', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  root.MSStats = {
    viewStats: viewStats, bindStats: bindStats,
    exportMeeting: exportMeeting, exportAllMeetings: exportAllMeetings,
    exportRoster: exportRoster, exportPerson: exportPerson, exportPersonSummary: exportPersonSummary,
    personList: personList, filteredMeetings: filteredMeetings
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
