/* ============================================================
 *  admin.js —— 超级管理员面板
 *   概览 / 用户管理 / 套餐定价 / 充值审批 / 全部会议
 *   所有权限判断都在数据库（RLS + security definer 函数），
 *   这里的 is_super 判断只用于是否显示入口。
 * ============================================================ */
(function (root) {
  'use strict';

  function MS() { return root.MS; }
  function DB() { return root.MSDB; }
  function P() { return root.MSParser; }
  function U() { return root.MSUtil; }

  function q(id) { return MS().q(id); }
  function h(s) { return MS().h(s); }
  function toast(m, t) { MS().toast(m, t); }
  function money(c) { return (Number(c || 0) / 100).toFixed(2); }

  function S() { return MS().state; }

  /* ================= 数据加载 ================= */
  function loadAdmin() {
    var S = MS().state;
    if (S.adminUsers) return Promise.resolve();
    return Promise.all([
      DB().admin.listUsers(),
      DB().admin.listAllPlans(),
      DB().admin.listRecharges(),
      DB().admin.listAllMeetings()
    ]).then(function (r) {
      S.adminUsers = r[0] || [];
      S.adminPlans = r[1] || [];
      S.adminRecharges = r[2] || [];
      S.adminMeetings = r[3] || [];
    });
  }

  function reload(part) {
    var S = MS().state;
    var jobs = [];
    if (!part || part === 'users') jobs.push(DB().admin.listUsers().then(function (x) { S.adminUsers = x || []; }));
    if (!part || part === 'plans') jobs.push(DB().admin.listAllPlans().then(function (x) { S.adminPlans = x || []; }));
    if (!part || part === 'recharges') jobs.push(DB().admin.listRecharges().then(function (x) { S.adminRecharges = x || []; }));
    if (!part || part === 'meetings') jobs.push(DB().admin.listAllMeetings().then(function (x) { S.adminMeetings = x || []; }));
    return Promise.all(jobs);
  }

  /* 切换页签时只刷新该页签的数据，避免看到过期列表 */
  function reloadByTab(tab) {
    if (tab === 'users') return reload('users');
    if (tab === 'plans') return reload('plans');
    if (tab === 'recharges') return reload('recharges');
    if (tab === 'meetings') return reload('meetings');
    return reload();
  }

  /* ================= 视图 ================= */
  function viewAdmin() {
    var tab = S().adminTab || 'overview';
    var tabs = [
      ['overview', '概览'],
      ['users', '用户管理'],
      ['plans', '套餐定价'],
      ['recharges', '充值审批'],
      ['meetings', '全部会议']
    ];
    var bar = '<div class="btn-row" style="margin-bottom:14px">' +
      tabs.map(function (t) {
        return '<button class="btn ' + (tab === t[0] ? '' : 'ghost') + ' sm" data-atab="' + t[0] + '">' +
          t[1] + (t[0] === 'recharges' && pendingCount() ? ' <span class="tag red">' + pendingCount() + '</span>' : '') +
          '</button>';
      }).join('') +
      '<span class="sp" style="flex:1"></span>' +
      '<button class="btn ghost sm" id="ad-refresh">⟳ 刷新</button>' +
      '</div>';

    var body = '';
    if (tab === 'users') body = viewUsers();
    else if (tab === 'plans') body = viewPlans();
    else if (tab === 'recharges') body = viewRecharges();
    else if (tab === 'meetings') body = viewMeetings();
    else body = viewOverview();

    return MS().shell('admin', '超级管理员', '', bar + body);
  }

  function pendingCount() {
    return (S().adminRecharges || []).filter(function (r) { return r.status === 'pending'; }).length;
  }

  function viewOverview() {
    var users = S().adminUsers || [];
    var meetings = S().adminMeetings || [];
    var plans = S().adminPlans || [];
    var recharges = S().adminRecharges || [];
    var now = Date.now();

    var activePlan = users.filter(function (u) {
      return u.plan_expires_at && new Date(u.plan_expires_at).getTime() > now;
    }).length;
    var locked = users.filter(function (u) { return u.locked; }).length;
    var supers = users.filter(function (u) { return u.is_super; }).length;
    var totalBalance = users.reduce(function (a, u) { return a + (u.balance_cents || 0); }, 0);
    var pendingAmt = recharges.filter(function (r) { return r.status === 'pending'; })
      .reduce(function (a, r) { return a + (r.amount_cents || 0); }, 0);

    var recent = meetings.slice(0, 8).map(function (m) {
      return '<tr><td>' + h(MS().fmtDate(m.meet_date) || '—') + '</td>' +
        '<td>' + h(m.title || '') + '</td>' +
        '<td>' + h(m.owner_name || '—') + (m.owner_emp_no ? '（' + h(m.owner_emp_no) + '）' : '') + '</td>' +
        '<td class="ctr">' + (m.invite || []).length + '</td></tr>';
    }).join('');

    return '' +
      '<div class="grid c3" style="margin-bottom:14px">' +
        '<div class="stat blue"><div class="n">' + users.length + '</div><div class="t">注册用户</div></div>' +
        '<div class="stat green"><div class="n">' + activePlan + '</div><div class="t">套餐有效用户</div></div>' +
        '<div class="stat"><div class="n">' + meetings.length + '</div><div class="t">全部会议</div></div>' +
        '<div class="stat amber"><div class="n">' + pendingCount() + '</div><div class="t">待审批充值（¥' + money(pendingAmt) + '）</div></div>' +
        '<div class="stat"><div class="n">¥' + money(totalBalance) + '</div><div class="t">用户余额合计</div></div>' +
        '<div class="stat ' + (locked ? 'red' : '') + '"><div class="n">' + locked + '</div><div class="t">已锁定账号</div></div>' +
        '<div class="stat"><div class="n">' + supers + '</div><div class="t">超级管理员</div></div>' +
        '<div class="stat"><div class="n">' + plans.length + '</div><div class="t">套餐数量</div></div>' +
      '</div>' +
      '<div class="card"><div class="card-h"><h2>最近发布的会议</h2></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>日期</th><th>会议名称</th><th>发布人</th><th>受邀</th>' +
        '</tr></thead><tbody>' +
          (recent || '<tr><td colspan="4"><div class="empty">还没有会议</div></td></tr>') +
        '</tbody></table></div></div>';
  }

  /* ---------------- 用户管理 ---------------- */
  function viewUsers() {
    var users = S().adminUsers || [];
    var kw = (S().adminUserKw || '').trim().toLowerCase();
    var list = !kw ? users : users.filter(function (u) {
      return (u.name || '').toLowerCase().indexOf(kw) >= 0 ||
             (u.emp_no || '').toLowerCase().indexOf(kw) >= 0 ||
             (u.email || '').toLowerCase().indexOf(kw) >= 0;
    });

    var rows = list.map(function (u) {
      var exp = u.plan_expires_at ? new Date(u.plan_expires_at) : null;
      var valid = exp && exp.getTime() > Date.now();
      return '<tr>' +
        '<td class="mini">' + h(u.emp_no) + '</td>' +
        '<td class="name">' + h(u.name) +
          (u.is_super ? ' <span class="tag dark">超管</span>' : '') +
          (u.locked ? ' <span class="tag red">已锁定</span>' : '') + '</td>' +
        '<td class="mini">' + h(u.email || '—') + '</td>' +
        '<td class="mini">' + h(u.phone || '—') + '</td>' +
        '<td class="ctr">¥' + money(u.balance_cents) + '</td>' +
        '<td>' + (valid
          ? '<span class="tag green">' + MS().fmtDate(u.plan_expires_at.slice(0, 10)) + '</span>'
          : '<span class="tag gray">未开通</span>') + '</td>' +
        '<td class="mini">' + MS().fmtDate((u.created_at || '').slice(0, 10)) + '</td>' +
        '<td class="ctr"><div class="btn-row" style="justify-content:flex-end">' +
          '<button class="btn ghost sm" data-uedit="' + h(u.id) + '">编辑</button>' +
          '<button class="btn ghost sm" data-ubal="' + h(u.id) + '">余额</button>' +
          '<button class="btn ghost sm" data-uplan="' + h(u.id) + '">套餐</button>' +
          '<button class="btn ' + (u.locked ? 'ghost' : 'danger') + ' sm" data-ulock="' + h(u.id) + '">' +
            (u.locked ? '解锁' : '锁定') + '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<input class="input" id="ad-ukw" style="width:260px" placeholder="搜索姓名 / 工号 / 邮箱" value="' + h(S().adminUserKw || '') + '">' +
        '<span class="hint">共 ' + users.length + ' 个用户</span>' +
        '<span class="sp" style="flex:1"></span>' +
        '<span class="hint">锁定后：不能发布会议、不能填报，参会链接一并暂停</span>' +
      '</div></div>' +
      '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>工号</th><th>姓名</th><th>邮箱</th><th>手机号</th><th>余额</th><th>套餐到期</th><th>注册</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="8"><div class="empty">没有匹配的用户</div></td></tr>') +
      '</tbody></table></div></div>';
  }

  /* ---------------- 套餐定价 ---------------- */
  function viewPlans() {
    var plans = S().adminPlans || [];
    var rows = plans.map(function (p) {
      return '<tr>' +
        '<td class="name">' + h(p.name) + '</td>' +
        '<td>¥' + money(p.price_cents) + '</td>' +
        '<td class="ctr">' + p.duration_days + ' 天</td>' +
        '<td class="mini">' + h(p.description || '—') + '</td>' +
        '<td>' + (p.is_active ? '<span class="tag green">在售</span>' : '<span class="tag gray">下架</span>') + '</td>' +
        '<td class="ctr"><div class="btn-row" style="justify-content:flex-end">' +
          '<button class="btn ghost sm" data-pedit="' + h(p.id) + '">编辑</button>' +
          '<button class="btn ghost sm" data-ptoggle="' + h(p.id) + '">' + (p.is_active ? '下架' : '上架') + '</button>' +
          '<button class="btn danger sm" data-pdel="' + h(p.id) + '">删除</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn" id="ad-pnew">＋ 新增套餐</button>' +
        '<span class="hint">价格与有效天数由你决定；用户用余额购买，有效期从当前到期日顺延。</span>' +
      '</div></div>' +
      '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>套餐名称</th><th>价格</th><th>有效期</th><th>说明</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="6"><div class="empty">还没有套餐，点「新增套餐」</div></td></tr>') +
      '</tbody></table></div></div>';
  }

  /* ---------------- 充值审批 ---------------- */
  function viewRecharges() {
    var list = S().adminRecharges || [];
    var filter = S().adminRechargeFilter || 'pending';
    var shown = filter === 'all' ? list : list.filter(function (r) { return r.status === filter; });

    var rows = shown.map(function (r) {
      var tag = r.status === 'approved' ? '<span class="tag green">已通过</span>'
              : r.status === 'rejected' ? '<span class="tag red">已驳回</span>'
              : '<span class="tag amber">待审批</span>';
      return '<tr>' +
        '<td class="mini">' + MS().fmtDateTime(r.created_at) + '</td>' +
        '<td>' + h(r.user_name || '—') + ' <span class="mini">' + h(r.user_emp_no || '') + '</span></td>' +
        '<td><b>¥' + money(r.amount_cents) + '</b></td>' +
        '<td>' + h(r.method || '—') + '</td>' +
        '<td class="mini">' + h(r.note || '—') + '</td>' +
        '<td>' + tag + '</td>' +
        '<td class="mini">' + h(r.review_note || '—') + '</td>' +
        '<td class="ctr">' + (r.status === 'pending'
          ? '<div class="btn-row" style="justify-content:flex-end">' +
            '<button class="btn ok sm" data-rpass="' + h(r.id) + '">通过</button>' +
            '<button class="btn danger sm" data-rrej="' + h(r.id) + '">驳回</button></div>'
          : '—') + '</td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        [['pending', '待审批'], ['approved', '已通过'], ['rejected', '已驳回'], ['all', '全部']].map(function (t) {
          return '<button class="btn ' + (filter === t[0] ? '' : 'ghost') + ' sm" data-rfilter="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
        '<span class="sp" style="flex:1"></span>' +
        '<span class="hint">点「通过」会立即把金额记入该用户余额，并生成一条账单流水</span>' +
      '</div></div>' +
      '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>申请时间</th><th>用户</th><th>金额</th><th>方式</th><th>用户备注</th><th>状态</th><th>审批备注</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="8"><div class="empty">没有记录</div></td></tr>') +
      '</tbody></table></div></div>';
  }

  /* ---------------- 全部会议 ---------------- */
  function viewMeetings() {
    var list = S().adminMeetings || [];
    var kw = (S().adminMeetingKw || '').trim().toLowerCase();
    var shown = !kw ? list : list.filter(function (m) {
      return (m.title || '').toLowerCase().indexOf(kw) >= 0 ||
             (m.owner_name || '').toLowerCase().indexOf(kw) >= 0 ||
             (m.owner_emp_no || '').toLowerCase().indexOf(kw) >= 0;
    });

    var rows = shown.map(function (m) {
      return '<tr>' +
        '<td class="mini">' + MS().fmtDate(m.meet_date) + '</td>' +
        '<td class="name">' + h(m.title || '') + '</td>' +
        '<td>' + h(m.owner_name || '—') + ' <span class="mini">' + h(m.owner_emp_no || '') + '</span>' +
          (m.owner_locked ? ' <span class="tag red">用户已锁定</span>' : '') + '</td>' +
        '<td class="mini">' + h(m.location || '—') + '</td>' +
        '<td class="ctr">' + (m.invite || []).length + '</td>' +
        '<td class="mini">' + MS().fmtDate((m.created_at || '').slice(0, 10)) + '</td>' +
        '<td class="ctr"><button class="btn ghost sm" data-ameet="' + h(m.id) + '">查看回执</button></td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<input class="input" id="ad-mkw" style="width:280px" placeholder="搜索会议名称 / 发布人 / 工号" value="' + h(S().adminMeetingKw || '') + '">' +
        '<span class="hint">共 ' + list.length + ' 场会议（所有用户）</span>' +
      '</div></div>' +
      '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>日期</th><th>会议名称</th><th>发布人</th><th>地点</th><th>受邀</th><th>发布</th><th></th>' +
      '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="7"><div class="empty">没有会议</div></td></tr>') +
      '</tbody></table></div></div>';
  }

  /* ================= 弹窗 ================= */
  function modal(html, width) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal" style="max-width:' + (width || 480) + 'px">' + html + '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) {
      var t = e.target.closest('[data-x]');
      if (t || e.target === mask) mask.remove();
    });
    return mask;
  }

  function editUser(u) {
    var mask = modal(
      '<div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">编辑用户</div>' +
      '<label class="f"><span class="lb">工号</span><input class="input" id="eu-emp" value="' + h(u.emp_no) + '"></label>' +
      '<label class="f"><span class="lb">姓名</span><input class="input" id="eu-name" value="' + h(u.name) + '"></label>' +
      '<label class="f"><span class="lb">手机号</span><input class="input" id="eu-phone" value="' + h(u.phone || '') + '"></label>' +
      '<label class="f"><span class="lb">备注（内部）</span><input class="input" id="eu-note" value="' + h(u.note || '') + '"></label>' +
      '<label class="f"><span class="lb">锁定原因</span><input class="input" id="eu-lock" value="' + h(u.locked_reason || '') + '"></label>' +
      '<label style="display:block;margin-bottom:10px"><input type="checkbox" id="eu-super" ' + (u.is_super ? 'checked' : '') + '> 设为超级管理员</label>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button><button class="btn" id="eu-save">保存</button></div>', 520);
    mask.querySelector('#eu-save').addEventListener('click', function () {
      var patch = {
        emp_no: (q('eu-emp').value || '').trim(),
        name: (q('eu-name').value || '').trim(),
        phone: (q('eu-phone').value || '').trim(),
        note: (q('eu-note').value || '').trim(),
        locked_reason: (q('eu-lock').value || '').trim(),
        is_super: q('eu-super').checked
      };
      if (!patch.name) return toast('姓名不能为空', 'warn');
      if (!patch.emp_no) return toast('工号不能为空', 'warn');
      DB().admin.updateUser(u.id, patch).then(function () {
        mask.remove(); toast('已保存', 'ok');
        return reload('users');
      }).then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });
  }

  function adjustBalance(u) {
    var mask = modal(
      '<div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">调整余额 — ' + h(u.name) + '</div>' +
      '<div class="hint">当前余额 ¥' + money(u.balance_cents) + '。填正数增加、负数扣减。</div>' +
      '<label class="f"><span class="lb">调整金额（元）</span><input class="input" id="ab-amt" placeholder="如 100 或 -50"></label>' +
      '<label class="f"><span class="lb">原因</span><input class="input" id="ab-note" placeholder="如：线下收款、赠送"></label>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button><button class="btn" id="ab-save">确定</button></div>');
    mask.querySelector('#ab-save').addEventListener('click', function () {
      var yuan = parseFloat((q('ab-amt').value || '').trim());
      if (isNaN(yuan) || yuan === 0) return toast('请输入不等于 0 的金额', 'warn');
      DB().admin.adjustBalance(u.id, Math.round(yuan * 100), q('ab-note').value || '').then(function () {
        mask.remove(); toast('余额已调整', 'ok');
        return reload('users');
      }).then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });
  }

  function grantPlan(u) {
    var plans = S().adminPlans || [];
    var opts = plans.map(function (p) {
      return '<option value="' + h(p.id) + '">' + h(p.name) + '（' + p.duration_days + ' 天）</option>';
    }).join('');
    var mask = modal(
      '<div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">开通/赠送套餐 — ' + h(u.name) + '</div>' +
      '<div class="hint">不计费，直接从当前到期日顺延。</div>' +
      '<label class="f"><span class="lb">选择套餐</span><select class="input" id="gp-plan">' + opts + '</select></label>' +
      '<label class="f"><span class="lb">或者直接填天数（优先于上面）</span>' +
        '<input class="input" id="gp-days" placeholder="如 30，留空则用套餐天数"></label>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button><button class="btn" id="gp-save">确定</button></div>');
    mask.querySelector('#gp-save').addEventListener('click', function () {
      var days = parseInt((q('gp-days').value || '').trim(), 10);
      var pid = q('gp-plan').value;
      DB().admin.grantPlan(u.id, isNaN(days) ? pid : null, isNaN(days) ? 0 : days).then(function () {
        mask.remove(); toast('套餐已开通', 'ok');
        return reload('users');
      }).then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });
  }

  function editPlan(p) {
    var isNew = !p;
    p = p || { name: '', price_cents: 0, duration_days: 30, description: '', is_active: true, sort_no: (S().adminPlans || []).length + 1 };
    var mask = modal(
      '<div class="modal-body" style="white-space:normal">' +
      '<div class="modal-title">' + (isNew ? '新增套餐' : '编辑套餐') + '</div>' +
      '<label class="f"><span class="lb">名称</span><input class="input" id="ep-name" value="' + h(p.name) + '" placeholder="如 月卡"></label>' +
      '<label class="f"><span class="lb">价格（元）</span><input class="input" id="ep-price" value="' + (p.price_cents / 100) + '" placeholder="如 99"></label>' +
      '<label class="f"><span class="lb">有效期（天）</span><input class="input" id="ep-days" value="' + p.duration_days + '" placeholder="如 30"></label>' +
      '<label class="f"><span class="lb">说明</span><input class="input" id="ep-desc" value="' + h(p.description || '') + '"></label>' +
      '<label class="f"><span class="lb">排序</span><input class="input" id="ep-sort" value="' + (p.sort_no || 0) + '"></label>' +
      '<label style="display:block"><input type="checkbox" id="ep-active" ' + (p.is_active !== false ? 'checked' : '') + '> 在售</label>' +
      '</div><div class="modal-foot">' +
      '<button class="btn ghost" data-x="0">取消</button><button class="btn" id="ep-save">保存</button></div>');
    mask.querySelector('#ep-save').addEventListener('click', function () {
      var name = (q('ep-name').value || '').trim();
      var price = parseFloat(q('ep-price').value || '0');
      var days = parseInt(q('ep-days').value || '0', 10);
      if (!name) return toast('请填写名称', 'warn');
      if (!(price >= 0)) return toast('价格不正确', 'warn');
      if (!(days > 0)) return toast('有效期必须大于 0 天', 'warn');
      var payload = {
        id: isNew ? undefined : p.id,
        name: name,
        price_cents: Math.round(price * 100),
        duration_days: days,
        description: q('ep-desc').value || '',
        is_active: q('ep-active').checked,
        sort_no: parseInt(q('ep-sort').value || '0', 10) || 0
      };
      DB().admin.savePlan(payload).then(function () {
        mask.remove(); toast('已保存', 'ok');
        return reload('plans');
      }).then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });
  }

  /* 查看任意用户的某场会议回执 */
  function viewMeetingResponses(id) {
    var m = (S().adminMeetings || []).filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    DB().listResponses(id).then(function (rs) {
      var att = P().buildAttendance(m, rs || []);
      var st = att.stats;
      var rows = P().sortRows(att.rows).map(function (r, i) {
        return '<tr><td>' + (i + 1) + '</td><td class="mini">' + h(r.emp_no || '—') + '</td>' +
          '<td>' + h(r.name) + '</td><td>' + h(r.dept || '—') + '</td>' +
          '<td>' + (r.status === 'yes' ? '<span class="tag green">参加</span>'
                    : r.status === 'no' ? '<span class="tag red">不参加</span>'
                    : '<span class="tag amber">待确认</span>') + '</td>' +
          '<td class="mini">' + h(r.reason || '—') + '</td></tr>';
      }).join('');
      var mask = modal(
        '<div class="modal-body" style="white-space:normal">' +
        '<div class="modal-title">' + h(m.title || '会议') + '</div>' +
        '<div class="hint">发布人：' + h(m.owner_name || '—') + '（' + h(m.owner_emp_no || '') + '）　' +
          h(MS().fmtDate(m.meet_date) || '') + '　' + h(m.location || '') + '</div>' +
        '<div class="btn-row" style="margin:12px 0">' +
          '<span class="tag blue">受邀 ' + st.invited + '</span>' +
          '<span class="tag green">参会 ' + st.yes + '</span>' +
          '<span class="tag red">不参会 ' + st.no + '</span>' +
          '<span class="tag amber">待确认 ' + st.pending + '</span>' +
        '</div>' +
        '<div class="tbl-wrap" style="max-height:50vh;overflow:auto"><table class="tbl"><thead><tr>' +
          '<th>#</th><th>工号</th><th>姓名</th><th>部门</th><th>状态</th><th>原因</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="6">暂无回执</td></tr>') + '</tbody></table></div>' +
        '</div><div class="modal-foot"><button class="btn" data-x="0">关闭</button></div>', 720);
      return mask;
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  /* ================= 绑定 ================= */
  function bindAdmin() {
    document.querySelectorAll('[data-atab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-atab');
        S().adminTab = t;
        MS().render();
        reloadByTab(t).then(function () { MS().render(); })
          .catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });
    var rf = q('ad-refresh');
    if (rf) rf.addEventListener('click', function () {
      S().adminUsers = null;
      loadAdmin().then(function () { MS().render(); toast('已刷新', 'ok'); });
    });

    // 首次进入：先把数据拉回来再重新渲染（否则列表是空的）
    if (!S().adminUsers) {
      loadAdmin().then(function () { MS().render(); })
        .catch(function (e) { toast('加载管理数据失败：' + String(e.message || e), 'err'); });
      return;
    }

    // 用户
    var ukw = q('ad-ukw');
    if (ukw) ukw.addEventListener('input', function () {
      S().adminUserKw = ukw.value; MS().render();
      var el = q('ad-ukw'); if (el) { el.focus(); try { el.setSelectionRange(ukw.value.length, ukw.value.length); } catch (e) {} }
    });
    function findUser(id) { return (S().adminUsers || []).filter(function (u) { return u.id === id; })[0]; }
    document.querySelectorAll('[data-uedit]').forEach(function (b) {
      b.addEventListener('click', function () { var u = findUser(b.getAttribute('data-uedit')); if (u) editUser(u); });
    });
    document.querySelectorAll('[data-ubal]').forEach(function (b) {
      b.addEventListener('click', function () { var u = findUser(b.getAttribute('data-ubal')); if (u) adjustBalance(u); });
    });
    document.querySelectorAll('[data-uplan]').forEach(function (b) {
      b.addEventListener('click', function () { var u = findUser(b.getAttribute('data-uplan')); if (u) grantPlan(u); });
    });
    document.querySelectorAll('[data-ulock]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = findUser(b.getAttribute('data-ulock'));
        if (!u) return;
        var willLock = !u.locked;
        MS().confirmBox((willLock ? '锁定' : '解锁') + '用户「' + u.name + '」？\n' +
          (willLock ? '锁定后该用户不能发布会议，其所有参会链接也会暂停接收回执。' : '解锁后恢复正常使用。'))
          .then(function (ok) {
            if (!ok) return;
            return DB().admin.updateUser(u.id, { locked: willLock, locked_reason: willLock ? (u.locked_reason || '管理员锁定') : '' });
          }).then(function (r) {
            if (r === undefined) return;
            toast(willLock ? '已锁定' : '已解锁', 'ok');
            return reload('users').then(function () { MS().render(); });
          }).catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    // 套餐
    var pn = q('ad-pnew');
    if (pn) pn.addEventListener('click', function () { editPlan(null); });
    document.querySelectorAll('[data-pedit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = (S().adminPlans || []).filter(function (x) { return x.id === b.getAttribute('data-pedit'); })[0];
        if (p) editPlan(p);
      });
    });
    document.querySelectorAll('[data-ptoggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = (S().adminPlans || []).filter(function (x) { return x.id === b.getAttribute('data-ptoggle'); })[0];
        if (!p) return;
        DB().admin.savePlan(Object.assign({}, p, { is_active: !p.is_active }))
          .then(function () { return reload('plans'); })
          .then(function () { MS().render(); toast(p.is_active ? '已下架' : '已上架', 'ok'); })
          .catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });
    document.querySelectorAll('[data-pdel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = (S().adminPlans || []).filter(function (x) { return x.id === b.getAttribute('data-pdel'); })[0];
        if (!p) return;
        MS().confirmBox('删除套餐「' + p.name + '」？\n已经购买过的用户不受影响（到期时间已记录在用户档案里）。')
          .then(function (ok) {
            if (!ok) return;
            return DB().admin.deletePlan(p.id).then(function () { return reload('plans'); })
              .then(function () { MS().render(); toast('已删除', 'ok'); });
          }).catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    // 充值
    document.querySelectorAll('[data-rfilter]').forEach(function (b) {
      b.addEventListener('click', function () {
        S().adminRechargeFilter = b.getAttribute('data-rfilter');
        MS().render();
      });
    });
    document.querySelectorAll('[data-rpass]').forEach(function (b) {
      b.addEventListener('click', function () { reviewRecharge(b.getAttribute('data-rpass'), true); });
    });
    document.querySelectorAll('[data-rrej]').forEach(function (b) {
      b.addEventListener('click', function () { reviewRecharge(b.getAttribute('data-rrej'), false); });
    });

    // 会议
    var mkw = q('ad-mkw');
    if (mkw) mkw.addEventListener('input', function () {
      S().adminMeetingKw = mkw.value; MS().render();
      var el = q('ad-mkw'); if (el) { el.focus(); try { el.setSelectionRange(mkw.value.length, mkw.value.length); } catch (e) {} }
    });
    document.querySelectorAll('[data-ameet]').forEach(function (b) {
      b.addEventListener('click', function () { viewMeetingResponses(b.getAttribute('data-ameet')); });
    });
  }

  function reviewRecharge(id, approve) {
    var note = '';
    var next = function () {
      return DB().admin.reviewRecharge(id, approve, note).then(function () {
        toast(approve ? '已通过，余额已入账' : '已驳回', 'ok');
        return reload('recharges');
      }).then(function () { return reload('users'); })
        .then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    };
    if (!approve) {
      MS().promptBox('驳回原因（用户能看到）', '').then(function (v) {
        if (v === null) return;
        note = v;
        return next();
      });
      return;
    }
    MS().confirmBox('确认通过这笔充值？金额会立即计入用户余额。').then(function (ok) {
      if (ok) return next();
    });
  }

  root.MSAdmin = {
    viewAdmin: viewAdmin, bindAdmin: bindAdmin, loadAdmin: loadAdmin, reload: reload
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
