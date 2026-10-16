/* ============================================================
 *  app.js —— 会议发布与参会确认系统 主程序
 *   一级网页（后台）：#/meetings  #/meeting/:id  #/new  #/edit/:id  #/roster  #/export
 *   二级网页（参会人）：#/s/:token     —— 发这个链接给别人填写
 * ============================================================ */
(function () {
  'use strict';

  var U = window.MSUtil, X = window.MSXlsx, QR = window.MSQR, DB = window.MSDB;
  var P = window.MSParser;
  var CFG = window.MS_CONFIG;

  /* 当前登录用的分类顺序（只影响显示顺序） */
  var CAT_ORDER = ['处长', '院长', '办公室主任', '党总支书记'];

  function q(id) { return document.getElementById(id); }
  function h(s) { return U.esc(s); }
  var toast = U.toast, confirmBox = U.confirmBox, promptBox = U.promptBox;

  /* ================= 全局状态 ================= */
  var S = {
    mode: 'cloud',                 // cloud | local
    ready: false,
    meetings: [], roster: [], responses: [],
    detailResponses: null,
    editing: null,                 // 正在编辑的会议（新建时为草稿对象）
    filter: 'all',
    keyword: '',
    rosterFilter: { kw: '', cat: '' },
    selectedRoster: {},
    selectedInvite: {},
    detailTab: 'att'
  };

  /* ================= 路由 ================= */
  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var qs = '';
    var qi = raw.indexOf('?');
    if (qi >= 0) { qs = raw.slice(qi + 1); raw = raw.slice(0, qi); }
    var params = {};
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? '' : kv.slice(i + 1);
      try { params[decodeURIComponent(k)] = decodeURIComponent(v); }
      catch (e) { params[k] = v; }
    });
    var parts = raw.split('/').filter(Boolean);
    return { name: parts[0] || 'meetings', arg: parts[1] || '', params: params };
  }

  function go(hash) {
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  }

  /* ================= 启动 ================= */
  function boot() {
    S.mode = DB.isCloud() ? 'cloud' : 'local';
    P.setFormatters({ date: U.fmtDate, dateWeek: U.fmtDateWeek, dateTime: U.fmtDateTime });

    function paint() { bindShell(); render(); }

    if (!DB.isCloud()) {
      // 未配置云端：直接以本机模式进入，界面顶部会一直挂一条提示横幅，
      // 想接云端时点横幅里的按钮看具体步骤（不再用"卡在配置页"的方式）。
      S.ready = true;
      S.mode = 'local';
      paint();
      return;
    }

    var secret = DB.getSecret();
    if (!secret) { S.ready = false; S.needSecret = true; paint(); return; }

    DB.ping().then(function () {
      S.ready = true; S.needSecret = false;
      return refreshAll().then(function (ok) {
        if (!ok) toast('数据加载失败，请检查网络后刷新页面', 'err');
      });
    }).catch(function (err) {
      S.ready = false;
      var m = String(err && err.message || err);
      if (m === 'ADMIN_SECRET_WRONG' || (err && err.code === 'ADMIN_SECRET_WRONG')) {
        DB.clearSecret(); S.needSecret = true; S.setupError = 'wrong';
      } else if (m === 'SCHEMA_MISSING' || (err && err.code === 'SCHEMA_MISSING')) {
        S.setupError = 'schema';
      } else if (/config\/config\.js/.test(m)) {
        S.setupError = 'config:' + m;
      } else {
        S.setupError = 'net:' + m;
      }
      paint();
    });
  }

  function refreshAll() {
    return Promise.all([DB.listMeetings(), DB.listRoster(), DB.listAllResponses()]).then(function (r) {
      S.meetings = r[0] || [];
      S.roster = r[1] || [];
      indexResponses(r[2] || []);
      return true;
    }).catch(function (e) {
      toast(String(e.message || e), 'err');
      return false;
    });
  }

  /* 把全部回执按 meeting_id 放进缓存，供看板统计 */
  function indexResponses(all) {
    S.responsesCache = {};
    (all || []).forEach(function (r) {
      (S.responsesCache[r.meeting_id] = S.responsesCache[r.meeting_id] || []).push(r);
    });
    return S.responsesCache;
  }

  /* ================= 侧边栏 / 顶栏交互 ================= */
  function bindShell() {
    var app = q('app');
    app.addEventListener('click', function (e) {
      var t = e.target.closest('[data-go]');
      if (t) { e.preventDefault(); go(t.getAttribute('data-go')); }
    });
  }

  function shell(active, title, actions, body) {
    var nav = [
      ['meetings', '📋', '会议看板', '#/meetings'],
      ['new', '➕', '发布会议', '#/new'],
      ['roster', '👥', '名单管理', '#/roster'],
      ['export', '📤', '导出统计', '#/export']
    ];
    var dotCls = S.mode === 'local' ? 'local' : (S.ready ? '' : 'bad');
    var dotTxt = S.mode === 'local' ? '本机模式（数据只存这台电脑）'
               : (S.ready ? '已连接云端数据库' : '云端未连接');
    return '' +
      '<div class="shell">' +
        '<aside class="side">' +
          '<div class="brand"><b>' + h(CFG.APP_NAME || '会议系统') + '</b>' +
            '<span>' + h(CFG.ORG_NAME || '') + '</span></div>' +
          '<nav>' + nav.map(function (n) {
            return '<a href="' + n[3] + '" class="' + (active === n[0] ? 'on' : '') + '">' +
                   '<span class="ico">' + n[1] + '</span>' + n[2] + '</a>';
          }).join('') + '</nav>' +
          '<div class="foot"><span class="dot ' + dotCls + '"></span>' + h(dotTxt) + '</div>' +
        '</aside>' +
        '<div class="main">' +
          '<div class="topbar"><h1>' + h(title) + '</h1><div class="sp"></div>' +
            (actions || '') + '</div>' +
          '<div class="content">' + body + '</div>' +
        '</div>' +
      '</div>';
  }

  /* ================= 主渲染 ================= */
  function render() {
    var r = parseHash();
    var app = q('app');

    if (r.name === 's') { app.innerHTML = viewShare(r.arg); afterShare(r.arg); return; }

    if (!S.ready) { app.innerHTML = viewGate(); afterGate(); return; }

    switch (r.name) {
      case 'meeting': app.innerHTML = viewDetail(r.arg); afterDetail(r.arg); break;
      case 'new':     app.innerHTML = viewForm(null); bindForm(null); break;
      case 'edit':    app.innerHTML = viewForm(r.arg); bindForm(r.arg); break;
      case 'roster':  app.innerHTML = viewRoster(); afterRoster(); break;
      case 'export':  app.innerHTML = viewExport(); afterExport(); break;
      default:        app.innerHTML = viewMeetings(); afterMeetings();
    }
  }

  /* ============================================================
   *  未就绪提示（未配置 / 口令缺失 / 表结构缺失）
   * ============================================================ */
  function viewGate() {
    if (S.mode === 'local') {
      return shell('meetings', '会议看板', '<button class="btn" id="gate-setup">☁ 接入云端数据库</button>',
        '<div class="notice warn">' + localNotice() + '</div>' +
        '<div class="card"><div class="empty"><span class="big">📋</span>' +
        '本机模式已就绪。可以先用左侧「发布会议」熟悉流程；<br>' +
        '要让别人扫码在自己手机上填报，请点右上角「接入云端数据库」。' +
        '</div></div>');
    }

    var setup = String(S.setupError || '');
    var cfgInfo = '';
    if (setup.indexOf('config:') === 0) {
      cfgInfo = '<div class="notice err"><b>config/config.js 里的参数不对。</b><br>' +
                h(setup.slice(7)) +
                '<br>正确写法：<code>SUPABASE_URL: \'https://你的项目名.supabase.co\',</code>' +
                '（只填域名，不要重复 https://，不要带 /rest/v1/）</div>';
    }
    var msg;
    if (setup === 'schema') {
      msg = '<div class="notice err"><b>数据库里还没有建表。</b><br>' +
            '请把 <code>supabase/01_schema.sql</code> 整段粘贴到 Supabase 的 SQL Editor 里执行一次，再刷新本页。</div>';
    } else if (setup.indexOf('config:') === 0) {
      msg = cfgInfo;
    } else if (setup === 'wrong' || S.needSecret || setup === '') {
      msg = '<div class="notice warn"><b>请输入后台口令。</b><br>' +
            '口令就是你在 SQL 里执行 <code>select public.set_admin_secret(\'...\');</code> 时设置的那个。' +
            '口令只保存在本机浏览器，不会写进网页源码。</div>';
    } else {
      msg = '<div class="notice err"><b>连接云端失败。</b><br>' +
            h(setup.replace(/^net:/, '')) +
            '<br><br>依次检查：① <code>config/config.js</code> 的 URL 和密钥；' +
            '② 把 URL 粘到浏览器新标签页能否打开；③ Supabase 项目是否被暂停（控制台会显示 Paused）。</div>';
    }
    return '<div class="content" style="max-width:560px;margin:0 auto;padding-top:64px">' +
      '<div class="card"><div class="card-h"><h2>' + h(CFG.APP_NAME || '会议系统') + '</h2></div>' +
      '<div class="card-b">' + msg +
      '<label class="f"><span class="lb">后台口令</span>' +
      '<input type="password" class="input" id="gate-secret" placeholder="请输入后台口令" autocomplete="current-password"></label>' +
      '<div class="btn-row"><button class="btn" id="gate-go">进入后台</button>' +
      '<button class="btn ghost" onclick="location.reload()">刷新</button>' +
      '<button class="btn ghost" id="gate-diag">查看配置详情</button></div>' +
      '</div></div></div>';
  }

  /* 配置体检面板：口令因为敏感不显示，URL 和密钥只显示可判断格式的信息 */
  function openConfigDiag() {
    var r = (DB.configCheck && DB.configCheck()) || {};
    var key = String(r.key || '');
    var rows = [
      ['config.js 里填的地址', r.urlRaw || '（空）'],
      ['程序实际使用的地址', r.url || '（无法识别）'],
      ['地址格式', r.urlOk ? '✅ 正常' : '❌ 不正确'],
      ['密钥长度', key ? key.length + ' 个字符' : '（空）'],
      ['密钥开头', key ? key.slice(0, 12) + '…' : '—'],
      ['密钥格式', r.keyOk ? '✅ 正常' : '❌ 不正确（应是以 eyJ 开头的完整 anon public 密钥）'],
      ['当前模式', S.mode === 'cloud' ? '云端' : '本机（未连云）']
    ];
    if (r.urlChanged) {
      rows.push(['提示', '已自动纠正地址格式（去掉了重复的 https:// 和 /rest/v1/）']);
    }
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal" style="max-width:620px">' +
      '<div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">配置体检</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      rows.map(function (x) {
        return '<tr><td style="padding:5px 8px;color:#475569;white-space:nowrap;vertical-align:top">' +
          h(x[0]) + '</td><td style="padding:5px 8px;word-break:break-all">' + h(x[1]) + '</td></tr>';
      }).join('') +
      '</table>' +
      '<div class="notice info" style="margin:14px 0 0">' +
      '地址正例：<code>https://abcdefghijk.supabase.co</code><br>' +
      '常见错误：写成 <code>https://https://xxx.supabase.co/rest/v1/</code>，' +
      '或少了 <code>https://</code>，或结尾多了斜杠。</div>' +
      '</div><div class="modal-foot"><button class="btn" data-x="0">关闭</button></div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      if (e.target.closest('[data-x]') || e.target === mask) mask.remove();
    });
  }

  function afterGate() {
    var diagBtn = q('gate-diag');
    if (diagBtn) diagBtn.addEventListener('click', openConfigDiag);
    var localBtn = q('gate-setup');
    if (localBtn) {
      localBtn.addEventListener('click', function () {
        var mask = document.createElement('div');
        mask.className = 'modal-mask';
        mask.innerHTML = '<div class="modal" style="max-width:620px">' +
          '<div class="modal-body" style="white-space:normal">' +
          '<div class="modal-title">接入云端数据库（约 15 分钟，免费）</div>' +
          '<ol style="padding-left:20px;line-height:1.9;margin:0">' +
          '<li>打开 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 注册并新建项目，' +
          '<b>Region 选 Singapore</b>（国内访问最快）</li>' +
          '<li>左侧 <b>SQL Editor</b> → New query → 把项目里 <code>supabase/01_schema.sql</code> ' +
          '<b>整段</b>粘进去执行（应显示 Success）</li>' +
          '<li>再新开一个 query，执行：<br><code>select public.set_admin_secret(\'你的后台口令\');</code><br>' +
          '执行完把这行删掉，别留明文口令</li>' +
          '<li>左侧 <b>Project Settings → Data API</b> 复制 <b>Project URL</b>；' +
          '到 <b>API Keys</b> 复制 <b>anon public</b> 密钥（<b>绝不能用 service_role</b>）</li>' +
          '<li>用记事本打开 <code>config/config.js</code>，把这两个值填进去并保存</li>' +
          '<li>刷新本页 —— 顶部横幅消失就说明连上了</li>' +
          '</ol>' +
          '<div class="notice info" style="margin:14px 0 0">本机模式里已经录入的会议和名单不会自动搬到云端，' +
          '接上云端后请重新导入名单、重新发布会议。</div>' +
          '</div><div class="modal-foot"><button class="btn" data-x="0">知道了</button></div></div>';
        document.body.appendChild(mask);
        mask.addEventListener('click', function (e) {
          if (e.target.closest('[data-x]') || e.target === mask) mask.remove();
        });
      });
    }
    var btn = q('gate-go'), inp = q('gate-secret');
    if (!btn) return;
    function submit() {
      var v = (inp.value || '').trim();
      if (!v) { toast('请输入口令', 'warn'); return; }
      DB.setSecret(v);
      btn.disabled = true; btn.textContent = '正在校验…';
      DB.ping().then(function () {
        toast('口令正确，已进入后台', 'ok');
        S.needSecret = false; S.ready = true; S.setupError = null;
        return refreshAll();
      }).then(function () {
        location.hash = '#/meetings'; render();
      }).catch(function (e) {
        var msg = String(e && e.message || e);
        // 只有真的是口令不对才清掉口令；网络/配置问题不要把用户的口令丢掉，
        // 否则会把「连不上」误报成「口令错误」，让人一直改口令。
        if (e && (e.code === 'ADMIN_SECRET_WRONG' || msg === 'ADMIN_SECRET_WRONG')) {
          DB.clearSecret();
          S.setupError = 'wrong'; S.ready = false;
          inp.value = '';
          render();
          toast('口令不正确，请重新输入', 'err');
        } else {
          S.ready = false;
          S.setupError = (e && e.code === 'SCHEMA_MISSING') ? 'schema'
                       : (/config\/config\.js/.test(msg) ? 'config:' + msg : 'net:' + msg);
          render();
          toast(msg, 'err');
        }
      }).then(function () { btn.disabled = false; });
    }
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    inp.focus();
  }

  function localNotice() {
    return '<b>当前是「本机模式」演示。</b>功能都能用，但数据只存在这台电脑的浏览器里：' +
           '别人用手机打开会议链接填不了你自己电脑上的数据，所以<strong>会议发布功能需要先接上云端数据库</strong>。';
  }

  /* ============================================================
   *  会议看板
   * ============================================================ */
  function statOf(m) {
    var att = buildAttendance(m, (S.responsesCache && S.responsesCache[m.id]) || []);
    return att.stats;
  }

  function viewMeetings() {
    var list = S.meetings.slice().sort(function (a, b) {
      var da = a.meet_date || '', db = b.meet_date || '';
      if (da !== db) return da < db ? 1 : -1;
      return String(b.created_at || '') < String(a.created_at || '') ? -1 : 1;
    });

    if (S.filter === 'upcoming') {
      var t = U.todayISO();
      list = list.filter(function (m) { return (m.meet_date || '') >= t; });
    } else if (S.filter === 'past') {
      var t2 = U.todayISO();
      list = list.filter(function (m) { return (m.meet_date || '') < t2; });
    }

    if (S.keyword) {
      var kw = S.keyword.toLowerCase();
      list = list.filter(function (m) {
        return (m.title || '').toLowerCase().indexOf(kw) >= 0 ||
               (m.location || '').toLowerCase().indexOf(kw) >= 0 ||
               (m.convene_dept || '').toLowerCase().indexOf(kw) >= 0;
      });
    }

    var cards = list.map(function (m) {
      var st = statOf(m);
      var inviteN = st.invited;
      var donePct = inviteN ? Math.round((st.answered) * 100 / inviteN) : 0;
      var closed = m.deadline && Date.now() > new Date(m.deadline).getTime();
      return '' +
        '<div class="mcard" data-go="#/meeting/' + h(m.id) + '">' +
          '<div class="row1">' +
            '<h3>' + h(m.title || '未命名会议') + '</h3>' +
            (closed ? '<span class="tag gray">已截止</span>' : '') +
          '</div>' +
          '<div class="meta">' +
            '<span>🗓 <b>' + h(U.fmtDateWeek(m.meet_date) || '未定日期') + '</b>' +
              (m.start_time ? ' ' + h(m.start_time) + (m.end_time ? '–' + h(m.end_time) : '') : '') + '</span>' +
            '<span>📍 ' + h(m.location || '地点待定') + '</span>' +
            (m.convene_dept ? '<span>🏛 ' + h(m.convene_dept) + '</span>' : '') +
          '</div>' +
          '<div class="bar" title="已确认 ' + st.yes + ' · 不参会 ' + st.no + ' · 待确认 ' + st.pending + '">' +
            '<i class="y" style="width:' + (inviteN ? (st.yes * 100 / inviteN) : 0) + '%"></i>' +
            '<i class="n" style="width:' + (inviteN ? (st.no * 100 / inviteN) : 0) + '%"></i>' +
          '</div>' +
          '<div class="nums">' +
            '<span>参会 <b style="color:#15803d">' + st.yes + '</b></span>' +
            '<span>不参会 <b style="color:#b91c1c">' + st.no + '</b></span>' +
            '<span>待确认 <b style="color:#b45309">' + st.pending + '</b></span>' +
            '<span class="mini" style="color:#94a3b8">回执率 ' + donePct + '%</span>' +
          '</div>' +
          '<div class="foot">' +
            '<span class="tag blue">受邀 ' + inviteN + ' 人</span>' +
            (st.outside ? '<span class="tag amber">名单外 ' + st.outside + '</span>' : '') +
            '<span class="sp"></span>' +
            '<button class="btn ghost sm" data-copy="' + h(shareUrl(m.share_token)) + '">复制链接</button>' +
          '</div>' +
        '</div>';
    }).join('');

    var total = S.meetings.length;
    return shell('meetings', '会议看板',
      '<input class="input" style="width:210px" id="mkw" placeholder="搜索会议名称/地点" value="' + h(S.keyword) + '">' +
      '<button class="btn" data-go="#/new">＋ 发布会议</button>',
      (S.mode === 'local' ? '<div class="notice warn">' + localNotice() + '</div>' : '') +
      '<div class="btn-row" style="margin-bottom:16px">' +
        ['all:全部', 'upcoming:未召开', 'past:已结束'].map(function (x) {
          var k = x.split(':')[0], v = x.split(':')[1];
          return '<button class="btn ' + (S.filter === k ? '' : 'ghost') + ' sm" data-filter="' + k + '">' + v + '</button>';
        }).join('') +
        '<span class="hint" style="margin-left:6px">共 ' + total + ' 场会议</span>' +
      '</div>' +
      (list.length
        ? '<div class="grid c2">' + cards + '</div>'
        : '<div class="card"><div class="empty"><span class="big">📋</span>' +
          (total ? '没有符合条件的会议' : '还没有会议，点右上角「＋ 发布会议」开始') +
          '</div></div>')
    );
  }

  function afterMeetings() {
    var kw = q('mkw');
    if (kw) {
      kw.addEventListener('input', function () {
        var pos = kw.selectionStart;
        S.keyword = kw.value.trim();
        render();
        restoreCaret('mkw', pos);
      });
    }
    document.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () { S.filter = b.getAttribute('data-filter'); render(); });
    });
    bindCopyButtons();
  }

  function bindCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        copyText(b.getAttribute('data-copy')).then(function () { toast('链接已复制', 'ok'); });
      });
    });
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(function () { return fallbackCopy(t); });
    }
    return Promise.resolve(fallbackCopy(t));
  }

  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function shareUrl(token) {
    var base = location.href.split('#')[0];
    return base + '#/s/' + token;
  }

  /* ============================================================
   *  参会情况汇总（受邀名单 × 回执）—— 实际逻辑在 parser.js
   * ============================================================ */
  var buildAttendance = P.buildAttendance;
  var sortAttRows = P.sortRows;

  function statusTag(st) {
    if (st === 'yes') return '<span class="tag green">参加</span>';
    if (st === 'no') return '<span class="tag red">不参加</span>';
    return '<span class="tag amber">待确认</span>';
  }

  function progressBar(st) {
    var n = st.invited || 1;
    return '<div class="bar" style="margin:10px 0 4px">' +
      '<i class="y" style="width:' + (st.yes * 100 / n) + '%"></i>' +
      '<i class="n" style="width:' + (st.no * 100 / n) + '%"></i></div>';
  }

  /* ============================================================
   *  会议详情
   * ============================================================ */
  function viewDetail(id) {
    var m = S.meetings.filter(function (x) { return x.id === id; })[0];
    if (!m) {
      return shell('meetings', '会议详情',
        '<button class="btn ghost" data-go="#/meetings">返回看板</button>',
        '<div class="card"><div class="empty"><span class="big">🔍</span>找不到这场会议，可能已被删除</div></div>');
    }
    window.__curMeeting = m;
    // 先用手头已有的回执渲染，再向云端拉一次最新的
    S.detailResponses = (S.responsesCache && S.responsesCache[m.id]) || [];
    var att = buildAttendance(m, S.detailResponses);
    var st = att.stats;
    var rows = sortAttRows(att.rows);

    var closed = m.deadline && Date.now() > new Date(m.deadline).getTime();
    var url = shareUrl(m.share_token);

    var info =
      '<div class="kv-list">' +
        kv('会议时间', (U.fmtDateWeek(m.meet_date) || '未定') +
           (m.start_time ? '<br>' + h(m.start_time) + (m.end_time ? '–' + h(m.end_time) : '') : '')) +
        kv('会议地点', m.location || '待定') +
        kv('主办/召集', m.convene_dept || '—') +
        kv('主持人', m.host || '—') +
        kv('联系人', m.contact || '—') +
        kv('填报截止', m.deadline ? U.fmtDateTime(m.deadline) + (closed ? '（已截止）' : '') : '不限') +
      '</div>' +
      (m.agenda ? '<div style="margin-top:16px"><div class="kv"><div class="k">议程 / 说明</div>' +
        '<div class="v">' + U.escLines(m.agenda) + '</div></div></div>' : '');

    var visible = rows.filter(function (r) {
      if (S.detailTab === 'yes') return r.status === 'yes';
      if (S.detailTab === 'no') return r.status === 'no';
      if (S.detailTab === 'pending') return r.status === 'pending';
      return true;
    });

    var body =
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn ghost sm" data-go="#/meetings">← 返回看板</button>' +
        '<button class="btn ghost sm" data-go="#/edit/' + h(m.id) + '">✎ 编辑会议</button>' +
        '<button class="btn ghost sm" id="d-refresh">⟳ 刷新回执</button>' +
        '<button class="btn ghost sm" id="d-export">⤓ 导出本场</button>' +
        '<span class="sp" style="flex:1"></span>' +
        '<button class="btn danger sm" id="d-del">删除会议</button>' +
      '</div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>' + h(m.title) + '</h2>' +
        (closed ? '<span class="tag gray">已截止</span>' : '<span class="tag green">填报中</span>') +
      '</div><div class="card-b">' + info + '</div></div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>参会链接（发这个给别人填写）</h2></div>' +
      '<div class="card-b">' +
        '<div class="linkbox">' +
          '<input class="input" readonly value="' + h(url) + '" id="d-url">' +
          '<button class="btn" id="d-copy">复制链接</button>' +
          '<button class="btn ghost" id="d-qr">显示二维码</button>' +
        '</div>' +
        '<div id="d-qr-box" style="display:none;margin-top:14px">' +
          '<img class="qr-img" id="d-qr-img" alt="会议二维码">' +
          '<div class="hint">手机上长按或截图保存，发到微信群里最方便。</div>' +
        '</div>' +
        '<div class="hint">受邀 ' + st.invited + ' 人。别人打开链接后填写姓名并选择是否参会，' +
        '结果会自动回到本页（本页每 ' + Math.round((CFG.AUTO_REFRESH_MS || 30000) / 1000) + ' 秒自动刷新一次）。</div>' +
        (st.pending ? '<div class="btn-row" style="margin-top:12px">' +
          '<button class="btn ghost sm" data-copy="' + h(remindText(m, att, url)) + '">复制催办文本（待确认 ' +
          st.pending + ' 人）</button>' +
          '<span class="hint">可直接粘到微信群里，无需再手打名单</span></div>' : '') +
      '</div></div>' +

      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + st.invited + '</div><div class="t">受邀人数</div></div>' +
        '<div class="stat green"><div class="n">' + st.yes + '</div><div class="t">确认参会</div></div>' +
        '<div class="stat red"><div class="n">' + st.no + '</div><div class="t">确认不参会</div></div>' +
        '<div class="stat amber"><div class="n">' + st.pending + '</div><div class="t">尚未确认</div></div>' +
      '</div>' +

      '<div class="card"><div class="card-h"><h2>参会人员情况</h2>' +
        '<div class="sp" style="flex:1"></div>' +
        [['att', '全部'], ['yes', '已确认参会'], ['no', '不参会'], ['pending', '待确认']].map(function (t) {
          return '<button class="btn ' + (S.detailTab === t[0] ? '' : 'ghost') + ' sm" data-tab="' + t[0] + '">' +
                 t[1] + (t[0] === 'att' ? ' ' + rows.length : '') + '</button>';
        }).join('') +
      '</div>' +
      progressBar(st) +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>#</th><th>姓名</th><th>类别</th><th>部门</th><th>是否参会</th>' +
        '<th>不参会原因</th><th>备注</th><th>回执时间</th>' +
      '</tr></thead><tbody>' +
        (visible.length ? visible.map(function (r, i) {
          return '<tr>' +
            '<td class="ctr mini">' + (i + 1) + '</td>' +
            '<td class="name">' + h(r.name) + (r.on_list ? '' : ' <span class="tag amber">名单外</span>') + '</td>' +
            '<td>' + h(r.category || '—') + '</td>' +
            '<td>' + h(r.dept || '—') + '</td>' +
            '<td>' + statusTag(r.status) + '</td>' +
            '<td>' + (r.reason ? h(r.reason) : '<span class="mini">—</span>') + '</td>' +
            '<td>' + (r.note ? h(r.note) : '<span class="mini">—</span>') + '</td>' +
            '<td class="mini">' + (r.updated_at ? U.fmtDateTime(r.updated_at) : '—') + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="8"><div class="empty">这个分类下暂时没有人</div></td></tr>') +
      '</tbody></table></div>' +
      '</div>';

    return shell('meetings', '会议详情', '', body);
  }

  function kv(k, v) {
    return '<div class="kv"><div class="k">' + h(k) + '</div><div class="v">' + (v || '—') + '</div></div>';
  }

  /* 生成一段可以直接粘到群里的催办文本（已确认的人不再列出） */
  function remindText(m, att, url) {
    var pending = att.rows.filter(function (r) { return r.status === 'pending'; });
    var lines = [];
    lines.push('【参会确认提醒】' + (m.title || ''));
    if (m.meet_date) {
      lines.push('时间：' + U.fmtDateWeek(m.meet_date) +
                 (m.start_time ? ' ' + m.start_time + (m.end_time ? '–' + m.end_time : '') : ''));
    }
    if (m.location) lines.push('地点：' + m.location);
    if (m.deadline) lines.push('请于 ' + U.fmtDateTime(m.deadline) + ' 前确认');
    lines.push('');
    lines.push('以下 ' + pending.length + ' 位尚未确认，请点击链接填写：');
    lines.push(pending.map(function (r) { return r.name; }).join('、'));
    lines.push('');
    lines.push('确认链接：' + url);
    return lines.join('\n');
  }

  function afterDetail(id) {
    var m = window.__curMeeting;
    if (!m) return;
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { S.detailTab = b.getAttribute('data-tab'); render(); });
    });
    var cp = q('d-copy');
    if (cp) cp.addEventListener('click', function () {
      copyText(q('d-url').value).then(function () { toast('链接已复制，可以发给参会人员了', 'ok'); });
    });
    var qb = q('d-qr');
    if (qb) qb.addEventListener('click', function () {
      var box = q('d-qr-box');
      if (box.style.display === 'none') {
        try { q('d-qr-img').src = QR.toPngDataUrl(q('d-url').value, 5); }
        catch (e) { toast('二维码生成失败：' + e.message, 'err'); return; }
        box.style.display = 'block';
      } else { box.style.display = 'none'; }
    });
    var rf = q('d-refresh');
    if (rf) rf.addEventListener('click', function () {
      rf.disabled = true; rf.textContent = '正在刷新…';
      DB.listResponses(id).then(function (rs) {
        S.detailResponses = rs || [];
        toast('已刷新，共收到 ' + S.detailResponses.length + ' 条回执', 'ok');
        render();
      }).catch(function (e) { toast(String(e.message || e), 'err'); rf.disabled = false; });
    });
    var ex = q('d-export');
    if (ex) ex.addEventListener('click', function () { exportMeeting(m, S.detailResponses || []); });
    var dl = q('d-del');
    if (dl) dl.addEventListener('click', function () {
      confirmBox('确定删除会议「' + m.title + '」？\n该会议的 ' + (S.detailResponses || []).length +
                 ' 条回执会一并删除，且无法恢复。').then(function (ok) {
        if (!ok) return;
        DB.deleteMeeting(m.id).then(function () {
          toast('会议已删除', 'ok');
          S.meetings = S.meetings.filter(function (x) { return x.id !== m.id; });
          go('#/meetings');
        }).catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    // 复制按钮（会议链接、催办文本）
    bindCopyButtons();

    // 用缓存先渲染，再向云端拉一次最新的
    loadDetailResponses(id, true);
    if (window.__detailTimer) clearInterval(window.__detailTimer);
    if (S.mode === 'cloud') {
      window.__detailTimer = setInterval(function () {
        var r = parseHash();
        if (r.name !== 'meeting' || r.arg !== id) { clearInterval(window.__detailTimer); return; }
        loadDetailResponses(id, false);
      }, Math.max(10000, CFG.AUTO_REFRESH_MS || 30000));
    }
  }

  function loadDetailResponses(id, first) {
    DB.listResponses(id).then(function (rs) {
      var beforeKeys = (S.detailResponses || []).map(function (r) { return r.name_key; }).sort().join(',');
      S.detailResponses = rs || [];
      if (S.responsesCache) S.responsesCache[id] = S.detailResponses;
      var afterKeys = S.detailResponses.map(function (r) { return r.name_key; }).sort().join(',');
      if (afterKeys !== beforeKeys) {
        if (!first) toast('收到新回执，已更新（共 ' + S.detailResponses.length + ' 条）', 'ok');
        render();
      }
    }).catch(function (e) {
      if (first) toast('读取回执失败：' + String(e.message || e), 'err');
    });
  }

  /* ============================================================
   *  发布 / 编辑会议
   * ============================================================ */
  function viewForm(editId) {
    var isEdit = !!editId;
    var m = isEdit ? S.meetings.filter(function (x) { return x.id === editId; })[0] : null;
    if (isEdit && !m) return shell('meetings', '编辑会议', '', '<div class="notice err">找不到该会议</div>');

    var draft = m || {
      title: '', meet_date: U.todayISO(), start_time: '09:00', end_time: '11:00',
      location: '', convene_dept: '', host: '', contact: '', agenda: '',
      ask_reason: true, ask_note: true, deadline: '', invite: []
    };
    S.editing = draft;

    // 勾选状态：编辑时按现有参会人回填
    S.selectedInvite = {};
    (draft.invite || []).forEach(function (p) { S.selectedInvite[inviteKey(p)] = true; });

    var cats = availableCategories();
    var catAll = cats.map(function (c) {
      var total = rosterByCat(c).length;
      return '<label class="cat-chip" data-cat="' + h(c) + '">' +
             '<input type="checkbox" data-catbox="' + h(c) + '"> ' + h(c) +
             ' <span class="mini">(' + total + ')</span></label>';
    }).join('');

    var body =
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn ghost sm" data-go="#/meetings">← 返回看板</button>' +
      '</div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>' +
        (isEdit ? '编辑会议' : '发布新会议') + '</h2></div><div class="card-b">' +
        '<label class="f"><span class="lb">会议名称 <span class="req">*</span></span>' +
          '<input class="input" id="f-title" value="' + h(draft.title) + '" placeholder="如：2026年春季学期中层干部会议"></label>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">' +
          '<label class="f"><span class="lb">会议日期</span><input type="date" class="input" id="f-date" value="' + h(draft.meet_date || '') + '"></label>' +
          '<label class="f"><span class="lb">开始时间</span><input type="time" class="input" id="f-start" value="' + h(draft.start_time || '') + '"></label>' +
          '<label class="f"><span class="lb">结束时间</span><input type="time" class="input" id="f-end" value="' + h(draft.end_time || '') + '"></label>' +
          '<label class="f"><span class="lb">会议地点</span><input class="input" id="f-loc" value="' + h(draft.location) + '" placeholder="如：行政楼三楼会议室"></label>' +
          '<label class="f"><span class="lb">主办 / 召集部门</span><input class="input" id="f-dept" value="' + h(draft.convene_dept) + '" placeholder="如：党委工作部"></label>' +
          '<label class="f"><span class="lb">主持人</span><input class="input" id="f-host" value="' + h(draft.host) + '"></label>' +
          '<label class="f"><span class="lb">联系人及电话</span><input class="input" id="f-contact" value="' + h(draft.contact) + '" placeholder="如：郭老师 13800000000"></label>' +
          '<label class="f"><span class="lb">填报截止时间</span><input type="datetime-local" class="input" id="f-deadline" value="' + h(U.toLocalInput(draft.deadline)) + '">' +
            '<span class="hint">留空表示不限制</span></label>' +
        '</div>' +
        '<label class="f"><span class="lb">会议议程 / 说明</span>' +
          '<textarea class="input" id="f-agenda" placeholder="可直接粘贴会议议程、参会要求、注意事项等">' + h(draft.agenda) + '</textarea></label>' +
        '<label class="f" style="display:flex;gap:22px;flex-wrap:wrap">' +
          '<span><input type="checkbox" id="f-ask-reason" ' + (draft.ask_reason !== false ? 'checked' : '') + '> 二级网页收集「不参会原因」</span>' +
          '<span><input type="checkbox" id="f-ask-note" ' + (draft.ask_note !== false ? 'checked' : '') + '> 二级网页收集「备注」</span>' +
        '</label>' +
      '</div></div>' +

      '<div class="card"><div class="card-h"><h2>选择参会人员</h2>' +
        '<span class="sp" style="flex:1"></span>' +
        '<span class="tag blue" id="f-count">已选 0 人</span>' +
      '</div><div class="card-b">' +
        '<div class="cat-chips" style="margin-bottom:12px" id="f-cats">' +
          '<button class="btn ghost sm" id="f-cat-all">全选所有类别</button>' +
          '<button class="btn ghost sm" id="f-cat-none">清空</button>' +
          catAll +
        '</div>' +
        '<input class="input" id="f-psearch" placeholder="搜索姓名 / 部门，快速单独勾选" style="margin-bottom:9px">' +
        '<div class="person-list" id="f-plist"></div>' +
        '<div class="hint">按类别勾选是「整类加入」，也可以在上面搜索框里单独挑选人员。' +
        '已选好的人员名单会以快照方式存进本场会议 —— 以后修改总名单不会影响这场会议。</div>' +
      '</div></div>' +

      '<div class="btn-row" style="margin-top:18px">' +
        '<button class="btn lg" id="f-save">' + (isEdit ? '保存修改' : '发布会议并生成链接') + '</button>' +
        '<button class="btn ghost lg" data-go="#/meetings">取消</button>' +
      '</div>';

    return shell('new', isEdit ? '编辑会议' : '发布会议', '', body);
  }

  /* 勾选键必须带「类别」：同一个人在同一部门可能有两种身份（如白建侠既是
     数学教学部的办公室主任又是院长），必须能分别勾选，否则"全选"会少算人。 */
  function inviteKey(p) {
    return U.nameKey(p.name) + '@@' + (p.dept || '') + '@@' + (p.category || '');
  }

  function availableCategories() {
    var set = [];
    S.roster.forEach(function (p) {
      if (p.category && set.indexOf(p.category) < 0) set.push(p.category);
    });
    set.sort(function (a, b) {
      var ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
      if (ia < 0) ia = 99; if (ib < 0) ib = 99;
      return ia - ib || a.localeCompare(b);
    });
    return set;
  }

  function rosterByCat(cat) {
    return S.roster.filter(function (p) { return p.category === cat && p.active !== false; })
      .sort(function (a, b) { return (a.dept || '').localeCompare(b.dept || '', 'zh'); });
  }

  /* 重绘后把光标放回原来的位置，避免搜索框输入时跳到末尾 */
  function restoreCaret(id, pos) {
    var el = q(id);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (e) { /* 某些输入类型不支持 */ }
  }

  function bindForm(editId) {
    var isEdit = !!editId;

    // 人员清单渲染
    function renderPeople() {
      var kw = (q('f-psearch') && q('f-psearch').value || '').trim().toLowerCase();
      var cats = availableCategories();
      function match(p) {
        if (!kw) return true;
        return (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
               (p.dept || '').toLowerCase().indexOf(kw) >= 0;
      }
      function personRow(p) {
        var k = inviteKey(p);
        var on = !!S.selectedInvite[k];
        return '<label class="p ' + (on ? 'on' : '') + '" data-pk="' + h(k) + '">' +
          '<input type="checkbox" ' + (on ? 'checked' : '') + ' data-pbox="' + h(k) + '">' +
          '<span class="nm">' + h(p.name) + '</span>' +
          '<span class="dp">' + h(p.dept || '（部门未填）') + '</span>' +
        '</label>';
      }
      var html = cats.map(function (cat) {
        var list = rosterByCat(cat).filter(match);
        if (!list.length) return '';
        return '<div class="grp">' + h(cat) + '　<span class="mini">' + list.length + ' 人</span></div>' +
          list.map(personRow).join('');
      }).join('');

      // 没填类别（或类别为空）的人也要能被选中，否则他们会从列表里"消失"
      var other = S.roster.filter(function (p) {
        return p.active !== false && (!p.category || cats.indexOf(p.category) < 0);
      }).filter(match);
      if (other.length) {
        html += '<div class="grp">未分类　<span class="mini">' + other.length + ' 人</span></div>' +
          other.map(personRow).join('');
      }
      q('f-plist').innerHTML = html || '<div class="empty">名单是空的，请先到「名单管理」导入人员</div>';

      // 更新类别 chip 的全选态（用遍历而不是拼选择器，避免类别名里的特殊字符破坏选择器）
      var catBoxes = document.querySelectorAll('[data-catbox]');
      availableCategories().forEach(function (cat) {
        var all = rosterByCat(cat);
        var box = null;
        for (var i = 0; i < catBoxes.length; i++) {
          if (catBoxes[i].getAttribute('data-catbox') === cat) { box = catBoxes[i]; break; }
        }
        if (!box) return;
        var selN = all.filter(function (p) { return S.selectedInvite[inviteKey(p)]; }).length;
        box.checked = all.length > 0 && selN === all.length;
        box.indeterminate = selN > 0 && selN < all.length;
        var chip = box.closest('.cat-chip');
        if (chip) chip.classList.toggle('on', selN > 0);
      });

      var n = Object.keys(S.selectedInvite).filter(function (k) { return S.selectedInvite[k]; }).length;
      var c = q('f-count');
      if (c) c.textContent = '已选 ' + n + ' 人';
    }
    window.__renderPeople = renderPeople;

    q('f-plist').addEventListener('change', function (e) {
      var box = e.target.closest('[data-pbox]');
      if (!box) return;
      S.selectedInvite[box.getAttribute('data-pbox')] = box.checked;
      renderPeople();
    });
    q('f-psearch').addEventListener('input', function () {
      var pos = q('f-psearch').selectionStart;
      renderPeople();
      restoreCaret('f-psearch', pos);
    });

    q('f-cats').addEventListener('change', function (e) {
      var box = e.target.closest('[data-catbox]');
      if (!box) return;
      var cat = box.getAttribute('data-catbox');
      rosterByCat(cat).forEach(function (p) { S.selectedInvite[inviteKey(p)] = box.checked; });
      renderPeople();
    });
    q('f-cat-all').addEventListener('click', function () {
      S.roster.forEach(function (p) { if (p.active !== false) S.selectedInvite[inviteKey(p)] = true; });
      renderPeople();
    });
    q('f-cat-none').addEventListener('click', function () {
      S.selectedInvite = {};
      renderPeople();
    });

    q('f-save').addEventListener('click', function () { saveMeeting(isEdit, editId); });
    renderPeople();
  }

  /* 把表单里的值先收集成一个快照：这样即使随后用户又点了别处（当前页面被换掉），
     确认框点"确定"之后仍然能拿到正确的数据，不会因为查不到 DOM 而报错。 */
  function collectForm() {
    return {
      title: (q('f-title') && q('f-title').value || '').trim(),
      meet_date: (q('f-date') && q('f-date').value) || null,
      start_time: (q('f-start') && q('f-start').value) || '',
      end_time: (q('f-end') && q('f-end').value) || '',
      location: ((q('f-loc') && q('f-loc').value) || '').trim(),
      convene_dept: ((q('f-dept') && q('f-dept').value) || '').trim(),
      host: ((q('f-host') && q('f-host').value) || '').trim(),
      contact: ((q('f-contact') && q('f-contact').value) || '').trim(),
      agenda: (q('f-agenda') && q('f-agenda').value) || '',
      ask_reason: !!(q('f-ask-reason') && q('f-ask-reason').checked),
      ask_note: !!(q('f-ask-note') && q('f-ask-note').checked),
      deadline: U.fromLocalInput(q('f-deadline') ? q('f-deadline').value : '')
    };
  }

  function saveMeeting(isEdit, editId) {
    var data = collectForm();
    if (!data.title) { toast('请填写会议名称', 'warn'); q('f-title').focus(); return; }

    var invite = S.roster.filter(function (p) {
      return p.active !== false && S.selectedInvite[inviteKey(p)];
    }).map(function (p) {
      return { name: p.name, dept: p.dept || '', category: p.category || '', rid: p.id };
    });
    if (!invite.length) { toast('请至少选择 1 名参会人员', 'warn'); return; }
    data.invite = invite;

    // 编辑时提醒：原来选中、但已经从名单里被删掉的人会一并移除
    var lost = [];
    if (isEdit) {
      var old = S.meetings.filter(function (x) { return x.id === editId; })[0];
      var nowKeys = {};
      invite.forEach(function (p) { nowKeys[U.nameKey(p.name)] = 1; });
      ((old && old.invite) || []).forEach(function (p) {
        if (!nowKeys[U.nameKey(p.name)]) lost.push(p.name);
      });
    }
    if (lost.length) {
      confirmBox('有 ' + lost.length + ' 位原来的参会人已不在当前名单中，保存后会被移出本场会议：\n\n' +
                 lost.slice(0, 12).join('、') + (lost.length > 12 ? ' 等' : '') +
                 '\n\n确定继续保存？').then(function (ok) {
        if (ok) doSave(isEdit, editId, data);
      });
      return;
    }
    doSave(isEdit, editId, data);
  }

  function doSave(isEdit, editId, payload) {
    var btn = q('f-save');
    if (btn) { btn.disabled = true; btn.textContent = '正在保存…'; }

    var p = isEdit ? DB.updateMeeting(editId, payload) : DB.createMeeting(payload);
    p.then(function (row) {
      var saved = row && row.id ? row : Object.assign({}, payload, { id: editId });
      return refreshAll().then(function () { return saved; });
    }).then(function (saved) {
      toast(isEdit ? '会议已保存' : '会议已发布', 'ok');
      if (!isEdit) S.detailResponses = [];
      go('#/meeting/' + ((saved && saved.id) || editId));
    }).catch(function (e) {
      toast('保存失败：' + String(e.message || e), 'err');
      if (btn) { btn.disabled = false; btn.textContent = isEdit ? '保存修改' : '发布会议并生成链接'; }
    });
  }

  /* ============================================================
   *  名单管理
   * ============================================================ */
  function viewRoster() {
    var f = S.rosterFilter;
    var list = S.roster.slice().sort(function (a, b) {
      return (a.sort_no || 0) - (b.sort_no || 0) || (a.dept || '').localeCompare(b.dept || '');
    }).filter(function (p) {
      if (f.cat && p.category !== f.cat) return false;
      if (f.kw) {
        var k = f.kw.toLowerCase();
        if ((p.name || '').toLowerCase().indexOf(k) < 0 &&
            (p.dept || '').toLowerCase().indexOf(k) < 0) return false;
      }
      return true;
    });

    var cats = availableCategories();
    var selectedN = Object.keys(S.selectedRoster).filter(function (k) { return S.selectedRoster[k]; }).length;

    var rows = list.map(function (p, i) {
      var on = !!S.selectedRoster[p.id];
      return '<tr>' +
        '<td class="ctr"><input type="checkbox" data-rsel="' + h(p.id) + '" ' + (on ? 'checked' : '') + '></td>' +
        '<td class="ctr mini">' + (i + 1) + '</td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px" data-rf="dept" data-rid="' + h(p.id) + '" value="' + h(p.dept) + '"></td>' +
        '<td><select class="input" style="padding:4px 7px;font-size:13px" data-rf="category" data-rid="' + h(p.id) + '">' +
          cats.map(function (c) {
            return '<option value="' + h(c) + '"' + (c === p.category ? ' selected' : '') + '>' + h(c) + '</option>';
          }).join('') +
          (cats.indexOf(p.category) < 0 && p.category ? '<option value="' + h(p.category) + '" selected>' + h(p.category) + '</option>' : '') +
        '</select></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px;font-weight:600" data-rf="name" data-rid="' + h(p.id) + '" value="' + h(p.name) + '"></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px" data-rf="phone" data-rid="' + h(p.id) + '" value="' + h(p.phone || '') + '"></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px" data-rf="note" data-rid="' + h(p.id) + '" value="' + h(p.note || '') + '"></td>' +
        '<td class="ctr"><button class="btn ghost sm" data-rdel="' + h(p.id) + '">删除</button></td>' +
      '</tr>';
    }).join('');

    var body =
      (S.mode === 'local' ? '<div class="notice warn">' + localNotice() + '</div>' : '') +
      '<div class="card" style="margin-bottom:14px"><div class="card-h">' +
        '<h2>人员名单（' + S.roster.length + ' 人）</h2>' +
        '<div class="sp" style="flex:1"></div>' +
        '<button class="btn sm" id="r-add">＋ 新增一人</button>' +
        '<button class="btn ghost sm" id="r-import">⤒ 从 Excel 导入</button>' +
        '<button class="btn ghost sm" id="r-template">⤓ 下载导入模板</button>' +
        '<button class="btn ghost sm" id="r-export">⤓ 导出当前名单</button>' +
        '<button class="btn ghost sm" id="r-seed">写入初始 55 人名单</button>' +
        '<input type="file" id="r-file" accept=".xlsx,.csv" style="display:none">' +
      '</div>' +
      '<div class="card-b" style="border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<input class="input" id="r-kw" style="width:230px" placeholder="搜索姓名 / 部门" value="' + h(f.kw) + '">' +
        '<select class="input" id="r-cat" style="width:170px"><option value="">全部类别</option>' +
          cats.map(function (c) {
            return '<option value="' + h(c) + '"' + (f.cat === c ? ' selected' : '') + '>' + h(c) + '</option>';
          }).join('') + '</select>' +
        '<span class="hint">表格里可以直接改，改完自动保存</span>' +
        '<div class="sp" style="flex:1"></div>' +
        (selectedN ? '<button class="btn danger sm" id="r-del-sel">删除选中 ' + selectedN + ' 人</button>' : '') +
      '</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th style="width:34px"></th><th>#</th><th>部门</th><th>类别</th><th>姓名</th><th>手机号</th><th>备注</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="8"><div class="empty"><span class="big">👥</span>名单是空的，点右上角「从 Excel 导入」或「写入初始 55 人名单」</div></td></tr>') +
      '</tbody></table></div></div>';

    return shell('roster', '名单管理', '', body);
  }

  function afterRoster() {
    var kw = q('r-kw');
    if (kw) kw.addEventListener('input', function () {
      var pos = kw.selectionStart;
      S.rosterFilter.kw = kw.value.trim();
      render();
      restoreCaret('r-kw', pos);
    });
    var cs = q('r-cat');
    if (cs) cs.addEventListener('change', function () { S.rosterFilter.cat = cs.value; render(); });

    document.querySelectorAll('[data-rsel]').forEach(function (b) {
      b.addEventListener('change', function () {
        S.selectedRoster[b.getAttribute('data-rsel')] = b.checked;
        render();
      });
    });

    // 单元格编辑（失焦保存）
    document.querySelectorAll('[data-rf]').forEach(function (inp) {
      var old = inp.value;
      inp.addEventListener('blur', function () {
        var v = inp.value;
        if (v === old) return;
        var id = inp.getAttribute('data-rid'), field = inp.getAttribute('data-rf');
        var patch = {};
        patch[field] = v.trim();
        DB.updateRoster(id, patch).then(function () {
          S.roster.forEach(function (p) { if (p.id === id) p[field] = v.trim(); });
          toast('已保存', 'ok');
        }).catch(function (e) {
          toast('保存失败：' + String(e.message || e), 'err');
          inp.value = old;
        });
      });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
    });

    document.querySelectorAll('[data-rdel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-rdel');
        var p = S.roster.filter(function (x) { return x.id === id; })[0];
        confirmBox('确定从名单中删除「' + (p ? p.name : '') + '」？\n（不影响已发布的会议）').then(function (ok) {
          if (!ok) return;
          DB.deleteRoster([id]).then(function () {
            S.roster = S.roster.filter(function (x) { return x.id !== id; });
            toast('已删除', 'ok'); render();
          }).catch(function (e) { toast(String(e.message || e), 'err'); });
        });
      });
    });

    var ds = q('r-del-sel');
    if (ds) ds.addEventListener('click', function () {
      var ids = Object.keys(S.selectedRoster).filter(function (k) { return S.selectedRoster[k]; });
      confirmBox('确定删除选中的 ' + ids.length + ' 人？').then(function (ok) {
        if (!ok) return;
        DB.deleteRoster(ids).then(function () {
          S.roster = S.roster.filter(function (x) { return ids.indexOf(x.id) < 0; });
          S.selectedRoster = {};
          toast('已删除 ' + ids.length + ' 人', 'ok'); render();
        }).catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    var add = q('r-add');
    if (add) add.addEventListener('click', function () {
      var cats = availableCategories();
      // 默认姓名要唯一，否则连点两次会因为「部门+类别+姓名」相同而互相覆盖
      var used = {};
      S.roster.forEach(function (p) { used[p.name] = 1; });
      var nm = '新人员', i = 2;
      while (used[nm]) { nm = '新人员' + i; i++; }
      var maxSort = S.roster.reduce(function (m, p) { return Math.max(m, p.sort_no || 0); }, 0);
      DB.insertRoster([{
        dept: '', category: cats[0] || '处长', name: nm,
        phone: '', note: '', sort_no: maxSort + 1
      }]).then(function () {
        return refreshAll();
      }).then(function () { toast('已新增，请在表格里修改信息', 'ok'); render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });

    var seed = q('r-seed');
    if (seed) seed.addEventListener('click', function () {
      var rows = (window.SEED_ROSTER || []).slice();
      if (!rows.length) { toast('初始名单数据缺失（config/seed.js）', 'err'); return; }
      confirmBox('将把初始 ' + rows.length + ' 人写入名单。\n' +
                 '同名同部门的人会自动更新，不会重复。继续？').then(function (ok) {
        if (!ok) return;
        seed.disabled = true; seed.textContent = '正在写入…';
        DB.insertRoster(rows).then(function () { return refreshAll(); })
          .then(function () { toast('已写入 ' + rows.length + ' 人', 'ok'); render(); })
          .catch(function (e) { toast('写入失败：' + String(e.message || e), 'err'); seed.disabled = false; });
      });
    });

    var imp = q('r-import'), file = q('r-file');
    if (imp) imp.addEventListener('click', function () { file.click(); });
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      importRosterFile(f).then(function (rows) {
        if (!rows.length) { toast('没有解析到有效数据', 'warn'); return; }
        // 同一个「部门+类别+姓名」在同一批里只能出现一次，否则数据库会因唯一键冲突而整批失败
        var seen = {}, uniq = [];
        rows.forEach(function (r) {
          var k = (r.dept || '') + '@@' + (r.category || '') + '@@' + r.name;
          if (seen[k]) return;
          seen[k] = 1; uniq.push(r);
        });
        var skipped = rows.length - uniq.length;
        return confirmBox('解析到 ' + uniq.length + ' 条人员记录' +
          (skipped ? '（另有 ' + skipped + ' 条重复已自动合并）' : '') + '。\n' +
          '导入后按「部门+类别+姓名」与现有名单合并：相同则更新，不同则新增。继续？')
          .then(function (ok) {
            if (!ok) return null;
            return DB.insertRoster(uniq).then(function () {
              return refreshAll();
            }).then(function () {
              toast('已导入 ' + uniq.length + ' 条', 'ok');
              render();
            });
          });
      }).catch(function (e) {
        toast('导入失败：' + String(e.message || e), 'err');
      }).then(function () { file.value = ''; });
    });

    var tpl = q('r-template');
    if (tpl) tpl.addEventListener('click', downloadRosterTemplate);

    var rex = q('r-export');
    if (rex) rex.addEventListener('click', function () {
      var bytes = X.buildXlsx([{
        name: '人员名单', rows: P.rosterSheetRows(S.roster), colWidths: [7, 30, 14, 12, 16, 24]
      }]);
      U.download('人员名单_' + U.todayISO() + '.xlsx',
        new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      toast('名单已导出', 'ok');
    });
  }

  /* ================= 名单文件导入解析 ================= */
  function importRosterFile(file) {
    var name = (file.name || '').toLowerCase();
    if (/\.csv$/.test(name)) {
      return file.text().then(function (t) { return P.rowsToRoster(X.parseCSV(t)); });
    }
    if (/\.xlsx$/.test(name)) {
      return file.arrayBuffer().then(function (buf) { return X.readXlsx(buf); })
        .then(function (grid) { return P.rowsToRoster(grid); });
    }
    return Promise.reject(new Error('只支持 .xlsx 或 .csv 文件。若你的表是老式 .xls，请在 Excel 里另存为 .xlsx'));
  }

  function downloadRosterTemplate() {
    var rows = [
      ['序号', '部门', '类别', '姓名', '手机号', '备注'],
      [1, '机械与动力工程学院', '办公室主任', '马超', '', ''],
      [2, '党委工作部、校长办公室', '处长', '王悦', '', ''],
      [3, '法学院', '院长', '于语和', '', ''],
      [4, '体育学院', '党总支书记', '周祥成', '', '']
    ];
    var bytes = X.buildXlsx([{ name: '人员名单', rows: rows, colWidths: [7, 30, 14, 12, 16, 24] }]);
    U.download('人员名单导入模板.xlsx',
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    toast('模板已下载，按这个格式填好后再导入', 'ok');
  }

  /* ============================================================
   *  导出统计
   * ============================================================ */
  function viewExport() {
    var rows = S.meetings.slice().sort(function (a, b) {
      return (b.meet_date || '') < (a.meet_date || '') ? -1 : 1;
    }).map(function (m) {
      return '<tr>' +
        '<td class="ctr"><input type="checkbox" data-xsel="' + h(m.id) + '" ' + (S.exportSel && S.exportSel[m.id] ? 'checked' : '') + '></td>' +
        '<td class="name">' + h(m.title) + '</td>' +
        '<td>' + h(U.fmtDate(m.meet_date) || '—') + '</td>' +
        '<td>' + h(m.location || '—') + '</td>' +
        '<td class="ctr">' + (m.invite || []).length + '</td>' +
        '<td class="ctr"><button class="btn ghost sm" data-xone="' + h(m.id) + '">导出本场</button></td>' +
      '</tr>';
    }).join('');

    var body =
      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>导出会议信息与统计</h2></div>' +
      '<div class="card-b">' +
        '<div class="btn-row">' +
          '<button class="btn" id="x-all">导出全部会议（Excel，每场一个工作表）</button>' +
          '<button class="btn ghost" id="x-summary">导出总览统计表</button>' +
          '<button class="btn ghost" id="x-roster">导出人员名单</button>' +
        '</div>' +
        '<div class="hint" style="margin-top:10px">导出的表里包含：会议信息、受邀人、是否参会、不参会原因、备注、回执时间，' +
        '可以直接用于归档和统计。下方的勾选框只作为标记，方便你核对自己想导哪几场，' +
        '单独导一场请点右侧「导出本场」。</div>' +
      '</div></div>' +
      '<div class="card"><div class="card-h"><h2>按会议单独导出</h2></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th style="width:34px"></th><th>会议名称</th><th>日期</th><th>地点</th><th>受邀</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="6"><div class="empty">还没有会议</div></td></tr>') +
      '</tbody></table></div></div>';

    return shell('export', '导出统计', '', body);
  }

  function afterExport() {
    S.exportSel = S.exportSel || {};
    document.querySelectorAll('[data-xsel]').forEach(function (b) {
      b.addEventListener('change', function () {
        S.exportSel[b.getAttribute('data-xsel')] = b.checked;
      });
    });
    document.querySelectorAll('[data-xone]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = S.meetings.filter(function (x) { return x.id === b.getAttribute('data-xone'); })[0];
        if (!m) return;
        DB.listResponses(m.id).then(function (rs) { exportMeeting(m, rs || []); })
          .catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    q('x-all').addEventListener('click', function () {
      var sel = S.meetings.slice();
      if (!sel.length) { toast('没有可导出的会议', 'warn'); return; }
      var btn = q('x-all'); btn.disabled = true; btn.textContent = '正在汇总…';
      Promise.all(sel.map(function (m) {
        return DB.listResponses(m.id).then(function (rs) { return { m: m, rs: rs || [] }; });
      })).then(function (pairs) {
        var sheets = [{
          name: '总览', rows: P.summarySheetRows(pairs),
          colWidths: [6, 30, 14, 14, 22, 20, 10, 10, 12, 10, 9]
        }];
        pairs.forEach(function (p) {
          sheets.push({
            name: P.sheetName(p.m.title, p.m.meet_date),
            rows: P.meetingSheetRows(p.m, p.rs),
            colWidths: [8, 14, 14, 26, 11, 26, 22, 18]
          });
        });
        var bytes = X.buildXlsx(sheets);
        U.download('会议统计汇总_' + U.todayISO() + '.xlsx',
          new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        toast('已导出 ' + pairs.length + ' 场会议', 'ok');
      }).catch(function (e) { toast('导出失败：' + String(e.message || e), 'err'); })
        .then(function () { btn.disabled = false; btn.textContent = '导出全部会议（Excel，每场一个工作表）'; });
    });

    q('x-summary').addEventListener('click', function () {
      var btn = q('x-summary'); btn.disabled = true;
      Promise.all(S.meetings.map(function (m) {
        return DB.listResponses(m.id).then(function (rs) { return { m: m, rs: rs || [] }; });
      })).then(function (pairs) {
        var bytes = X.buildXlsx([{
          name: '总览', rows: P.summarySheetRows(pairs),
          colWidths: [6, 30, 14, 14, 22, 20, 10, 10, 12, 10, 9]
        }]);
        U.download('会议总览统计_' + U.todayISO() + '.xlsx',
          new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        toast('总览统计已导出', 'ok');
      }).catch(function (e) { toast('导出失败：' + String(e.message || e), 'err'); })
        .then(function () { btn.disabled = false; });
    });

    q('x-roster').addEventListener('click', function () {
      var bytes = X.buildXlsx([{
        name: '人员名单', rows: P.rosterSheetRows(S.roster),
        colWidths: [7, 30, 14, 12, 16, 24]
      }]);
      U.download('人员名单_' + U.todayISO() + '.xlsx',
        new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      toast('名单已导出', 'ok');
    });
  }

  function exportMeeting(m, responses) {
    try {
      var bytes = X.buildXlsx([{
        name: P.sheetName(m.title, m.meet_date),
        rows: P.meetingSheetRows(m, responses),
        colWidths: [8, 14, 14, 26, 11, 26, 22, 18]
      }]);
      U.download(U.safeFileName('参会情况_' + (m.title || '会议') + '_' + (m.meet_date || '')) + '.xlsx',
        new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      toast('已导出本场会议', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  /* ============================================================
   *  二级网页（参会人填写）
   * ============================================================ */
  function viewShare(token) {
    return '<div class="share-page"><div class="share-wrap" id="share-root">' +
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>会议参会确认</h1></div>' +
      '<div class="share-card"><div class="bd"><div class="empty">正在加载会议信息…</div></div></div>' +
      '</div></div>';
  }

  function afterShare(token) {
    var root = q('share-root');
    if (!root) return;
    window.__shareState = null;

    DB.openMeeting(token).then(function (res) {
      if (!res || !res.ok) {
        root.innerHTML = errorCard(res && res.error || '链接无效');
        return;
      }
      window.__shareState = { token: token, data: res };
      renderShareForm();
    }).catch(function (e) {
      root.innerHTML = errorCard('加载失败：' + String(e.message || e));
    });
  }

  function errorCard(msg) {
    return '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>会议参会确认</h1></div>' +
      '<div class="share-card"><div class="bd">' +
      '<div class="notice err" style="margin:0">' + h(msg) + '</div>' +
      '<div class="hint" style="margin-top:12px">请把链接转发给你的会议通知人核对。</div>' +
      '</div></div>';
  }

  function meetingInfoHtml(m) {
    var items = [
      ['会议日期', U.fmtDateWeek(m.meet_date) || '待定'],
      ['会议时间', (m.start_time || '') + (m.end_time ? '–' + m.end_time : '') || '待定'],
      ['会议地点', m.location || '待定'],
      ['主办部门', m.convene_dept || '—'],
      ['主持人', m.host || '—'],
      ['联系人', m.contact || '—']
    ];
    return '<div class="bd grid-info">' + items.map(function (x) {
      return '<div><div class="k">' + h(x[0]) + '</div><div class="v">' + h(x[1]) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderShareForm() {
    var st = window.__shareState;
    if (!st) return;
    var root = q('share-root');
    var m = st.data.meeting;
    var names = st.data.names || [];

    root.innerHTML =
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>' + h(m.title) + '</h1></div>' +

      '<div class="share-card"><div class="hd">📋 会议信息</div>' + meetingInfoHtml(m) +
      (m.agenda ? '<div class="bd" style="border-top:1px solid var(--line)">' +
        '<div class="k" style="font-size:12px;color:#94a3b8;font-weight:600">议程 / 说明</div>' +
        '<div style="white-space:pre-wrap;margin-top:4px">' + h(m.agenda) + '</div></div>' : '') +
      '</div>' +

      (m.closed
        ? '<div class="share-card"><div class="bd"><div class="notice warn" style="margin:0">' +
          '本次参会确认已于 ' + h(U.fmtDateTime(m.deadline)) + ' 截止。' +
          '如需变更，请联系 ' + h(m.contact || '会议联系人') + '。</div></div></div>'
        : '<div class="share-card"><div class="hd">✍️ 请确认您的参会情况</div><div class="bd">' +
            '<label class="f"><span class="lb">您的姓名 <span class="req">*</span></span>' +
            '<input class="input" id="s-name" list="s-namelist" placeholder="请填写本人真实姓名" autocomplete="off">' +
            '<datalist id="s-namelist">' + names.map(function (n) { return '<option value="' + h(n) + '">'; }).join('') + '</datalist>' +
            '<span class="hint">名单里有你的名字会自动提示；填错字会导致统计不到，请核对。</span></label>' +

            '<div class="lb" style="font-size:12.5px;font-weight:600;color:#475569;margin:6px 0 6px">是否参会 <span class="req">*</span></div>' +
            '<div class="choice">' +
              '<div class="opt yes" data-pick="yes"><span class="ic">✅</span><div class="tt">参加</div><div class="ss">我会按时到会</div></div>' +
              '<div class="opt no" data-pick="no"><span class="ic">🙅</span><div class="tt">不参加</div><div class="ss">确实来不了</div></div>' +
            '</div>' +

            '<div id="s-reason-wrap" style="display:none;margin-top:14px">' +
              '<label class="f"><span class="lb">不参会原因</span>' +
              '<textarea class="input" id="s-reason" placeholder="如：出差、上课、身体原因等"></textarea></label></div>' +

            (m.ask_note ? '<label class="f" style="margin-top:14px"><span class="lb">备注（选填）</span>' +
              '<textarea class="input" id="s-note" placeholder="如需代请假、需要准备材料等，可写在这里"></textarea></label>' : '') +

            '<div id="s-msg"></div>' +
            '<button class="btn lg" id="s-submit" style="width:100%;margin-top:6px">提交确认</button>' +
            '<div class="hint" style="text-align:center;margin-top:8px">' +
              (m.deadline ? '填报截止：' + h(U.fmtDateTime(m.deadline)) + '，截止前可重复提交修改。' : '截止前可重复提交修改。') +
            '</div>' +
          '</div></div>') +

      '<div class="share-foot">' + h(CFG.APP_NAME || '') + '</div>';

    if (m.closed) return;

    var picked = null;
    var nameInput = q('s-name');
    var reasonWrap = q('s-reason-wrap');
    var msg = q('s-msg');

    function paintPick() {
      document.querySelectorAll('[data-pick]').forEach(function (el) {
        el.classList.toggle('on', el.getAttribute('data-pick') === picked);
      });
      var showReason = (picked === 'no') && m.ask_reason !== false;
      reasonWrap.style.display = showReason ? 'block' : 'none';
    }

    document.querySelectorAll('[data-pick]').forEach(function (el) {
      el.addEventListener('click', function () {
        picked = el.getAttribute('data-pick');
        paintPick();
        msg.innerHTML = '';
      });
    });

    // 姓名输完自动带出上次的答复
    var lastQuery = '';
    nameInput.addEventListener('change', function () {
      var v = nameInput.value.trim();
      if (v.length < 2 || v === lastQuery) return;
      lastQuery = v;
      DB.myResponse(st.token, v).then(function (r) {
        if (!r || !r.ok || !r.found) return;
        picked = r.attending ? 'yes' : 'no';
        paintPick();
        if (r.reason && q('s-reason')) q('s-reason').value = r.reason;
        if (r.note && q('s-note')) q('s-note').value = r.note;
        msg.innerHTML = '<div class="notice info" style="margin:0 0 12px">' +
          '您上次填写的是「' + (r.attending ? '参加' : '不参加') + '」（' +
          h(U.fmtDateTime(r.updated_at)) + '），可以直接修改后重新提交。</div>';
      }).catch(function () { /* 静默 */ });
    });

    q('s-submit').addEventListener('click', function () {
      var name = nameInput.value.trim();
      if (name.length < 2) { toast('请填写您的姓名（2-20 字）', 'warn'); nameInput.focus(); return; }
      if (!picked) { toast('请选择「参加」或「不参加」', 'warn'); return; }
      var reason = q('s-reason') ? q('s-reason').value.trim() : '';
      if (picked === 'no' && m.ask_reason !== false && !reason) {
        toast('请简单填写一下不参会的原因', 'warn'); q('s-reason').focus(); return;
      }
      var note = q('s-note') ? q('s-note').value.trim() : '';
      var btn = q('s-submit');
      btn.disabled = true; btn.textContent = '正在提交…';
      DB.submitResponse(st.token, name, picked === 'yes', reason, note).then(function (r) {
        if (!r || !r.ok) {
          btn.disabled = false; btn.textContent = '提交确认';
          msg.innerHTML = '<div class="notice err" style="margin:0 0 12px">' + h(r && r.error || '提交失败') + '</div>';
          return;
        }
        renderShareDone(r, m);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '提交确认';
        msg.innerHTML = '<div class="notice err" style="margin:0 0 12px">提交失败：' + h(String(e.message || e)) + '</div>';
      });
    });
  }

  function renderShareDone(r, m) {
    var root = q('share-root');
    var yes = !!r.attending;
    root.innerHTML =
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>' + h(m.title) + '</h1></div>' +
      '<div class="share-card"><div class="bd">' +
        '<div class="done-mark">' +
          '<div class="ic">' + (yes ? '✅' : '📝') + '</div>' +
          '<div class="tt">' + (yes ? '已确认参会' : '已登记为不参会') + '</div>' +
          '<div class="ss">' + h(r.name) + '　' + h(U.fmtDateTime(r.updated_at)) + '</div>' +
        '</div>' +
        (r.on_list ? '' : '<div class="notice warn" style="margin:0 0 12px">' +
          '提示：您填写的姓名不在本次受邀名单中，工作人员会人工核对。' +
          '如果名字写错了，可以点下面的按钮改。' + '</div>') +
        '<div class="notice ok" style="margin:0 0 14px">' + h(r.message || '已记录') +
          '。会议开始前如有变化，可以重新打开本链接修改。</div>' +
        '<button class="btn ghost lg" id="s-again" style="width:100%">修改我的确认</button>' +
      '</div></div>' +
      '<div class="share-card"><div class="hd">📋 会议信息</div>' + meetingInfoHtml(m) + '</div>' +
      '<div class="share-foot">' + h(CFG.APP_NAME || '') + '</div>';

    var again = q('s-again');
    if (again) again.addEventListener('click', function () { renderShareForm(); });
    window.scrollTo(0, 0);
  }

  /* ================= 启动 ================= */
  window.addEventListener('hashchange', function () {
    if (window.__detailTimer) { clearInterval(window.__detailTimer); window.__detailTimer = null; }
    render();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
