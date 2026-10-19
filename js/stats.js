/* ============================================================
 *  stats.js —— 统计面板
 *   ① 按会议：选一场会议 → 参会/不参会/待确认 + 明细 + 导出
 *   ② 按人员：选一个人 → 参加过哪些会、总参会次数、请假次数、出席率 + 导出
 *   ③ 导出：单场 / 全部 / 总览 / 名单 / 人员统计
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

  function dataPair(meetingId) {
    var S = MS().state;
    var m = (S.meetings || []).filter(function (x) { return x.id === meetingId; })[0];
    if (!m) return null;
    var rs = (S.responsesCache && S.responsesCache[meetingId]) || [];
    return { m: m, rs: rs };
  }

  function personList() {
    var S = MS().state;
    return P().buildPersonStats(S.meetings || [], S.allResponses || []);
  }

  /* ================= 视图 ================= */
  function viewStats() {
    var S = MS().state;
    var tab = S.statsTab || 'meeting';
    var body = '';

    var tabs = '<div class="btn-row" style="margin-bottom:14px">' +
      '<button class="btn ' + (tab === 'meeting' ? '' : 'ghost') + ' sm" data-stab="meeting">按会议统计</button>' +
      '<button class="btn ' + (tab === 'person' ? '' : 'ghost') + ' sm" data-stab="person">按人员统计</button>' +
      '<span class="sp" style="flex:1"></span>' +
      '<button class="btn ghost sm" id="st-export-all">⤓ 导出全部会议</button>' +
      '<button class="btn ghost sm" id="st-export-summary">⤓ 导出总览</button>' +
      '<button class="btn ghost sm" id="st-export-roster">⤓ 导出名单</button>' +
      '</div>';

    if (tab === 'meeting') body = viewByMeeting();
    else body = viewByPerson();

    return MS().shell('stats', '统计', '', tabs + body);
  }

  function viewByMeeting() {
    var S = MS().state;
    var meetings = (S.meetings || []).slice().sort(function (a, b) {
      return String(b.meet_date || '') < String(a.meet_date || '') ? -1 : 1;
    });
    if (!meetings.length) {
      return '<div class="card"><div class="empty"><span class="big">📊</span>还没有会议，先去发布一场</div></div>';
    }
    var sel = S.statsMeetingId || meetings[0].id;
    if (!meetings.some(function (m) { return m.id === sel; })) sel = meetings[0].id;

    var opts = meetings.map(function (m) {
      return '<option value="' + h(m.id) + '"' + (m.id === sel ? ' selected' : '') + '>' +
        h((m.meet_date || '未定日期') + '　' + (m.title || '未命名会议')) + '</option>';
    }).join('');

    var pair = dataPair(sel);
    if (!pair) return '<div class="card"><div class="empty">会议数据异常</div></div>';

    var att = P().buildAttendance(pair.m, pair.rs);
    var st = att.stats;
    var filter = S.statsFilter || 'all';
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
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<span class="hint">选择会议：</span>' +
        '<select class="input" id="st-meeting" style="flex:1;min-width:260px;max-width:520px">' + opts + '</select>' +
        '<button class="btn sm" id="st-do-export">⤓ 导出本场</button>' +
      '</div></div>' +

      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + st.invited + '</div><div class="t">受邀人数</div></div>' +
        '<div class="stat green"><div class="n">' + st.yes + '</div><div class="t">确认参会</div></div>' +
        '<div class="stat red"><div class="n">' + st.no + '</div><div class="t">确认不参会</div></div>' +
        '<div class="stat amber"><div class="n">' + st.pending + '</div><div class="t">尚未确认</div></div>' +
      '</div>' +

      '<div class="card"><div class="card-h"><h2>' + h(pair.m.title || '会议') + '　明细</h2>' +
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

  function viewByPerson() {
    var S = MS().state;
    var list = personList();
    if (!list.length) {
      return '<div class="card"><div class="empty"><span class="big">👤</span>还没有参会人数据</div></div>';
    }

    var kw = (S.statsPersonKw || '').trim().toLowerCase();
    var filtered = !kw ? list : list.filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
             (p.dept || '').toLowerCase().indexOf(kw) >= 0 ||
             (String(p.emp_no || '')).toLowerCase().indexOf(kw) >= 0;
    });

    var selKey = S.statsPerson || (filtered[0] && filtered[0].key);
    var person = filtered.filter(function (p) { return p.key === selKey; })[0] || filtered[0];

    var listHtml = filtered.slice(0, 300).map(function (p) {
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
          '<div class="hint" style="margin-top:12px">出席率 = 已参会 /（已参会 + 已请假）。' +
          '未确认的会议不计入分母。</div>' +
        '</div></div>' +

        '<div class="card"><div class="card-h"><h2>参会明细（' + person.meetings.length + ' 场）</h2></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
            '<th>#</th><th>会议日期</th><th>会议名称</th><th>地点</th><th>状态</th><th>请假原因</th><th>回执时间</th>' +
          '</tr></thead><tbody>' +
            (rows || '<tr><td colspan="7"><div class="empty">没有记录</div></td></tr>') +
          '</tbody></table></div></div>';
    }

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<input class="input" id="st-pkw" style="flex:1;min-width:240px;max-width:420px" ' +
          'placeholder="搜索姓名 / 工号 / 部门" value="' + h(S.statsPersonKw || '') + '">' +
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
    document.querySelectorAll('[data-stab]').forEach(function (b) {
      b.addEventListener('click', function () {
        MS().state.statsTab = b.getAttribute('data-stab');
        MS().render();
      });
    });

    var sel = q('st-meeting');
    if (sel) sel.addEventListener('change', function () {
      MS().state.statsMeetingId = sel.value;
      MS().render();
    });
    document.querySelectorAll('[data-sfilter]').forEach(function (b) {
      b.addEventListener('click', function () {
        MS().state.statsFilter = b.getAttribute('data-sfilter');
        MS().render();
      });
    });
    var exp1 = q('st-do-export');
    if (exp1) exp1.addEventListener('click', function () {
      var pair = dataPair(MS().state.statsMeetingId || (MS().state.meetings[0] || {}).id);
      if (pair) exportMeeting(pair.m, pair.rs);
    });

    var pkw = q('st-pkw');
    if (pkw) pkw.addEventListener('input', function () {
      var pos = pkw.selectionStart;
      MS().state.statsPersonKw = pkw.value;
      MS().render();
      var el = q('st-pkw');
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
    });
    document.querySelectorAll('[data-person]').forEach(function (el) {
      el.addEventListener('click', function () {
        MS().state.statsPerson = el.getAttribute('data-person');
        MS().render();
      });
    });

    var pe = q('st-person-export');
    if (pe) pe.addEventListener('click', function () {
      var list = personList();
      var p = list.filter(function (x) { return x.key === MS().state.statsPerson; })[0] || list[0];
      if (p) exportPerson(p);
    });
    var pa = q('st-person-all');
    if (pa) pa.addEventListener('click', function () { exportPersonSummary(personList()); });

    var ea = q('st-export-all');
    if (ea) ea.addEventListener('click', exportAllMeetings);
    var es = q('st-export-summary');
    if (es) es.addEventListener('click', exportSummaryAll);
    var er = q('st-export-roster');
    if (er) er.addEventListener('click', exportRoster);
  }

  /* ================= 导出 ================= */
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
    var S = MS().state;
    return (S.meetings || []).map(function (m) {
      return { m: m, rs: (S.responsesCache && S.responsesCache[m.id]) || [] };
    });
  }

  function exportMeeting(m, rs) {
    try {
      var bytes = X().buildXlsx([sheetFromMeeting(m, rs)]);
      U().download(U().safeFileName('参会情况_' + (m.title || '会议') + '_' + (m.meet_date || '')) + '.xlsx', xlsxBlob(bytes));
      toast('已导出本场会议', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportAllMeetings() {
    var pairs = allPairs();
    if (!pairs.length) return toast('还没有会议', 'warn');
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

  function exportSummaryAll() {
    var pairs = allPairs();
    if (!pairs.length) return toast('还没有会议', 'warn');
    try {
      var bytes = X().buildXlsx([{
        name: '总览', rows: P().summarySheetRows(pairs),
        colWidths: [6, 30, 14, 14, 22, 20, 10, 10, 12, 10, 9]
      }]);
      U().download('会议总览统计_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('总览统计已导出', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportRoster() {
    try {
      var bytes = X().buildXlsx([{
        name: '人员名单', rows: P().rosterSheetRows(MS().state.roster || []),
        colWidths: [7, 30, 14, 12, 12, 16, 24]
      }]);
      U().download('人员名单_' + U().todayISO() + '.xlsx', xlsxBlob(bytes));
      toast('名单已导出', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function exportPerson(p) {
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
    exportSummaryAll: exportSummaryAll, exportRoster: exportRoster,
    exportPerson: exportPerson, exportPersonSummary: exportPersonSummary,
    personList: personList
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
