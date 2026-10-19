/* ============================================================
 *  parser.js —— 纯数据处理逻辑（无 DOM 依赖，便于自检）
 *    · rowsToRoster   Excel/CSV 二维表 -> 人员名单
 *    · buildAttendance 会议受邀名单 × 回执 -> 参会情况
 *    · meetingSheetRows / summarySheetRows  -> 导出用的表格数据
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MSParser = api;
    if (root.MSUtil) {
      root.MSParser._nameKey = root.MSUtil.nameKey;
      root.MSParser._fmtDate = root.MSUtil.fmtDate;
      root.MSParser._fmtDateWeek = root.MSUtil.fmtDateWeek;
      root.MSParser._fmtDateTime = root.MSUtil.fmtDateTime;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function nameKey(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }

  /* ================= 名单导入 ================= */

  function trim(v) { return String(v == null ? '' : v).trim(); }

  function rowsToRoster(grid) {
    grid = (grid || []).filter(function (r) {
      return r && r.some(function (c) { return trim(c) !== ''; });
    });
    if (!grid.length) return [];

    var head = grid[0].map(trim);
    // 只在"表头样"的单元格里找列名：整格恰好是「姓名」这类词，或含明确后缀
    // （不能用 /姓名/ 这种宽松匹配 ——「党总支书记」里也含"书记"、"姓名"会误中）
    var HEAD_RE = {
      name: /^(姓名|名字|人员姓名)/,
      emp: /^(工号|员工号|职工号|教工号|人员编号|编号)/,
      dept: /^(部门|单位|学院|处室|机构|部门名称|所在部门|部门\/单位)/,
      cat: /^(类别|分类|身份|职务类型|人员类别|类别名称)/,
      phone: /^(手机|手机号|电话|联系电话|联系方式)/,
      note: /^(备注|说明|备注说明)/,
      sort: /^(序号|排序)/
    };
    function find(re) {
      for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i;
      return -1;
    }
    var iName = find(HEAD_RE.name);
    var iEmp = find(HEAD_RE.emp);
    var iDept = find(HEAD_RE.dept);
    var iCat = find(HEAD_RE.cat);
    var iPhone = find(HEAD_RE.phone);
    var iNote = find(HEAD_RE.note);
    var iSort = find(HEAD_RE.sort);

    var hasHeader = iName >= 0 || iDept >= 0 || iCat >= 0 || iEmp >= 0;
    // 无表头时的列序推断（v2 多了「工号」列）
    if (!hasHeader && grid[0].length >= 5) { iSort = 0; iDept = 1; iCat = 2; iEmp = 3; iName = 4; }
    else if (!hasHeader && grid[0].length === 4) { iSort = 0; iDept = 1; iCat = 2; iName = 3; }
    else if (!hasHeader && grid[0].length === 3) { iDept = 0; iCat = 1; iName = 2; }
    else if (!hasHeader && grid[0].length === 2) { iDept = 0; iName = 1; }

    var start = hasHeader ? 1 : 0;
    var out = [], seen = Object.create(null);
    for (var i = start; i < grid.length; i++) {
      var r = grid[i] || [];
      function cell(ix) { return ix >= 0 && ix < r.length && r[ix] != null ? trim(r[ix]) : ''; }
      var nm = cell(iName);
      if (!nm || /^姓名$/.test(nm)) continue;
      var dept = cell(iDept);
      var cat = cell(iCat);
      // 去重键含「类别」：同一个人在同一部门可能有两种身份
      // （例如白建侠同时是数学教学部的办公室主任和院长），这两种都要保留。
      var key = dept + '@@' + cat + '@@' + nm;
      if (seen[key]) continue;
      seen[key] = 1;
      var sortRaw = cell(iSort).replace(/[^\d]/g, '');
      out.push({
        sort_no: sortRaw ? parseInt(sortRaw, 10) : (out.length + 1),
        dept: dept, category: cat, emp_no: cell(iEmp), name: nm,
        phone: cell(iPhone), note: cell(iNote), active: true
      });
    }
    return out;
  }

  /* ================= 参会情况汇总 ================= */

  var RANK = { pending: 0, yes: 1, no: 2 };

  function buildAttendance(meeting, responses) {
    responses = responses || [];
    var map = Object.create(null);
    responses.forEach(function (r) { map[r.name_key] = r; });

    var invite = (meeting && meeting.invite) || [];
    var used = Object.create(null);

    var invited = invite.map(function (p) {
      var k = nameKey(p.name);
      used[k] = 1;
      var r = map[k];
      return {
        name: p.name, emp_no: p.emp_no || '', dept: p.dept || '', category: p.category || '',
        status: r ? (r.attending ? 'yes' : 'no') : 'pending',
        reason: r ? (r.reason || '') : '', note: r ? (r.note || '') : '',
        updated_at: r ? r.updated_at : '', on_list: true
      };
    });

    var outside = responses.filter(function (r) { return !used[r.name_key]; }).map(function (r) {
      return {
        name: r.name_raw, emp_no: '', dept: r.dept || '', category: r.category || '',
        status: r.attending ? 'yes' : 'no',
        reason: r.reason || '', note: r.note || '',
        updated_at: r.updated_at, on_list: false
      };
    });

    var rows = invited.concat(outside);
    var stats = {
      invited: invite.length,
      yes: rows.filter(function (x) { return x.status === 'yes'; }).length,
      no: rows.filter(function (x) { return x.status === 'no'; }).length,
      pending: rows.filter(function (x) { return x.status === 'pending'; }).length,
      outside: outside.length,
      answered: rows.filter(function (x) { return x.status !== 'pending'; }).length
    };
    return { rows: rows, invited: invited, outside: outside, stats: stats };
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
      return String(a.category || '').localeCompare(String(b.category || ''), 'zh') ||
             String(a.dept || '').localeCompare(String(b.dept || ''), 'zh');
    });
  }

  /* ================= 导出表格 ================= */

  function statusText(st) { return st === 'yes' ? '参加' : (st === 'no' ? '不参加' : '未确认'); }

  var fmt = {
    date: function (d) { return d ? String(d) : ''; },
    dateWeek: function (d) { return d ? String(d) : ''; },
    dateTime: function (d) { return d ? String(d) : ''; }
  };

  function setFormatters(f) {
    if (f && f.date) fmt.date = f.date;
    if (f && f.dateWeek) fmt.dateWeek = f.dateWeek;
    if (f && f.dateTime) fmt.dateTime = f.dateTime;
  }

  function meetingSheetRows(m, responses) {
    var att = buildAttendance(m, responses);
    var rows = [
      ['会议名称', m.title || ''],
      ['会议日期', fmt.dateWeek(m.meet_date) || ''],
      ['会议时间', (m.start_time || '') + (m.end_time ? '–' + m.end_time : '')],
      ['会议地点', m.location || ''],
      ['主办部门', m.convene_dept || ''],
      ['主持人', m.host || ''],
      ['联系人', m.contact || ''],
      ['填报截止', m.deadline ? fmt.dateTime(m.deadline) : '不限'],
      ['受邀人数', att.stats.invited],
      ['确认参会', att.stats.yes],
      ['确认不参会', att.stats.no],
      ['尚未确认', att.stats.pending],
      [],
      ['序号', '工号', '姓名', '类别', '部门', '是否参会', '不参会原因', '备注', '回执时间']
    ];
    sortRows(att.rows).forEach(function (r, i) {
      rows.push([i + 1, r.emp_no || '', r.name, r.category, r.dept, statusText(r.status),
                 r.reason || '', r.note || '',
                 r.updated_at ? fmt.dateTime(r.updated_at) : '']);
    });
    if (m.agenda) { rows.push([]); rows.push(['会议议程 / 说明']); rows.push([m.agenda]); }
    return rows;
  }

  function summarySheetRows(pairs) {
    var rows = [['序号', '会议名称', '会议日期', '时间', '地点', '主办部门', '受邀人数',
                 '确认参会', '确认不参会', '尚未确认', '回执率']];
    pairs.forEach(function (p, i) {
      var st = buildAttendance(p.m, p.rs).stats;
      rows.push([
        i + 1, p.m.title || '', fmt.date(p.m.meet_date) || '',
        (p.m.start_time || '') + (p.m.end_time ? '–' + p.m.end_time : ''),
        p.m.location || '', p.m.convene_dept || '',
        st.invited, st.yes, st.no, st.pending,
        (st.invited ? Math.round(st.answered * 100 / st.invited) : 0) + '%'
      ]);
    });
    return rows;
  }

  function rosterSheetRows(roster) {
    var rows = [['序号', '部门', '类别', '工号', '姓名', '手机号', '备注']];
    roster.slice().sort(function (a, b) { return (a.sort_no || 0) - (b.sort_no || 0); })
      .forEach(function (p, i) {
        rows.push([p.sort_no || i + 1, p.dept || '', p.category || '', p.emp_no || '',
                   p.name, p.phone || '', p.note || '']);
      });
    return rows;
  }

  /* ================= 人员维度统计 =================
     把「所有会议 + 所有回执」摊平成"每个人 × 每场会议"的记录。
     返回 [{ key, name, emp_no, dept, category,
             invited: n, attended: n, declined: n, pending: n,
             rate: 0-100, meetings: [{meeting, status, reason, note, updated_at}] }]
  */
  function buildPersonStats(meetings, responses) {
    var byMeeting = Object.create(null);
    (responses || []).forEach(function (r) {
      (byMeeting[r.meeting_id] = byMeeting[r.meeting_id] || []).push(r);
    });

    var people = Object.create(null);

    function ensure(name, extra) {
      var k = nameKey(name);
      if (!k) return null;
      if (!people[k]) {
        people[k] = {
          key: k, name: name, emp_no: '', dept: '', category: '',
          invited: 0, attended: 0, declined: 0, pending: 0, rate: 0, meetings: []
        };
      }
      var p = people[k];
      if (extra) {
        if (!p.emp_no && extra.emp_no) p.emp_no = extra.emp_no;
        if (!p.dept && extra.dept) p.dept = extra.dept;
        if (!p.category && extra.category) p.category = extra.category;
      }
      return p;
    }

    (meetings || []).forEach(function (m) {
      var att = buildAttendance(m, byMeeting[m.id] || []);
      att.rows.forEach(function (row) {
        var p = ensure(row.name, row);
        if (!p) return;
        p.invited++;
        if (row.status === 'yes') p.attended++;
        else if (row.status === 'no') p.declined++;
        else p.pending++;
        p.meetings.push({
          meeting: m, status: row.status, reason: row.reason || '',
          note: row.note || '', updated_at: row.updated_at || '', on_list: row.on_list
        });
      });
    });

    var list = Object.keys(people).map(function (k) {
      var p = people[k];
      var answered = p.attended + p.declined;
      p.rate = answered ? Math.round(p.attended * 100 / answered) : 0;
      p.meetings.sort(function (a, b) {
        return String(b.meeting.meet_date || '') < String(a.meeting.meet_date || '') ? -1 : 1;
      });
      return p;
    });
    list.sort(function (a, b) {
      if (b.invited !== a.invited) return b.invited - a.invited;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    return list;
  }

  /* 单人统计导出表 */
  function personSheetRows(person) {
    var rows = [
      ['姓名', person.name],
      ['工号', person.emp_no || ''],
      ['部门', person.dept || ''],
      ['类别', person.category || ''],
      ['被邀请次数', person.invited],
      ['已参会', person.attended],
      ['已请假', person.declined],
      ['未确认', person.pending],
      ['出席率（占已回复）', person.rate + '%'],
      [],
      ['序号', '会议日期', '会议名称', '地点', '是否参会', '请假原因', '备注', '回执时间']
    ];
    person.meetings.forEach(function (x, i) {
      rows.push([i + 1, fmt.date(x.meeting.meet_date) || '', x.meeting.title || '',
                 x.meeting.location || '', statusText(x.status), x.reason || '', x.note || '',
                 x.updated_at ? fmt.dateTime(x.updated_at) : '']);
    });
    return rows;
  }

  /* 全体人员统计导出表 */
  function personSummaryRows(list) {
    var rows = [['序号', '工号', '姓名', '部门', '类别', '被邀请次数', '已参会', '已请假', '未确认', '出席率']];
    list.forEach(function (p, i) {
      rows.push([i + 1, p.emp_no || '', p.name, p.dept || '', p.category || '',
                 p.invited, p.attended, p.declined, p.pending, p.rate + '%']);
    });
    return rows;
  }

  function sheetName(title, date) {
    return String(title || '会议').slice(0, 28) + (date ? '_' + date : '');
  }

  return {
    nameKey: nameKey,
    rowsToRoster: rowsToRoster,
    buildAttendance: buildAttendance,
    sortRows: sortRows,
    statusText: statusText,
    meetingSheetRows: meetingSheetRows,
    summarySheetRows: summarySheetRows,
    rosterSheetRows: rosterSheetRows,
    buildPersonStats: buildPersonStats,
    personSheetRows: personSheetRows,
    personSummaryRows: personSummaryRows,
    sheetName: sheetName,
    setFormatters: setFormatters
  };
});
