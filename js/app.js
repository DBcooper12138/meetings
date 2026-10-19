/* ============================================================
 *  app.js —— 主程序（v2 多用户版）
 *
 *  路由：
 *   #/login  #/register  #/verify  #/forgot  #/reset
 *   #/meetings  #/new  #/edit/:id  #/meeting/:id
 *   #/roster  #/stats  #/account  #/admin
 *   #/s/:token    ← 参会人填报（公开，不需要登录）
 * ============================================================ */
(function (root) {
  'use strict';

  var U = root.MSUtil, X = root.MSXlsx, QR = root.MSQR, P = root.MSParser, DB = root.MSDB;
  var CFG = root.MS_CONFIG;

  var CAT_ORDER = ['处长', '院长', '办公室主任', '党总支书记'];

  function q(id) { return document.getElementById(id); }
  function h(s) { return U.esc(s); }
  var toast = U.toast, confirmBox = U.confirmBox, promptBox = U.promptBox;

  /* ================= 全局状态 ================= */
  var S = {
    mode: 'cloud',
    ready: false,
    session: null,
    profile: null,
    meetings: [], roster: [], allResponses: [], responsesCache: {},
    plans: [], walletLogs: [], myRecharges: [],
    detailResponses: null,
    filter: 'all', keyword: '',
    rosterFilter: { kw: '', cat: '' },
    selectedRoster: {}, selectedInvite: {},
    detailTab: 'att',
    statsTab: 'meeting', statsFilter: 'all', statsMeetingId: '', statsPerson: '', statsPersonKw: '',
    statsFrom: '', statsTo: '', statsKw: '', statsOwner: '', statsOwners: null,
    templateId: '',
    adminTab: 'overview', adminRechargeFilter: 'pending',
    pendingEmail: '', resetEmail: '', flash: '',
    recoveryMode: false, recoveryInvalid: false, wantReset: false, passwordRecovery: false,
    linkError: '', bootError: ''
  };

  /* ================= 路由 ================= */
  function queryParams() { return new URLSearchParams(location.search || ''); }

  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var qi = raw.indexOf('?');
    if (qi >= 0) raw = raw.slice(0, qi);
    var parts = raw.split('/').filter(Boolean);
    return { name: parts[0] || 'meetings', arg: parts[1] || '' };
  }

  function go(hash) {
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  }

  /* ================= 数据加载 ================= */
  function refreshProfile() {
    return DB.auth.getProfile().then(function (p) { S.profile = p; return p; });
  }

  function refreshAll() {
    return Promise.all([DB.listMeetings(), DB.listRoster(), DB.listAllResponses()])
      .then(function (r) {
        S.meetings = r[0] || [];
        S.roster = r[1] || [];
        indexResponses(r[2] || []);
        return true;
      }).catch(function (e) {
        toast(String(e.message || e), 'err');
        return false;
      });
  }

  function refreshAccount() {
    return Promise.all([DB.listPlans(), DB.listWalletLogs(), DB.listMyRecharges()])
      .then(function (r) {
        S.plans = r[0] || [];
        S.walletLogs = r[1] || [];
        S.myRecharges = r[2] || [];
      }).catch(function () { /* 账户数据失败不阻塞主流程 */ });
  }

  function indexResponses(all) {
    S.allResponses = all || [];
    S.responsesCache = {};
    S.allResponses.forEach(function (r) {
      (S.responsesCache[r.meeting_id] = S.responsesCache[r.meeting_id] || []).push(r);
    });
  }

  /* 某场会议的回执更新后，同步进全量列表并重建索引 ——
     否则「按人员统计」用的是旧的 S.allResponses，会漏掉刚提交的回执。 */
  function setMeetingResponses(id, list) {
    var rest = (S.allResponses || []).filter(function (r) { return r.meeting_id !== id; });
    indexResponses(rest.concat(list || []));
    S.detailResponses = (S.responsesCache && S.responsesCache[id]) || [];
  }

  function afterLogin() {
    return refreshProfile().then(function (p) {
      if (!p) throw new Error('找不到你的账号档案。可能是注册时数据库触发器未生效，请确认已执行最新的 01_schema.sql');
      S.profile = p;
      S.ready = true;
      return Promise.all([refreshAll(), refreshAccount(), loadQuota()]);
    }).then(function () {
      go('#/meetings');
      render();
    }).catch(function (e) {
      S.ready = false;
      S.bootError = String(e.message || e);
      render();
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    S.mode = DB.isCloud() ? 'cloud' : 'local';
    P.setFormatters({ date: U.fmtDate, dateWeek: U.fmtDateWeek, dateTime: U.fmtDateTime });
    bindShell();

    var qs = queryParams();
    S.wantReset = (qs.get('goto') === 'reset');
    // 邮件链接可能带回错误（链接过期、已在别的浏览器用过等）
    var errDesc = qs.get('error_description') || qs.get('error');
    if (errDesc) S.linkError = decodeURIComponent(String(errDesc).replace(/\+/g, ' '));

    if (!DB.isCloud()) {
      DB.enterDemo().then(function () { return afterLogin(); });
      return;
    }

    DB.auth.getSession().then(function (session) {
      S.session = session;
      // 从"重置密码"邮件回来：有会话就说明链接有效，可以改密码
      if (S.wantReset) {
        if (session) { S.recoveryMode = true; S.recoveryInvalid = false; }
        else { S.recoveryInvalid = true; }
        // 把 #access_token=... 换成正常路由（必须在 getSession 之后改，
        // 否则 supabase 就没机会解析链接里的 token 了）
        try {
          history.replaceState(null, '', location.pathname + '?goto=reset#/reset');
        } catch (e) { /* 忽略 */ }
      }
      if (!session) { S.ready = false; render(); return; }
      return refreshProfile().then(function (p) {
        if (!p) { S.ready = false; S.bootError = ''; render(); return; }
        S.profile = p;
        S.ready = true;
        return Promise.all([refreshAll(), refreshAccount()]).then(function () {
          // 清除邮件链接带来的 #access_token=... 之类的残余，避免地址栏难看
          cleanAuthHash();
          render();
        });
      });
    }).catch(function (e) {
      S.ready = false;
      S.bootError = String(e.message || e);
      render();
    });

    DB.auth.onAuthChange(function (event) {
      if (event === 'SIGNED_OUT') {
        S.profile = null; S.session = null; S.ready = false;
        go('#/login');
      } else if (event === 'PASSWORD_RECOVERY') {
        S.passwordRecovery = true;
        S.recoveryMode = true;
        S.recoveryInvalid = false;
        go('#/reset');
        render();
      }
    });
  }

  /* 把 #access_token=... 这类邮件链接残留从地址栏清掉 */
  function cleanAuthHash() {
    var h = String(location.hash || '');
    if (!/access_token|refresh_token|error_description|type=recovery|type=signup/.test(h)) return;
    try {
      history.replaceState(null, '', location.pathname + location.search + '#/meetings');
    } catch (e) { /* 忽略 */ }
  }

  /* ================= 外壳 ================= */
  function bindShell() {
    q('app').addEventListener('click', function (e) {
      var t = e.target.closest('[data-go]');
      if (t) { e.preventDefault(); go(t.getAttribute('data-go')); }
    });
  }

  function shell(active, title, actions, body) {
    var p = S.profile || {};
    var nav = [
      ['meetings', '📋', '会议看板', '#/meetings'],
      ['new', '➕', '发布会议', '#/new'],
      ['roster', '👥', '名单管理', '#/roster'],
      ['stats', '📊', '统计信息', '#/stats'],
      ['account', '💰', '我的账户', '#/account']
    ];
    if (p.is_super) nav.push(['admin', '🛡', '超级管理员', '#/admin']);

    var dotCls = S.mode === 'local' ? 'local' : 'ok';
    var dotTxt = S.mode === 'local' ? '本机演示模式（数据只在本机）' : '已连接云端';

    return '' +
      '<div class="shell">' +
        '<aside class="side">' +
          '<div class="brand"><b>' + h(CFG.APP_NAME || '会议系统') + '</b>' +
            '<span>' + h(CFG.ORG_NAME || '') + '</span></div>' +
          '<nav>' + nav.map(function (n) {
            return '<a href="' + n[3] + '" class="' + (active === n[0] ? 'on' : '') + '">' +
                   '<span class="ico">' + n[1] + '</span>' + n[2] + '</a>';
          }).join('') + '</nav>' +
          '<div class="side-user">' +
            '<div class="su-name">' + h(p.name || '未登录') +
              (p.is_super ? ' <span class="tag dark">超管</span>' : '') + '</div>' +
            '<div class="su-sub">工号 ' + h(p.emp_no || '—') + '</div>' +
            '<button class="btn ghost sm" id="btn-logout" style="width:100%;margin-top:8px">退出登录</button>' +
          '</div>' +
          '<div class="foot"><span class="dot ' + dotCls + '"></span>' + h(dotTxt) + '</div>' +
        '</aside>' +
        '<div class="main">' +
          '<div class="topbar"><h1>' + h(title) + '</h1><div class="sp"></div>' + (actions || '') + '</div>' +
          '<div class="content">' + body + '</div>' +
        '</div>' +
      '</div>';
  }

  function afterShell() {
    var lo = q('btn-logout');
    if (lo) lo.addEventListener('click', function () {
      confirmBox('确定退出登录？').then(function (ok) {
        if (!ok) return;
        DB.auth.signOut().then(function () {
          S.profile = null; S.session = null; S.ready = false;
          go('#/login');
          render();
        });
      });
    });
  }

  /* ================= 渲染 ================= */
  function render() {
    var r = parseHash();
    var app = q('app');
    var wrap = function (html) { app.innerHTML = html; afterShell(); };

    if (r.name === 's') {
      app.innerHTML = viewShare(r.arg);
      afterShare(r.arg);
      return;
    }

    if (!S.ready) {
      var authed = { login: 1, register: 1, verify: 1, forgot: 1, reset: 1 };
      if (!authed[r.name]) r = { name: 'login', arg: '' };
      if (r.name === 'register') { app.innerHTML = MSAuth.viewRegister(); MSAuth.bindRegister(); return; }
      if (r.name === 'verify') { app.innerHTML = MSAuth.viewVerify(); MSAuth.bindVerify(); return; }
      if (r.name === 'forgot') { app.innerHTML = MSAuth.viewForgot(); MSAuth.bindForgot(); return; }
      if (r.name === 'reset') { app.innerHTML = MSAuth.viewReset(); MSAuth.bindReset(); return; }
      if (S.bootError) { app.innerHTML = bootErrorHtml(); bindBootError(); return; }
      app.innerHTML = MSAuth.viewLogin();
      MSAuth.bindLogin();
      return;
    }

    // 已登录状态下的"重置密码"（点邮件链接回来，已有临时会话）
    if (r.name === 'reset' && S.recoveryMode) {
      app.innerHTML = MSAuth.viewReset();
      MSAuth.bindReset();
      return;
    }

    if (r.name === 'admin') {
      if (!S.profile || !S.profile.is_super) { go('#/meetings'); return; }
      wrap(MSAdmin.viewAdmin());
      MSAdmin.bindAdmin();
      return;
    }

    switch (r.name) {
      case 'meeting': wrap(viewDetail(r.arg)); afterDetail(r.arg); break;
      case 'new': wrap(viewForm(null)); bindForm(null); break;
      case 'edit': wrap(viewForm(r.arg)); bindForm(r.arg); break;
      case 'roster': wrap(viewRoster()); afterRoster(); break;
      case 'stats': wrap(MSStats.viewStats()); MSStats.bindStats(); break;
      case 'account': wrap(MSAuth.viewAccount()); MSAuth.bindAccount(); break;
      case 'login': case 'register': case 'verify': case 'forgot': case 'reset':
        go('#/meetings'); return;
      default: wrap(viewMeetings()); afterMeetings();
    }
  }

  function bootErrorHtml() {
    return '<div class="content" style="max-width:600px;margin:0 auto;padding-top:60px">' +
      '<div class="card"><div class="card-h"><h2>启动失败</h2></div><div class="card-b">' +
      '<div class="notice err">' + h(S.bootError) + '</div>' +
      '<div class="btn-row"><button class="btn" onclick="location.reload()">刷新页面</button>' +
      '<button class="btn ghost" id="be-logout">重新登录</button></div></div></div></div>';
  }
  function bindBootError() {
    var b = q('be-logout');
    if (b) b.addEventListener('click', function () {
      DB.auth.signOut().then(function () { location.reload(); });
    });
  }

  /* 权限口径（与数据库 check_meeting_allowed 保持一致） */
  function planState() {
    var p = S.profile || {};
    var superUser = !!p.is_super;
    var exp = p.plan_expires_at ? new Date(p.plan_expires_at) : null;
    var active = superUser || (exp && exp.getTime() > Date.now());
    var myMeetings = S.meetings.filter(function (m) { return m.owner_id === p.id; });
    return {
      isSuper: superUser,
      active: !!active,
      expires: exp,
      daysLeft: active && exp ? Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400000)) : 0,
      meetingCount: myMeetings.length,
      freeMeetingsLeft: active ? Infinity : Math.max(0, 1 - myMeetings.length),
      canExport: !!active
    };
  }

  /* 导出前的统一拦截 */
  function requireExport() {
    if (planState().canExport) return true;
    U.confirmBox('导出属于会员功能。\n你当前的套餐未开通或已过期，购买套餐后即可导出。\n\n现在去「我的账户」看看套餐？')
      .then(function (ok) { if (ok) go('#/account'); });
    return false;
  }

  /* 免费版操作配额（催办复制 / 一键加入名单，各 10 次；会员不限） */
  function quotaInfo(kind) {
    var q = S.quota;
    if (!q || !q.ok) return null;
    if (q.unlimited) return { unlimited: true };
    var k = (kind === 'remind' ? q.remind : q.promote) || { used: 0, left: 0 };
    return { unlimited: false, used: k.used, left: k.left, limit: q.limit || 10 };
  }

  function quotaHintText(kind) {
    var q = quotaInfo(kind);
    if (!q) return '';
    if (q.unlimited) return '会员：不限次数';
    return '免费额度：已用 ' + q.used + '/' + q.limit + ' 次，剩 ' + q.left + ' 次';
  }

  function loadQuota() {
    return DB.quotaStatus().then(function (q) { S.quota = q; return q; })
      .catch(function () { S.quota = null; });
  }

  /* 扣一次配额；用完了引导购买 */
  function useQuota(kind) {
    return DB.consumeQuota(kind).then(function (r) {
      if (!r || !r.ok) {
        U.confirmBox((r && r.error) || '额度已用完').then(function (ok) {
          if (ok) go('#/account');
        });
        return false;
      }
      return loadQuota().then(function () { return r; });
    }).catch(function (e) {
      toast(String(e.message || e), 'err');
      return false;
    });
  }

  /* ============================================================
   *  会议看板
   * ============================================================ */
  function statOf(m) {
    return P.buildAttendance(m, (S.responsesCache && S.responsesCache[m.id]) || []).stats;
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
      var donePct = inviteN ? Math.round(st.answered * 100 / inviteN) : 0;
      var closed = m.deadline && Date.now() > new Date(m.deadline).getTime();
      return '<div class="mcard" data-go="#/meeting/' + h(m.id) + '">' +
        '<div class="row1"><h3>' + h(m.title || '未命名会议') + '</h3>' +
          (closed ? '<span class="tag gray">已截止</span>' : '') + '</div>' +
        '<div class="meta">' +
          '<span>🗓 <b>' + h(U.fmtDateWeek(m.meet_date) || '未定日期') + '</b>' +
            (m.start_time ? ' ' + h(m.start_time) + (m.end_time ? '–' + h(m.end_time) : '') : '') + '</span>' +
          '<span>📍 ' + h(m.location || '地点待定') + '</span>' +
          (m.convene_dept ? '<span>🏛 ' + h(m.convene_dept) + '</span>' : '') +
        '</div>' +
        '<div class="bar"><i class="y" style="width:' + (inviteN ? (st.yes * 100 / inviteN) : 0) + '%"></i>' +
          '<i class="n" style="width:' + (inviteN ? (st.no * 100 / inviteN) : 0) + '%"></i></div>' +
        '<div class="nums">' +
          '<span>参会 <b style="color:#15803d">' + st.yes + '</b></span>' +
          '<span>不参会 <b style="color:#b91c1c">' + st.no + '</b></span>' +
          '<span>待确认 <b style="color:#b45309">' + st.pending + '</b></span>' +
          '<span class="mini" style="color:#94a3b8">回执率 ' + donePct + '%</span>' +
        '</div>' +
        '<div class="foot"><span class="tag blue">受邀 ' + inviteN + ' 人</span>' +
          (st.outside ? '<span class="tag amber">名单外 ' + st.outside + '</span>' : '') +
          '<span class="sp"></span>' +
          '<button class="btn ghost sm" data-copy="' + h(shareUrl(m.share_token)) + '">复制链接</button>' +
          '<button class="btn ghost sm" data-template="' + h(m.id) + '">作模板新建</button>' +
        '</div></div>';
    }).join('');

    var ps = planState();
    var planWarn = '';
    if (!ps.active) {
      planWarn = '<div class="notice warn"><b>你当前是免费额度：</b>' +
        '最多发布 <b>1 场</b>会议（已有 ' + ps.meetingCount + ' 场）、单场最多邀请 <b>20 人</b>，' +
        '且<b>不支持导出</b>。' +
        '<a href="#/account">购买套餐解除限制 →</a></div>';
    } else if (!ps.isSuper && ps.expires) {
      planWarn = '<div class="notice info">会员有效期至 <b>' +
        U.fmtDate(ps.expires.toISOString().slice(0, 10)) + '</b>，剩余 ' + ps.daysLeft + ' 天。' +
        '<a href="#/account">续费 →</a></div>';
    }
    if (S.mode === 'local') {
      planWarn = '<div class="notice warn"><b>当前是本机演示模式</b>：数据只存在这台电脑的浏览器里，' +
        '别人用手机打不开你的会议链接。</div>' + planWarn;
    }

    return shell('meetings', '会议看板',
      '<input class="input" style="width:200px" id="mkw" placeholder="搜索会议名称/地点" value="' + h(S.keyword) + '">' +
      '<button class="btn" data-go="#/new">＋ 发布会议</button>',
      planWarn +
      '<div class="btn-row" style="margin-bottom:16px">' +
        ['all:全部', 'upcoming:未召开', 'past:已结束'].map(function (x) {
          var k = x.split(':')[0], v = x.split(':')[1];
          return '<button class="btn ' + (S.filter === k ? '' : 'ghost') + ' sm" data-filter="' + k + '">' + v + '</button>';
        }).join('') +
        '<span class="hint" style="margin-left:6px">共 ' + S.meetings.length + ' 场会议</span>' +
      '</div>' +
      (list.length
        ? '<div class="grid c2">' + cards + '</div>'
        : '<div class="card"><div class="empty"><span class="big">📋</span>' +
          (S.meetings.length ? '没有符合条件的会议' : '还没有会议，点右上角「＋ 发布会议」开始') + '</div></div>')
    );
  }

  function afterMeetings() {
    var kw = q('mkw');
    if (kw) kw.addEventListener('input', function () {
      var pos = kw.selectionStart;
      S.keyword = kw.value.trim();
      render();
      restoreCaret('mkw', pos);
    });
    document.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () { S.filter = b.getAttribute('data-filter'); render(); });
    });
    document.querySelectorAll('[data-template]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        var id = b.getAttribute('data-template');
        var src = S.meetings.filter(function (x) { return x.id === id; })[0];
        if (!src) return;
        confirmBox('用「' + (src.title || '这场会议') + '」作为模板新建一场会议？\n' +
          '会复制：名称、时间、地点、主办部门、主持人、联系人、议程、以及参会人员名单。\n' +
          '会议日期会改成今天，你可以再改。').then(function (ok) {
          if (!ok) return;
          S.templateId = id;
          go('#/new');
        });
      });
    });
    bindCopyButtons();
  }

  function bindCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        copyText(b.getAttribute('data-copy')).then(function () { toast('已复制', 'ok'); });
      });
    });
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    }
    fallbackCopy(t);
    return Promise.resolve();
  }
  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function shareUrl(token) {
    return location.href.split('#')[0] + '#/s/' + token;
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
    root.__curMeeting = m;
    S.detailResponses = (S.responsesCache && S.responsesCache[m.id]) || [];
    var att = P.buildAttendance(m, S.detailResponses);
    var st = att.stats;
    var rows = P.sortRows(att.rows);
    var closed = m.deadline && Date.now() > new Date(m.deadline).getTime();
    var url = shareUrl(m.share_token);

    var visible = rows.filter(function (r) {
      if (S.detailTab === 'yes') return r.status === 'yes';
      if (S.detailTab === 'no') return r.status === 'no';
      if (S.detailTab === 'pending') return r.status === 'pending';
      return true;
    });

    var info = '<div class="kv-list">' +
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
        '<div class="hint">受邀 ' + st.invited + ' 人。别人打开链接填写姓名并选择是否参会，' +
        '结果会自动回到本页（每 ' + Math.round((CFG.AUTO_REFRESH_MS || 30000) / 1000) + ' 秒自动刷新）。</div>' +
        (st.pending ? '<div class="btn-row" style="margin-top:12px">' +
          '<button class="btn ghost sm" id="d-remind">复制催办文本（待确认 ' + st.pending + ' 人）</button>' +
          '<span class="hint">' + quotaHintText('remind') + '</span></div>' : '') +
      '</div></div>' +

      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + st.invited + '</div><div class="t">受邀人数</div></div>' +
        '<div class="stat green"><div class="n">' + st.yes + '</div><div class="t">确认参会</div></div>' +
        '<div class="stat red"><div class="n">' + st.no + '</div><div class="t">确认不参会</div></div>' +
        '<div class="stat amber"><div class="n">' + st.pending + '</div><div class="t">尚未确认</div></div>' +
      '</div>' +

      '<div class="card"><div class="card-h"><h2>参会人员情况</h2>' +
        '<span class="sp" style="flex:1"></span>' +
        [['att', '全部'], ['yes', '已确认参会'], ['no', '不参会'], ['pending', '待确认']].map(function (t) {
          return '<button class="btn ' + (S.detailTab === t[0] ? '' : 'ghost') + ' sm" data-tab="' + t[0] + '">' +
                 t[1] + '</button>';
        }).join('') +
      '</div><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>#</th><th>工号</th><th>姓名</th><th>类别</th><th>部门</th><th>是否参会</th>' +
        '<th>不参会原因</th><th>备注</th><th>回执时间</th><th>操作</th>' +
      '</tr></thead><tbody>' +
        (visible.length ? visible.map(function (r, i) {
          var act = '—';
          if (!r.on_list) {
            act = r.promoted
              ? '<span class="tag green">已加入名单</span>'
              : '<button class="btn sm" data-promote="' + h(r.response_id) + '">加入名单</button>';
          }
          return '<tr>' +
            '<td class="ctr mini">' + (i + 1) + '</td>' +
            '<td class="mini">' + h(r.emp_no || '—') + '</td>' +
            '<td class="name">' + h(r.name) + (r.on_list ? '' : ' <span class="tag amber">名单外</span>') + '</td>' +
            '<td>' + h(r.category || '—') + '</td>' +
            '<td>' + h(r.dept || '—') + '</td>' +
            '<td>' + statusTag(r.status) + '</td>' +
            '<td>' + (r.reason ? h(r.reason) : '<span class="mini">—</span>') + '</td>' +
            '<td>' + (r.note ? h(r.note) : '<span class="mini">—</span>') + '</td>' +
            '<td class="mini">' + (r.updated_at ? U.fmtDateTime(r.updated_at) : '—') + '</td>' +
            '<td class="ctr">' + act + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="10"><div class="empty">这个分类下暂时没有人</div></td></tr>') +
      '</tbody></table></div></div>';

    return shell('meetings', '会议详情', '', body);
  }

  function kv(k, v) {
    return '<div class="kv"><div class="k">' + h(k) + '</div><div class="v">' + (v || '—') + '</div></div>';
  }
  function statusTag(st) {
    if (st === 'yes') return '<span class="tag green">参加</span>';
    if (st === 'no') return '<span class="tag red">不参加</span>';
    return '<span class="tag amber">待确认</span>';
  }

  function remindText(m, att, url) {    var pending = att.rows.filter(function (r) { return r.status === 'pending'; });
    var lines = ['【参会确认提醒】' + (m.title || '')];
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
    var m = root.__curMeeting;
    if (!m) return;
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { S.detailTab = b.getAttribute('data-tab'); render(); });
    });
    var cp = q('d-copy');
    if (cp) cp.addEventListener('click', function () {
      copyText(q('d-url').value).then(function () { toast('链接已复制', 'ok'); });
    });
    var qb = q('d-qr');
    if (qb) qb.addEventListener('click', function () {
      var box = q('d-qr-box');
      if (box.style.display === 'none') {
        try { q('d-qr-img').src = QR.toPngDataUrl(q('d-url').value, 5); }
        catch (e) { toast('二维码生成失败：' + e.message, 'err'); return; }
        box.style.display = 'block';
      } else box.style.display = 'none';
    });
    var rf = q('d-refresh');
    if (rf) rf.addEventListener('click', function () {
      rf.disabled = true; rf.textContent = '正在刷新…';
      DB.listResponses(id).then(function (rs) {
        setMeetingResponses(id, rs || []);
        toast('已刷新，共 ' + S.detailResponses.length + ' 条回执', 'ok');
        render();
      }).catch(function (e) { toast(String(e.message || e), 'err'); rf.disabled = false; });
    });
    var ex = q('d-export');
    if (ex) ex.addEventListener('click', function () {
      if (!requireExport()) return;
      MSStats.exportMeeting(m, S.detailResponses || []);
    });
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

    // 复制催办文本（消耗免费配额）
    var rem = q('d-remind');
    if (rem) rem.addEventListener('click', function () {
      useQuota('remind').then(function (r) {
        if (!r) return;
        var att = P.buildAttendance(m, S.detailResponses || []);
        var txt = remindText(m, att, shareUrl(m.share_token));
        return copyText(txt).then(function () {
          var q2 = quotaInfo('remind');
          toast('催办文本已复制' + (q2 && !q2.unlimited ? '（免费额度剩余 ' + q2.left + ' 次）' : ''), 'ok');
          render();
        });
      });
    });

    // 名单外参会人：一键加入名单
    document.querySelectorAll('[data-promote]').forEach(function (b) {
      b.addEventListener('click', function () {
        var rid = b.getAttribute('data-promote');
        b.disabled = true;
        DB.promoteResponse(rid).then(function (r) {
          if (!r || !r.ok) {
            b.disabled = false;
            U.confirmBox((r && r.error) || '加入失败').then(function (ok) {
              if (ok) go('#/account');
            });
            return;
          }
          var q2 = quotaInfo('promote');
          toast(r.already ? '这个人已经在名单里了'
            : '已加入名单' + (q2 && !q2.unlimited ? '（免费额度剩余 ' + q2.left + ' 次）' : ''), 'ok');
          return Promise.all([DB.listRoster(), DB.listResponses(id), loadQuota()])
            .then(function (arr) {
              S.roster = arr[0] || [];
              setMeetingResponses(id, arr[1] || []);
              render();
            });
        }).catch(function (e) {
          b.disabled = false;
          toast(String(e.message || e), 'err');
        });
      });
    });
    bindCopyButtons();

    loadDetailResponses(id, true);
    if (root.__detailTimer) clearInterval(root.__detailTimer);
    if (S.mode === 'cloud') {
      root.__detailTimer = setInterval(function () {
        var r = parseHash();
        if (r.name !== 'meeting' || r.arg !== id) { clearInterval(root.__detailTimer); return; }
        loadDetailResponses(id, false);
      }, Math.max(10000, CFG.AUTO_REFRESH_MS || 30000));
    }
  }

  function loadDetailResponses(id, first) {
    DB.listResponses(id).then(function (rs) {
      var before = (S.detailResponses || []).map(function (x) { return x.name_key; }).sort().join(',');
      setMeetingResponses(id, rs || []);
      var after = S.detailResponses.map(function (x) { return x.name_key; }).sort().join(',');
      if (after !== before) {
        if (!first) toast('收到新回执，已更新', 'ok');
        render();
      }
    }).catch(function (e) {
      if (first) toast('读取回执失败：' + String(e.message || e), 'err');
    });
  }

  /* ============================================================
   *  发布 / 编辑会议
   * ============================================================ */
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

  function restoreCaret(id, pos) {
    var el = q(id);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (e) {}
  }

  function viewForm(editId) {
    var isEdit = !!editId;
    var m = isEdit ? S.meetings.filter(function (x) { return x.id === editId; })[0] : null;
    if (isEdit && !m) return shell('meetings', '编辑会议', '', '<div class="notice err">找不到该会议</div>');

    // 用历史会议作模板
    var tpl = null;
    if (!isEdit && S.templateId) {
      tpl = S.meetings.filter(function (x) { return x.id === S.templateId; })[0] || null;
    }

    var draft = m || (tpl ? {
      title: tpl.title || '',
      meet_date: U.todayISO(),                    // 日期换成今天，避免直接发到过去
      start_time: tpl.start_time || '',
      end_time: tpl.end_time || '',
      location: tpl.location || '',
      convene_dept: tpl.convene_dept || '',
      host: tpl.host || '',
      contact: tpl.contact || '',
      agenda: tpl.agenda || '',
      ask_reason: tpl.ask_reason !== false,
      ask_note: tpl.ask_note !== false,
      deadline: '',
      invite: tpl.invite || []
    } : {
      title: '', meet_date: U.todayISO(), start_time: '09:00', end_time: '11:00',
      location: '', convene_dept: '', host: '', contact: '', agenda: '',
      ask_reason: true, ask_note: true, deadline: '', invite: []
    });
    S.editing = draft;

    S.selectedInvite = {};
    (draft.invite || []).forEach(function (p) { S.selectedInvite[inviteKey(p)] = true; });

    var cats = availableCategories();
    var catAll = cats.map(function (c) {
      return '<label class="cat-chip" data-cat="' + h(c) + '">' +
             '<input type="checkbox" data-catbox="' + h(c) + '"> ' + h(c) +
             ' <span class="mini">(' + rosterByCat(c).length + ')</span></label>';
    }).join('');

    var body =
      '<div class="btn-row" style="margin-bottom:14px">' +
        '<button class="btn ghost sm" data-go="#/meetings">← 返回看板</button>' +
      '</div>' +
      (tpl ? '<div class="notice info">已从历史会议「' + h(tpl.title || '') + '」复制：' +
        '名称、时间、地点、主办部门、主持人、联系人、议程和参会人员都已带过来。' +
        '会议日期已改为今天，请确认后发布。<br>' +
        '<span class="hint">如果原会议的参会人后来被从名单里删掉了，他们不会出现在这场会议里。</span></div>' : '') +
      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h2>' +
        (isEdit ? '编辑会议' : '发布新会议') + '</h2></div><div class="card-b">' +
        '<label class="f"><span class="lb">会议名称 <span class="req">*</span></span>' +
          '<input class="input" id="f-title" value="' + h(draft.title) + '" placeholder="如：2026年春季学期中层干部会议"></label>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">' +
          '<label class="f"><span class="lb">会议日期</span><input type="date" class="input" id="f-date" value="' + h(draft.meet_date || '') + '"></label>' +
          '<label class="f"><span class="lb">开始时间</span><input type="time" class="input" id="f-start" value="' + h(draft.start_time || '') + '"></label>' +
          '<label class="f"><span class="lb">结束时间</span><input type="time" class="input" id="f-end" value="' + h(draft.end_time || '') + '"></label>' +
          '<label class="f"><span class="lb">会议地点</span><input class="input" id="f-loc" value="' + h(draft.location) + '" placeholder="如：行政楼三楼会议室"></label>' +
          '<label class="f"><span class="lb">主办 / 召集部门</span><input class="input" id="f-dept" value="' + h(draft.convene_dept) + '"></label>' +
          '<label class="f"><span class="lb">主持人</span><input class="input" id="f-host" value="' + h(draft.host) + '"></label>' +
          '<label class="f"><span class="lb">联系人及电话</span><input class="input" id="f-contact" value="' + h(draft.contact) + '"></label>' +
          '<label class="f"><span class="lb">填报截止时间</span><input type="datetime-local" class="input" id="f-deadline" value="' + h(U.toLocalInput(draft.deadline)) + '">' +
            '<span class="hint">留空表示不限制</span></label>' +
        '</div>' +
        '<label class="f"><span class="lb">会议议程 / 说明</span>' +
          '<textarea class="input" id="f-agenda" placeholder="可直接粘贴会议议程、参会要求等">' + h(draft.agenda) + '</textarea></label>' +
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
          '<button class="btn ghost sm" id="f-cat-none">清空</button>' + catAll +
        '</div>' +
        '<input class="input" id="f-psearch" placeholder="搜索姓名 / 工号 / 部门，快速单独勾选" style="margin-bottom:9px">' +
        '<div class="person-list" id="f-plist"></div>' +
        '<div class="hint">按类别勾选是「整类加入」，也可以搜索后单独挑选。' +
        '参会人名单会以快照方式存进本场会议，以后改名单不影响这场会议。</div>' +
      '</div></div>' +

      '<div class="btn-row" style="margin-top:18px">' +
        '<button class="btn lg" id="f-save">' + (isEdit ? '保存修改' : '发布会议并生成链接') + '</button>' +
        '<button class="btn ghost lg" data-go="#/meetings">取消</button>' +
      '</div>';

    S.templateId = '';   // 模板只用一次，渲染完就清掉
    return shell('new', isEdit ? '编辑会议' : '发布会议', '', body);
  }

  function bindForm(editId) {
    var isEdit = !!editId;

    function renderPeople() {
      var box = q('f-psearch');
      var kw = (box && box.value || '').trim().toLowerCase();
      var cats = availableCategories();
      function match(p) {
        if (!kw) return true;
        return (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
               (p.dept || '').toLowerCase().indexOf(kw) >= 0 ||
               (String(p.emp_no || '')).toLowerCase().indexOf(kw) >= 0;
      }
      function personRow(p) {
        var k = inviteKey(p);
        var on = !!S.selectedInvite[k];
        return '<label class="p ' + (on ? 'on' : '') + '" data-pk="' + h(k) + '">' +
          '<input type="checkbox" ' + (on ? 'checked' : '') + ' data-pbox="' + h(k) + '">' +
          '<span class="nm">' + h(p.name) + '</span>' +
          '<span class="mini" style="min-width:64px">' + h(p.emp_no || '—') + '</span>' +
          '<span class="dp">' + h(p.dept || '（部门未填）') + '</span>' +
        '</label>';
      }
      var html = cats.map(function (cat) {
        var list = rosterByCat(cat).filter(match);
        if (!list.length) return '';
        return '<div class="grp">' + h(cat) + '　<span class="mini">' + list.length + ' 人</span></div>' +
          list.map(personRow).join('');
      }).join('');

      var other = S.roster.filter(function (p) {
        return p.active !== false && (!p.category || cats.indexOf(p.category) < 0);
      }).filter(match);
      if (other.length) {
        html += '<div class="grp">未分类　<span class="mini">' + other.length + ' 人</span></div>' +
          other.map(personRow).join('');
      }
      q('f-plist').innerHTML = html || '<div class="empty">名单是空的，请先到「名单管理」导入人员</div>';

      var catBoxes = document.querySelectorAll('[data-catbox]');
      cats.forEach(function (cat) {
        var all = rosterByCat(cat);
        var cb = null;
        for (var i = 0; i < catBoxes.length; i++) {
          if (catBoxes[i].getAttribute('data-catbox') === cat) { cb = catBoxes[i]; break; }
        }
        if (!cb) return;
        var selN = all.filter(function (p) { return S.selectedInvite[inviteKey(p)]; }).length;
        cb.checked = all.length > 0 && selN === all.length;
        cb.indeterminate = selN > 0 && selN < all.length;
        var chip = cb.closest('.cat-chip');
        if (chip) chip.classList.toggle('on', selN > 0);
      });

      var n = Object.keys(S.selectedInvite).filter(function (k) { return S.selectedInvite[k]; }).length;
      var c = q('f-count');
      if (c) {
        var ps = planState();
        if (!ps.active && n > 20) {
          c.innerHTML = '已选 ' + n + ' 人 <span class="tag red">免费额度上限 20 人</span>';
        } else if (!ps.active) {
          c.innerHTML = '已选 ' + n + ' 人 <span class="tag amber">免费最多 20 人</span>';
        } else {
          c.textContent = '已选 ' + n + ' 人';
        }
      }
    }

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
      return { name: p.name, emp_no: p.emp_no || '', dept: p.dept || '', category: p.category || '', rid: p.id };
    });
    if (!invite.length) { toast('请至少选择 1 名参会人员', 'warn'); return; }
    data.invite = invite;

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
        lost.slice(0, 12).join('、') + (lost.length > 12 ? ' 等' : '') + '\n\n确定继续保存？')
        .then(function (ok) { if (ok) doSave(isEdit, editId, data); });
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
            (p.dept || '').toLowerCase().indexOf(k) < 0 &&
            (String(p.emp_no || '')).toLowerCase().indexOf(k) < 0) return false;
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
        '<td><input class="input" style="padding:4px 7px;font-size:13px;min-width:82px" data-rf="emp_no" data-rid="' + h(p.id) + '" value="' + h(p.emp_no || '') + '" placeholder="工号"></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px;font-weight:600;min-width:82px" data-rf="name" data-rid="' + h(p.id) + '" value="' + h(p.name) + '"></td>' +
        '<td>' + catSelect(p, cats) + '</td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px" data-rf="dept" data-rid="' + h(p.id) + '" value="' + h(p.dept) + '"></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px;min-width:100px" data-rf="phone" data-rid="' + h(p.id) + '" value="' + h(p.phone || '') + '"></td>' +
        '<td><input class="input" style="padding:4px 7px;font-size:13px" data-rf="note" data-rid="' + h(p.id) + '" value="' + h(p.note || '') + '"></td>' +
        '<td class="ctr"><button class="btn ghost sm" data-rdel="' + h(p.id) + '">删除</button></td>' +
      '</tr>';
    }).join('');

    var p = S.profile || {};
    var storeNote = S.mode === 'cloud'
      ? '<div class="notice ok" style="margin-bottom:14px">' +
          '当前账号：<b>' + h(p.name || '') + '</b>（工号 ' + h(p.emp_no || '—') + '）　' +
          '数据位置：<b>Supabase 云端</b>。' +
          '换电脑、换浏览器、换手机登录同一个账号，看到的都是同一份名单；其他账号看不到你的名单。</div>'
      : '<div class="notice warn" style="margin-bottom:14px">' +
          '当前是<b>本机演示模式</b>，名单只存在这台电脑的浏览器里。' +
          '接上 Supabase 后才会保存到云端。</div>';

    var qr = quotaInfo('remind'), qp = quotaInfo('promote');
    var quotaNote2 = '';
    if (qr && !qr.unlimited) {
      quotaNote2 = '<div class="notice info" style="margin-bottom:14px">' +
        '<b>免费额度：</b>复制催办文本 <b>' + qr.used + '/' + qr.limit + '</b> 次，' +
        '名单外人员一键加入名单 <b>' + (qp ? qp.used : 0) + '/' + (qp ? qp.limit : 10) + '</b> 次。' +
        '<a href="#/account">购买套餐后不限次数 →</a></div>';
    }

    var body =
      storeNote +
      quotaNote2 +
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
        '<input class="input" id="r-kw" style="width:230px" placeholder="搜索姓名 / 工号 / 部门" value="' + h(f.kw) + '">' +
        '<select class="input" id="r-cat" style="width:170px"><option value="">全部类别</option>' +
          cats.map(function (c) {
            return '<option value="' + h(c) + '"' + (f.cat === c ? ' selected' : '') + '>' + h(c) + '</option>';
          }).join('') + '</select>' +
        '<span class="hint">表格里可以直接改，改完自动保存</span>' +
        '<div class="sp" style="flex:1"></div>' +
        (selectedN ? '<button class="btn danger sm" id="r-del-sel">删除选中 ' + selectedN + ' 人</button>' : '') +
      '</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th style="width:34px"></th><th>#</th><th>工号</th><th>姓名</th><th>类别</th><th>部门</th><th>手机号</th><th>备注</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="9"><div class="empty"><span class="big">👥</span>名单是空的，点右上角「从 Excel 导入」或「写入初始 55 人名单」</div></td></tr>') +
      '</tbody></table></div></div>';

    return shell('roster', '名单管理', '', body);
  }

  function catSelect(p, cats) {
    var opts = cats.map(function (c) {
      return '<option value="' + h(c) + '"' + (c === p.category ? ' selected' : '') + '>' + h(c) + '</option>';
    }).join('');
    if (cats.indexOf(p.category) < 0 && p.category) {
      opts = '<option value="' + h(p.category) + '" selected>' + h(p.category) + '</option>' + opts;
    }
    return '<select class="input" style="padding:4px 7px;font-size:13px;min-width:110px" data-rf="category" data-rid="' + h(p.id) + '">' + opts + '</select>';
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
      var maxSort = S.roster.reduce(function (m, p) { return Math.max(m, p.sort_no || 0); }, 0);
      DB.insertRoster([{
        emp_no: '', dept: '', category: availableCategories()[0] || '处长',
        name: '新人员', phone: '', note: '', sort_no: maxSort + 1
      }]).then(function () { return refreshAll(); })
        .then(function () { toast('已新增，请在表格里修改信息', 'ok'); render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });

    var seed = q('r-seed');
    if (seed) seed.addEventListener('click', function () {
      var rows = (root.SEED_ROSTER || []).slice();
      if (!rows.length) { toast('初始名单数据缺失（config/seed.js）', 'err'); return; }
      confirmBox('将把初始 ' + rows.length + ' 人写入你的名单。\n' +
        '按「部门+类别+姓名」合并，重复不会新增。继续？').then(function (ok) {
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
        var seen = {}, uniq = [];
        rows.forEach(function (r) {
          var k = (r.dept || '') + '@@' + (r.category || '') + '@@' + r.name;
          if (seen[k]) return;
          seen[k] = 1; uniq.push(r);
        });
        var skipped = rows.length - uniq.length;
        return confirmBox('解析到 ' + uniq.length + ' 条人员记录' +
          (skipped ? '（另有 ' + skipped + ' 条重复已自动合并）' : '') + '。\n' +
          '按「部门+类别+姓名」合并：相同则更新，不同则新增。继续？').then(function (ok) {
            if (!ok) return null;
            return DB.insertRoster(uniq).then(function () { return refreshAll(); })
              .then(function () { toast('已导入 ' + uniq.length + ' 条', 'ok'); render(); });
          });
      }).catch(function (e) {
        toast('导入失败：' + String(e.message || e), 'err');
      }).then(function () { file.value = ''; });
    });

    var tpl = q('r-template');
    if (tpl) tpl.addEventListener('click', downloadRosterTemplate);

    var rex = q('r-export');
    if (rex) rex.addEventListener('click', function () {
      if (!requireExport()) return;
      MSStats.exportRoster();
    });
  }

  function importRosterFile(file) {
    var name = (file.name || '').toLowerCase();
    if (/\.csv$/.test(name)) {
      return file.text().then(function (t) { return P.rowsToRoster(X.parseCSV(t)); });
    }
    if (/\.xlsx$/.test(name)) {
      return file.arrayBuffer().then(function (buf) { return X.readXlsx(buf); })
        .then(function (grid) { return P.rowsToRoster(grid); });
    }
    return Promise.reject(new Error('只支持 .xlsx 或 .csv。若是老式 .xls，请在 Excel 里另存为 .xlsx'));
  }

  function downloadRosterTemplate() {
    var rows = [
      ['序号', '部门', '类别', '工号', '姓名', '手机号', '备注'],
      [1, '机械与动力工程学院', '办公室主任', '1001', '马超', '', ''],
      [2, '党委工作部、校长办公室', '处长', '1002', '王悦', '', ''],
      [3, '法学院', '院长', '1003', '于语和', '', ''],
      [4, '体育学院', '党总支书记', '1004', '周祥成', '', '']
    ];
    var bytes = X.buildXlsx([{ name: '人员名单', rows: rows, colWidths: [7, 30, 14, 12, 12, 16, 24] }]);
    U.download('人员名单导入模板.xlsx', new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    toast('模板已下载（工号在姓名前一列）', 'ok');
  }

  /* ============================================================
   *  二级网页（参会人填报）
   * ============================================================ */
  function viewShare(token) {
    return '<div class="share-page"><div class="share-wrap" id="share-root">' +
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>会议参会确认</h1></div>' +
      '<div class="share-card"><div class="bd"><div class="empty">正在加载会议信息…</div></div></div>' +
      '</div></div>';
  }

  function afterShare(token) {
    var box = q('share-root');
    if (!box) return;
    root.__shareState = null;
    DB.openMeeting(token).then(function (res) {
      if (!res || !res.ok) { box.innerHTML = shareError(res && res.error || '链接无效'); return; }
      root.__shareState = { token: token, data: res };
      renderShareForm();
    }).catch(function (e) {
      box.innerHTML = shareError('加载失败：' + String(e.message || e));
    });
  }

  function shareError(msg) {
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
    var st = root.__shareState;
    if (!st) return;
    var box = q('share-root');
    var m = st.data.meeting;
    var names = st.data.names || [];

    box.innerHTML =
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>' + h(m.title) + '</h1></div>' +

      '<div class="share-card"><div class="hd">📋 会议信息</div>' + meetingInfoHtml(m) +
      (m.organizer ? '<div class="bd" style="border-top:1px solid var(--line);padding-top:10px">' +
        '<span class="hint">发布人：' + h(m.organizer) + '</span></div>' : '') +
      (m.agenda ? '<div class="bd" style="border-top:1px solid var(--line)">' +
        '<div class="k" style="font-size:12px;color:#94a3b8;font-weight:600">议程 / 说明</div>' +
        '<div style="white-space:pre-wrap;margin-top:4px">' + h(m.agenda) + '</div></div>' : '') +
      '</div>' +

      (m.closed
        ? '<div class="share-card"><div class="bd"><div class="notice warn" style="margin:0">' +
          '本次参会确认已于 ' + h(U.fmtDateTime(m.deadline)) + ' 截止。' +
          '如需变更，请联系 ' + h(m.contact || '会议联系人') + '。</div></div></div>'
        : '<div class="share-card"><div class="hd">✍️ 请确认您的参会情况</div><div class="bd">' +
            '<label class="f"><span class="lb">您的工号 <span class="req">*</span></span>' +
            '<input class="input" id="s-emp" placeholder="如 1001" autocomplete="off" inputmode="text">' +
            '<span class="hint">工号用于区分同名人员，请务必填写准确。</span></label>' +
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
              '<textarea class="input" id="s-note" placeholder="如需代请假、需要准备材料等"></textarea></label>' : '') +

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
    var empInput = q('s-emp');
    var reasonWrap = q('s-reason-wrap');
    var msg = q('s-msg');

    function paintPick() {
      document.querySelectorAll('[data-pick]').forEach(function (el) {
        el.classList.toggle('on', el.getAttribute('data-pick') === picked);
      });
      reasonWrap.style.display = ((picked === 'no') && m.ask_reason !== false) ? 'block' : 'none';
    }

    document.querySelectorAll('[data-pick]').forEach(function (el) {
      el.addEventListener('click', function () {
        picked = el.getAttribute('data-pick');
        paintPick();
        msg.innerHTML = '';
      });
    });

    // 姓名或工号任一填好后，自动带出本人上次的答复
    var lastQuery = '';
    function loadMine() {
      var v = nameInput.value.trim();
      var e = empInput ? empInput.value.trim() : '';
      if (!e && v.length < 2) return;
      var sig = e + '|' + v;
      if (sig === lastQuery) return;
      lastQuery = sig;
      DB.myResponse(st.token, v, e).then(function (r) {
        if (!r || !r.ok || !r.found) return;
        picked = r.attending ? 'yes' : 'no';
        paintPick();
        if (r.reason && q('s-reason')) q('s-reason').value = r.reason;
        if (r.note && q('s-note')) q('s-note').value = r.note;
        if (v.length < 2 && r.emp_no && nameInput) nameInput.value = '';  // 姓名没填就不猜
        msg.innerHTML = '<div class="notice info" style="margin:0 0 12px">工号 ' +
          h(r.emp_no || e) + ' 之前填过：' +
          (r.attending ? '参加' : '不参加') + '（' + h(U.fmtDateTime(r.updated_at)) +
          '），可以直接修改后重新提交。</div>';
      }).catch(function () {});
    }
    nameInput.addEventListener('change', loadMine);
    if (empInput) empInput.addEventListener('change', loadMine);

    q('s-submit').addEventListener('click', function () {
      var emp = empInput ? empInput.value.trim() : '';
      var name = nameInput.value.trim();
      if (!emp) { toast('请填写您的工号（用于区分同名人员）', 'warn'); if (empInput) empInput.focus(); return; }
      if (name.length < 2) { toast('请填写您的姓名（2-20 字）', 'warn'); nameInput.focus(); return; }
      if (!picked) { toast('请选择「参加」或「不参加」', 'warn'); return; }
      var reason = q('s-reason') ? q('s-reason').value.trim() : '';
      if (picked === 'no' && m.ask_reason !== false && !reason) {
        toast('请简单填写一下不参会的原因', 'warn'); q('s-reason').focus(); return;
      }
      var note = q('s-note') ? q('s-note').value.trim() : '';
      var btn = q('s-submit');
      btn.disabled = true; btn.textContent = '正在提交…';
      DB.submitResponse(st.token, name, picked === 'yes', reason, note, emp).then(function (r) {
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
    var box = q('share-root');
    var yes = !!r.attending;
    box.innerHTML =
      '<div class="share-head"><div class="org">' + h(CFG.ORG_NAME || '') + '</div>' +
      '<h1>' + h(m.title) + '</h1></div>' +
      '<div class="share-card"><div class="bd">' +
        '<div class="done-mark">' +
          '<div class="ic">' + (yes ? '✅' : '📝') + '</div>' +
          '<div class="tt">' + (yes ? '已确认参会' : '已登记为不参会') + '</div>' +
          '<div class="ss">' + h(r.name) + '　' + h(U.fmtDateTime(r.updated_at)) + '</div>' +
        '</div>' +
        (r.on_list ? '' : '<div class="notice warn" style="margin:0 0 12px">' +
          '提示：您填写的姓名不在本次受邀名单中，工作人员会人工核对。如果名字写错了，可以点下面的按钮改。</div>') +
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

  /* ================= 对外暴露 ================= */
  root.MS = {
    state: S,
    q: q, h: h, toast: toast, shell: shell, go: go, render: render,
    queryParams: queryParams,
    promptBox: promptBox, confirmBox: confirmBox,
    refreshAll: refreshAll, refreshProfile: refreshProfile, refreshAccount: refreshAccount,
    afterLogin: afterLogin,
    planState: planState, requireExport: requireExport,
    quotaInfo: quotaInfo, loadQuota: loadQuota,
    fmtDate: function (d) { return U.fmtDate(d); },
    fmtDateWeek: function (d) { return U.fmtDateWeek(d); },
    fmtDateTime: function (d) { return U.fmtDateTime(d); }
  };

  window.addEventListener('hashchange', function () {
    if (root.__detailTimer) { clearInterval(root.__detailTimer); root.__detailTimer = null; }
    render();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
