/* ============================================================
 *  auth.js —— 登录 / 注册 / 邮箱验证 / 重置密码 / 我的账户
 *  依赖 app.js 暴露的 window.MS（q, h, toast, shell, go, S, refreshAll）
 * ============================================================ */
(function (root) {
  'use strict';

  function MS() { return root.MS; }
  function DB() { return root.MSDB; }

  function q(id) { return MS().q(id); }
  function h(s) { return MS().h(s); }
  function toast(m, t) { MS().toast(m, t); }
  function go(hash) { MS().go(hash); }

  function money(cents) {
    var n = Number(cents || 0) / 100;
    return n.toFixed(2);
  }
  function yuanToCents(v) {
    var n = parseFloat(String(v || '').replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : Math.round(n * 100);
  }

  /* 简单校验 */
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }
  function validPhone(s) { return /^1[3-9]\d{9}$/.test(String(s || '').trim()); }
  function validEmpNo(s) { return /^[A-Za-z0-9\-_.]{2,20}$/.test(String(s || '').trim()); }

  function authShell(bodyHtml) {
    var cfg = root.MS_CONFIG || {};
    var org = String(cfg.ORG_NAME || '').trim();
    var appName = String(cfg.APP_NAME || '会议系统').trim();
    // 单位名称留空时：不渲染那一行，页脚也不留多余的「·」
    var footParts = [org, appName].filter(function (x) { return x; });
    return '<div class="auth-page">' +
      '<div class="auth-box">' +
        '<div class="auth-brand">' +
          (org ? '<div class="org">' + h(org) + '</div>' : '') +
          '<h1>' + h(appName) + '</h1>' +
        '</div>' +
        bodyHtml +
      '</div>' +
      '<div class="auth-foot">' + h(footParts.join(' · ')) + '</div>' +
    '</div>';
  }

  /* ================= 登录 ================= */
  function viewLogin() {
    var qs = MS().queryParams();
    var notice = '';
    if (qs.get('confirm') === '1') {
      notice = '<div class="notice ok">邮箱验证成功，请用邮箱和密码登录。</div>';
    }
    if (MS().state.flash) {
      notice = '<div class="notice ok">' + h(MS().state.flash) + '</div>';
      MS().state.flash = '';
    }
    return authShell(
      notice +
      '<div class="auth-card">' +
        '<div class="auth-title">登录</div>' +
        '<label class="f"><span class="lb">邮箱</span>' +
          '<input class="input" id="a-email" type="email" autocomplete="username" placeholder="注册时用的邮箱"></label>' +
        '<label class="f"><span class="lb">密码</span>' +
          '<input class="input" id="a-pass" type="password" autocomplete="current-password" placeholder="密码"></label>' +
        '<div id="a-msg"></div>' +
        '<button class="btn lg" id="a-login" style="width:100%">登录</button>' +
        '<div class="auth-links">' +
          '<a href="#/register">注册新账号</a>' +
          '<a href="#/forgot">忘记密码？</a>' +
        '</div>' +
      '</div>' +
      (DB().isCloud() ? '' :
        '<div class="notice warn" style="margin-top:14px">当前是本机演示模式：没有云端数据库，' +
        '数据只存在这台电脑的浏览器里。<a href="#" id="a-demo">用演示账号进入</a></div>')
    );
  }

  function bindLogin() {
    var demo = q('a-demo');
    if (demo) demo.addEventListener('click', function (e) {
      e.preventDefault();
      DB().enterDemo().then(function () { MS().afterLogin(); });
    });

    function submit() {
      var email = (q('a-email').value || '').trim();
      var pass = q('a-pass').value || '';
      var msg = q('a-msg');
      msg.innerHTML = '';
      if (!validEmail(email)) { msg.innerHTML = '<div class="notice err">请输入正确的邮箱</div>'; return; }
      if (!pass) { msg.innerHTML = '<div class="notice err">请输入密码</div>'; return; }
      var btn = q('a-login');
      btn.disabled = true; btn.textContent = '登录中…';
      DB().auth.signIn(email, pass).then(function () {
        return MS().afterLogin();
      }).catch(function (e) {
        msg.innerHTML = '<div class="notice err">' + h(String(e.message || e)) + '</div>';
        btn.disabled = false; btn.textContent = '登录';
      });
    }
    q('a-login').addEventListener('click', submit);
    ['a-email', 'a-pass'].forEach(function (id) {
      q(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
    var em = q('a-email');
    if (em) em.focus();
  }

  /* ================= 注册 ================= */
  function viewRegister() {
    return authShell(
      '<div class="auth-card">' +
        '<div class="auth-title">注册账号</div>' +
        '<div class="hint" style="margin-bottom:14px">用工号、姓名、手机号注册。' +
        '注册后需要到邮箱点击验证链接或输入验证码完成验证。</div>' +
        '<label class="f"><span class="lb">工号 <span class="req">*</span></span>' +
          '<input class="input" id="r-emp" placeholder="如 1001" autocomplete="off"></label>' +
        '<label class="f"><span class="lb">姓名 <span class="req">*</span></span>' +
          '<input class="input" id="r-name" placeholder="真实姓名"></label>' +
        '<label class="f"><span class="lb">手机号 <span class="req">*</span></span>' +
          '<input class="input" id="r-phone" placeholder="11 位手机号" inputmode="numeric"></label>' +
        '<label class="f"><span class="lb">邮箱 <span class="req">*</span></span>' +
          '<input class="input" id="r-email" type="email" placeholder="用于接收验证码和重置密码"></label>' +
        '<label class="f"><span class="lb">密码 <span class="req">*</span></span>' +
          '<input class="input" id="r-pass" type="password" placeholder="至少 8 位，含字母和数字">' +
          '<span class="hint">建议 8 位以上，含大小写字母与数字</span></label>' +
        '<label class="f"><span class="lb">确认密码 <span class="req">*</span></span>' +
          '<input class="input" id="r-pass2" type="password" placeholder="再输一次"></label>' +
        '<div id="r-msg"></div>' +
        '<button class="btn lg" id="r-submit" style="width:100%">注册</button>' +
        '<div class="auth-links" style="justify-content:center">' +
          '<a href="#/login">已有账号？去登录</a>' +
        '</div>' +
      '</div>'
    );
  }

  function bindRegister() {
    function fail(msg) { q('r-msg').innerHTML = '<div class="notice err">' + h(msg) + '</div>'; }

    function submit() {
      var emp = (q('r-emp').value || '').trim();
      var name = (q('r-name').value || '').trim();
      var phone = (q('r-phone').value || '').trim();
      var email = (q('r-email').value || '').trim();
      var pass = q('r-pass').value || '';
      var pass2 = q('r-pass2').value || '';
      q('r-msg').innerHTML = '';

      if (!validEmpNo(emp)) return fail('工号格式不对（2-20 位字母、数字或 - _ .）');
      if (name.length < 2) return fail('请填写真实姓名');
      if (!validPhone(phone)) return fail('请输入 11 位手机号');
      if (!validEmail(email)) return fail('请输入正确的邮箱');
      if (pass.length < 8) return fail('密码至少 8 位');
      if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return fail('密码需要同时包含字母和数字');
      if (pass !== pass2) return fail('两次输入的密码不一致');

      var btn = q('r-submit');
      btn.disabled = true; btn.textContent = '正在注册…';

      DB().auth.isEmpNoTaken(emp).then(function (taken) {
        if (taken) throw new Error('工号 ' + emp + ' 已经被注册，请直接登录或联系管理员');
        return DB().auth.signUp({ empNo: emp, name: name, phone: phone, email: email, password: pass });
      }).then(function (r) {
        if (r && r.needConfirm) {
          MS().state.pendingEmail = email;
          go('#/verify');
        } else {
          MS().state.flash = '注册成功，请登录。';
          go('#/login');
        }
      }).catch(function (e) {
        fail(String(e.message || e));
        btn.disabled = false; btn.textContent = '注册';
      });
    }
    q('r-submit').addEventListener('click', submit);
  }

  /* ================= 注册邮箱验证（输验证码） ================= */
  function viewVerify() {
    var email = MS().state.pendingEmail || '';
    return authShell(
      '<div class="auth-card">' +
        '<div class="auth-title">验证邮箱</div>' +
        '<div class="notice info">验证邮件已发送到 <b>' + h(email || '你的邮箱') + '</b>。<br>' +
        '<b>请打开邮件，点里面的验证链接</b> —— 点完会自动回到本站并登录。</div>' +
        '<div class="hint" style="margin:10px 0 14px">' +
        '如果邮件里还有一个 6 位验证码，也可以填在下面；' +
        '没有配置自定义 SMTP 的项目只发链接、不发验证码，这时直接点链接即可。</div>' +
        '<label class="f"><span class="lb">邮件里的验证码（可留空）</span>' +
          '<input class="input" id="v-code" placeholder="没有验证码就不用填" inputmode="numeric" maxlength="10"></label>' +
        '<div id="v-msg"></div>' +
        '<button class="btn lg" id="v-submit" style="width:100%">完成验证</button>' +
        '<div class="auth-links">' +
          '<a href="#" id="v-resend">没收到？重新发送</a>' +
          '<a href="#/login">先去登录</a>' +
        '</div>' +
        '<div class="hint" style="margin-top:12px">如果你用的是 Supabase 自带邮件服务，' +
        '每小时只能发几封，且可能进垃圾箱；也请检查「垃圾邮件」文件夹。</div>' +
      '</div>'
    );
  }

  function bindVerify() {
    function msg(html) { q('v-msg').innerHTML = html; }
    q('v-submit').addEventListener('click', function () {
      var code = (q('v-code').value || '').trim();
      var email = MS().state.pendingEmail || '';
      if (!code) return msg('<div class="notice err">请填写验证码</div>');
      var btn = q('v-submit');
      btn.disabled = true; btn.textContent = '验证中…';
      DB().auth.verifySignupCode(email, code).then(function () {
        MS().state.flash = '邮箱验证成功，请登录。';
        MS().state.pendingEmail = '';
        go('#/login');
      }).catch(function (e) {
        msg('<div class="notice err">' + h(String(e.message || e)) + '</div>');
        btn.disabled = false; btn.textContent = '完成验证';
      });
    });
    q('v-resend').addEventListener('click', function (e) {
      e.preventDefault();
      var email = MS().state.pendingEmail || '';
      if (!email) return msg('<div class="notice err">请先回到注册页重新注册</div>');
      DB().auth.resendConfirm(email).then(function () {
        toast('验证邮件已重新发送', 'ok');
      }).catch(function (err) {
        msg('<div class="notice err">' + h(String(err.message || err)) + '</div>');
      });
    });
  }

  /* ================= 忘记密码：发送验证码 ================= */
  function viewForgot() {
    return authShell(
      '<div class="auth-card">' +
        '<div class="auth-title">重置密码</div>' +
        '<div class="hint" style="margin-bottom:14px">输入注册时用的邮箱，我们会发一封带 6 位验证码的邮件。</div>' +
        '<label class="f"><span class="lb">邮箱</span>' +
          '<input class="input" id="f-email" type="email" placeholder="注册时用的邮箱"></label>' +
        '<div id="f-msg"></div>' +
        '<button class="btn lg" id="f-send" style="width:100%">发送验证码</button>' +
        '<div class="auth-links" style="justify-content:center"><a href="#/login">返回登录</a></div>' +
      '</div>'
    );
  }

  function bindForgot() {
    function msg(html) { q('f-msg').innerHTML = html; }
    q('f-send').addEventListener('click', function () {
      var email = (q('f-email').value || '').trim();
      if (!validEmail(email)) return msg('<div class="notice err">请输入正确的邮箱</div>');
      var btn = q('f-send');
      btn.disabled = true; btn.textContent = '发送中…';
      DB().auth.sendResetCode(email).then(function (r) {
        MS().state.resetEmail = email;
        if (r && r.demoCode) {
          msg('<div class="notice warn">本机演示模式不发邮件。你的验证码是 <b>' +
              h(r.demoCode) + '</b></div>');
        } else {
          msg('<div class="notice ok">验证码已发送，请查收邮件（含垃圾箱）。</div>');
        }
        btn.textContent = '重新发送';
        btn.disabled = false;
        setTimeout(function () { go('#/reset'); }, r && r.demoCode ? 1200 : 900);
      }).catch(function (e) {
        msg('<div class="notice err">' + h(String(e.message || e)) + '</div>');
        btn.disabled = false; btn.textContent = '发送验证码';
      });
    });
    var em = q('f-email');
    if (MS().state.resetEmail) em.value = MS().state.resetEmail;
    em.addEventListener('keydown', function (e) { if (e.key === 'Enter') q('f-send').click(); });
    em.focus();
  }

  /* ================= 重置密码：输验证码 + 新密码 ================= */
  function viewReset() {
    var S = MS().state;
    var linkMode = !!S.recoveryMode;      // 从邮件链接进来：已持有临时会话，不用再输验证码
    var invalid = !!S.recoveryInvalid;    // 链接失效 / 在别的浏览器打开过

    if (invalid) {
      return authShell(
        '<div class="auth-card">' +
          '<div class="auth-title">重置链接已失效</div>' +
          '<div class="notice warn">' +
            '这个重置链接已经过期，或者是在另一台设备/浏览器里打开的（链接只能用一次）。' +
            (S.linkError ? '<br>系统提示：' + h(S.linkError) : '') +
          '</div>' +
          '<div class="btn-row" style="margin-top:6px">' +
            '<a class="btn lg" href="#/forgot" style="width:100%;justify-content:center">重新发送重置邮件</a>' +
          '</div>' +
          '<div class="auth-links" style="justify-content:center"><a href="#/login">返回登录</a></div>' +
        '</div>'
      );
    }

    return authShell(
      '<div class="auth-card">' +
        '<div class="auth-title">设置新密码</div>' +
        (linkMode
          ? '<div class="notice info">你已通过邮件链接验证身份，直接设置新密码即可。</div>'
          : '<label class="f"><span class="lb">邮箱</span>' +
            '<input class="input" id="x-email" type="email" value="' + h(S.resetEmail || '') + '"></label>' +
            '<label class="f"><span class="lb">邮件里的 6 位验证码</span>' +
            '<input class="input" id="x-code" placeholder="6 位数字" inputmode="numeric" maxlength="10"></label>' +
            '<div class="hint" style="margin:-6px 0 12px">只有配置了自定义 SMTP 的项目，邮件里才会显示验证码；' +
            '否则请直接点邮件里的链接。</div>') +
        '<label class="f"><span class="lb">新密码</span>' +
          '<input class="input" id="x-pass" type="password" placeholder="至少 8 位，含字母和数字"></label>' +
        '<label class="f"><span class="lb">确认新密码</span>' +
          '<input class="input" id="x-pass2" type="password"></label>' +
        '<div id="x-msg"></div>' +
        '<button class="btn lg" id="x-submit" style="width:100%">保存新密码</button>' +
        '<div class="auth-links">' +
          (linkMode ? '' : '<a href="#/forgot">重新发送验证码</a>') +
          '<a href="#/login">返回登录</a>' +
        '</div>' +
      '</div>'
    );
  }

  function bindReset() {
    var linkMode = !!MS().state.recoveryMode;
    function msg(html) { q('x-msg').innerHTML = html; }
    q('x-submit').addEventListener('click', function () {
      var email = linkMode ? '' : (q('x-email').value || '').trim();
      var code = linkMode ? '' : (q('x-code').value || '').trim();
      var pass = q('x-pass').value || '';
      var pass2 = q('x-pass2').value || '';
      if (!linkMode) {
        if (!validEmail(email)) return msg('<div class="notice err">请输入正确的邮箱</div>');
        if (!code) return msg('<div class="notice err">请填写验证码（或直接点邮件里的链接）</div>');
      }
      if (pass.length < 8) return msg('<div class="notice err">密码至少 8 位</div>');
      if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return msg('<div class="notice err">密码需要同时包含字母和数字</div>');
      if (pass !== pass2) return msg('<div class="notice err">两次输入的密码不一致</div>');

      var btn = q('x-submit');
      btn.disabled = true; btn.textContent = '保存中…';
      Promise.resolve()
        .then(function () {
          if (linkMode) return null;
          return DB().auth.verifyRecoveryCode(email, code);
        })
        .then(function () { return DB().auth.updatePassword(pass); })
        .then(function () {
          MS().state.flash = '密码已重置，请用新密码登录。';
          MS().state.resetEmail = '';
          MS().state.recoveryMode = false;
          MS().state.recoveryInvalid = false;
          // 链接模式下此时是"已登录"状态，先退出，让用户用新密码重新登录
          if (linkMode) return DB().auth.signOut();
          return null;
        })
        .then(function () {
          MS().state.ready = false;
          if (MS().state.profile) MS().state.profile = null;
          go('#/login');
          MS().render();
        }).catch(function (e) {
          msg('<div class="notice err">' + h(String(e.message || e)) + '</div>');
          btn.disabled = false; btn.textContent = '保存新密码';
        });
    });
  }

  /* ================= 我的账户 ================= */
  function viewAccount() {
    var S = MS().state;
    var p = S.profile || {};
    var plans = S.plans || [];
    var expires = p.plan_expires_at ? new Date(p.plan_expires_at) : null;
    var planValid = expires && expires.getTime() > Date.now();
    var daysLeft = planValid ? Math.ceil((expires.getTime() - Date.now()) / 86400000) : 0;

    var planCards = plans.map(function (pl) {
      return '<div class="plan-card">' +
        '<div class="pl-name">' + h(pl.name) + '</div>' +
        '<div class="pl-price">¥' + money(pl.price_cents) + '</div>' +
        '<div class="pl-days">' + pl.duration_days + ' 天</div>' +
        '<div class="pl-desc">' + h(pl.description || '') + '</div>' +
        '<button class="btn sm" data-buy="' + h(pl.id) + '">购买</button>' +
      '</div>';
    }).join('') || '<div class="empty">管理员还没有设置套餐</div>';

    var ps = { active: p.is_super || (expires && expires.getTime() > Date.now()) };
    var quotaNote = ps.active ? '' :
      '<div class="notice warn" style="margin-top:12px"><b>你当前是免费额度：</b>' +
      '最多发布 <b>1 场</b>会议、单场最多邀请 <b>20 人</b>，且<b>不能导出</b>。' +
      '购买任意套餐即可解除限制。</div>';

    /* ---- 会员 / 非会员 权益对比 ---- */
    var isMember = ps.active;
    var myMeetingCount = (MS().state.meetings || []).filter(function (x) {
      return x.owner_id === p.id;
    }).length;
    var qi = MS().quotaInfo || function () { return null; };
    var qr = qi('remind'), qp = qi('promote');
    var usedRemind = qr ? qr.used : (p.quota_remind_used || 0);
    var usedPromote = qp ? qp.used : (p.quota_promote_used || 0);

    var BENEFITS = [
      ['发布会议', '最多 <b>1 场</b>（已用 ' + myMeetingCount + ' 场）', '不限场次', true],
      ['单场邀请人数', '最多 <b>20 人</b>', '不限人数', true],
      ['复制催办文本', '<b>10 次</b>（已用 ' + usedRemind + ' 次）', '不限次数', true],
      ['名单外人员一键加入名单', '<b>10 次</b>（已用 ' + usedPromote + ' 次）', '不限次数', true],
      ['导出会议明细 / 统计 / 名单', '❌ 不可用', '✅ 可导出', true],
      ['查看统计（按会议 / 按人员）', '✅ 可用', '✅ 可用', false],
      ['维护名单（增删改 + Excel 导入）', '✅ 可用', '✅ 可用', false],
      ['用历史会议作模板新建', '✅ 可用（受 1 场限制）', '✅ 可用', false],
      ['参会链接与回执', '✅ 正常', '✅ 正常', false],
      ['数据保留', '长期保留', '长期保留', false]
    ];

    var cmpRows = BENEFITS.map(function (b) {
      var diff = b[3];
      return '<tr' + (diff ? ' class="cmp-diff"' : '') + '>' +
        '<td>' + b[0] + (diff ? ' <span class="tag amber">差异</span>' : '') + '</td>' +
        '<td class="ctr' + (!isMember ? ' cmp-current' : '') + '">' + b[1] + '</td>' +
        '<td class="ctr' + (isMember ? ' cmp-current' : '') + '">' + b[2] + '</td>' +
      '</tr>';
    }).join('');

    var previewSw = '';
    if (p.is_super) {
      previewSw = '<div class="notice ' + (p.preview_member ? 'warn' : 'info') + '" style="margin-bottom:14px">' +
        '<label style="display:flex;gap:8px;align-items:center;cursor:pointer">' +
          '<input type="checkbox" id="ac-preview" ' + (p.preview_member ? 'checked' : '') + '>' +
          '<span><b>以普通会员身份预览</b>　' +
          (p.preview_member
            ? '当前按你的真实套餐计算额度（' + (ps.active ? '会员有效' : '免费额度') + '）'
            : '当前是超管，不受任何额度限制') +
          '</span>' +
        '</label>' +
        '<div class="hint" style="margin-top:6px">勾选后可真实体验"免费用户/会员"的额度限制；' +
        '看别人数据的管理权限不受影响。</div>' +
      '</div>';
    }

    var statusChip = p.is_super
      ? '<span class="tag dark">超级管理员 · 不受额度限制</span>'
      : (isMember
        ? '<span class="tag green">会员 · 剩余 ' + daysLeft + ' 天</span>'
        : '<span class="tag amber">免费额度</span>');

    var cmpCard =
      '<div class="card" style="margin-bottom:14px">' +
        '<div class="card-h"><h2>会员权益对比</h2>' + statusChip +
          '<span class="sp" style="flex:1"></span>' +
          (isMember ? '' : '<button class="btn sm" id="ac-goto-plans">去购买套餐</button>') +
        '</div>' +
        '<div class="tbl-wrap"><table class="tbl cmp-table">' +
          '<thead><tr>' +
            '<th>功能</th>' +
            '<th class="ctr' + (!isMember ? ' cmp-head-current' : '') + '">免费额度</th>' +
            '<th class="ctr' + (isMember ? ' cmp-head-current' : '') + '">会员</th>' +
          '</tr></thead><tbody>' + cmpRows + '</tbody>' +
        '</table></div>' +
        '<div class="card-b" style="border-top:1px solid var(--line)">' +
          '<div class="hint">高亮的那一列是你**当前**的权益。' +
          (isMember ? '' : '购买任意套餐后，上表「差异」项立即解锁，有效期从当前到期日顺延。') +
          '</div>' +
        '</div>' +
      '</div>';

    var rechargeList = (S.myRecharges || []).map(function (r) {
      var tag = r.status === 'approved' ? '<span class="tag green">已通过</span>'
              : r.status === 'rejected' ? '<span class="tag red">已驳回</span>'
              : '<span class="tag amber">待审批</span>';
      return '<tr><td>' + MS().fmtDateTime(r.created_at) + '</td>' +
        '<td>¥' + money(r.amount_cents) + '</td><td>' + h(r.method || '—') + '</td>' +
        '<td>' + tag + '</td><td class="mini">' + h(r.review_note || '') + '</td></tr>';
    }).join('');

    var walletRows = (S.walletLogs || []).map(function (w) {
      var sign = w.delta_cents > 0 ? '+' : '';
      var cls = w.delta_cents > 0 ? 'green' : 'red';
      return '<tr><td>' + MS().fmtDateTime(w.created_at) + '</td>' +
        '<td><span class="tag ' + cls + '">' + sign + '¥' + money(w.delta_cents) + '</span></td>' +
        '<td>¥' + money(w.balance_after) + '</td><td class="mini">' + h(w.note || '') + '</td></tr>';
    }).join('');

    var body =
      '<div class="grid c2" style="margin-bottom:14px">' +
        '<div class="card"><div class="card-h"><h2>账号资料</h2></div><div class="card-b">' +
          '<div class="kv-list">' +
            '<div class="kv"><div class="k">工号</div><div class="v">' + h(p.emp_no || '—') + '</div></div>' +
            '<div class="kv"><div class="k">邮箱</div><div class="v">' + h(p.email || '—') + '</div></div>' +
          '</div>' +
          '<label class="f" style="margin-top:14px"><span class="lb">姓名</span>' +
            '<input class="input" id="ac-name" value="' + h(p.name || '') + '"></label>' +
          '<label class="f"><span class="lb">手机号</span>' +
            '<input class="input" id="ac-phone" value="' + h(p.phone || '') + '"></label>' +
          '<div class="btn-row"><button class="btn sm" id="ac-save">保存资料</button>' +
          '<button class="btn ghost sm" id="ac-pass">修改密码</button></div>' +
          (p.locked ? '<div class="notice err" style="margin-top:12px">账号已被锁定：' +
            h(p.locked_reason || '请联系管理员') + '</div>' : '') +
        '</div></div>' +
        '<div class="card"><div class="card-h"><h2>套餐与余额</h2></div><div class="card-b">' +
          '<div class="grid c2" style="grid-template-columns:1fr 1fr;margin-bottom:14px">' +
            '<div class="stat ' + (planValid ? 'green' : 'amber') + '">' +
              '<div class="n" style="font-size:20px">' + (p.is_super ? '不限' : (planValid ? '有效' : '未开通')) + '</div>' +
              '<div class="t">' + (p.is_super ? '超级管理员' :
                (planValid ? '剩余 ' + daysLeft + ' 天（至 ' + MS().fmtDate(expires.toISOString().slice(0, 10)) + '）'
                           : '套餐未开通或已过期')) + '</div>' +
            '</div>' +
            '<div class="stat blue"><div class="n" style="font-size:20px">¥' + money(p.balance_cents) + '</div>' +
              '<div class="t">账户余额</div></div>' +
          '</div>' +
          '<div class="btn-row"><button class="btn sm" id="ac-recharge">申请充值</button>' +
          '<button class="btn ghost sm" id="ac-refresh">刷新</button></div>' +
          quotaNote +
          '<div class="hint" style="margin-top:10px">充值流程：提交申请 → 超级管理员核对到账后审批 → 余额到账。' +
          '目前未接在线支付。</div>' +
        '</div></div>' +
      '</div>' +

      cmpCard +

      '<div class="card" id="ac-plans" style="margin-bottom:14px"><div class="card-h"><h2>套餐</h2>' +
        '<span class="hint">购买后有效期从当前到期日顺延</span></div>' +
        '<div class="card-b"><div class="plan-grid">' + planCards + '</div></div></div>' +

      '<div class="grid c2">' +
        '<div class="card"><div class="card-h"><h2>我的充值申请</h2></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
            '<th>申请时间</th><th>金额</th><th>方式</th><th>状态</th><th>审批备注</th>' +
          '</tr></thead><tbody>' +
            (rechargeList || '<tr><td colspan="5"><div class="empty">还没有充值申请</div></td></tr>') +
          '</tbody></table></div></div>' +
        '<div class="card"><div class="card-h"><h2>账单流水</h2></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
            '<th>时间</th><th>变动</th><th>余额</th><th>说明</th>' +
          '</tr></thead><tbody>' +
            (walletRows || '<tr><td colspan="4"><div class="empty">暂无流水</div></td></tr>') +
          '</tbody></table></div></div>' +
      '</div>';

    return MS().shell('account', '我的账户', '<button class="btn ghost sm" data-go="#/meetings">返回看板</button>', body);
  }

  function bindAccount() {
    q('ac-save').addEventListener('click', function () {
      var name = (q('ac-name').value || '').trim();
      var phone = (q('ac-phone').value || '').trim();
      if (name.length < 2) return toast('请填写真实姓名', 'warn');
      if (phone && !validPhone(phone)) return toast('手机号格式不对', 'warn');
      DB().updateMyProfile(name, phone).then(function () {
        toast('资料已保存', 'ok');
        return MS().refreshProfile();
      }).then(function () { MS().render(); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });

    q('ac-pass').addEventListener('click', function () {
      MS().promptBox('设置新密码（至少 8 位，含字母和数字）', '').then(function (v) {
        if (!v) return;
        if (v.length < 8) return toast('密码至少 8 位', 'warn');
        if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return toast('密码需要同时包含字母和数字', 'warn');
        DB().auth.updatePassword(v).then(function () { toast('密码已修改', 'ok'); })
          .catch(function (e) { toast(String(e.message || e), 'err'); });
      });
    });

    document.querySelectorAll('[data-buy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var pid = b.getAttribute('data-buy');
        var p = (MS().state.plans || []).filter(function (x) { return x.id === pid; })[0];
        if (!p) return;
        MS().confirmBox('确认购买「' + p.name + '」？\n价格 ¥' + money(p.price_cents) +
          '，有效期 ' + p.duration_days + ' 天\n当前余额 ¥' + money((MS().state.profile || {}).balance_cents)).then(function (ok) {
          if (!ok) return;
          b.disabled = true;
          DB().purchasePlan(pid).then(function () {
            toast('购买成功，套餐已生效', 'ok');
            return MS().refreshProfile();
          }).then(function () {
            return MS().refreshAccount();
          }).then(function () { MS().render(); })
            .catch(function (e) { toast(String(e.message || e), 'err'); b.disabled = false; });
        });
      });
    });

    q('ac-recharge').addEventListener('click', function () {
      var mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal" style="max-width:420px">' +
        '<div class="modal-body" style="white-space:normal">' +
        '<div class="modal-title">申请充值</div>' +
        '<label class="f"><span class="lb">充值金额（元）</span>' +
          '<input class="input" id="rc-amount" placeholder="如 100" inputmode="decimal"></label>' +
        '<label class="f"><span class="lb">到账方式</span>' +
          '<select class="input" id="rc-method">' +
            '<option value="微信">微信转账</option>' +
            '<option value="支付宝">支付宝转账</option>' +
            '<option value="银行转账">银行转账</option>' +
            '<option value="现金">现金</option>' +
            '<option value="其他">其他</option>' +
          '</select></label>' +
        '<label class="f"><span class="lb">说明（选填）</span>' +
          '<input class="input" id="rc-note" placeholder="如：转账单号后四位、备注姓名"></label>' +
        '<div id="rc-msg"></div>' +
        '</div><div class="modal-foot">' +
          '<button class="btn ghost" data-x="0">取消</button>' +
          '<button class="btn" data-x="1">提交申请</button></div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) {
        var t = e.target.closest('[data-x]');
        if (!t && e.target !== mask) return;
        if (!t || t.getAttribute('data-x') === '0') { mask.remove(); return; }
        var cents = yuanToCents(q('rc-amount').value);
        if (cents <= 0) { q('rc-msg').innerHTML = '<div class="notice err">请输入充值金额</div>'; return; }
        DB().requestRecharge(cents, q('rc-method').value, q('rc-note').value).then(function () {
          mask.remove();
          toast('充值申请已提交，等待管理员审批', 'ok');
          return MS().refreshAccount();
        }).then(function () { MS().render(); })
          .catch(function (err) {
            q('rc-msg').innerHTML = '<div class="notice err">' + h(String(err.message || err)) + '</div>';
          });
      });
    });

    q('ac-refresh').addEventListener('click', function () {
      MS().refreshProfile().then(function () { return MS().refreshAccount(); })
        .then(function () { MS().render(); toast('已刷新', 'ok'); })
        .catch(function (e) { toast(String(e.message || e), 'err'); });
    });

    var pv = q('ac-preview');
    if (pv) pv.addEventListener('change', function () {
      pv.disabled = true;
      DB.setPreviewMode(pv.checked).then(function () {
        return MS().refreshProfile();
      }).then(function () {
        return MS().loadQuota();
      }).then(function () { MS().render(); toast(pv.checked ? '已切换为普通会员身份' : '已恢复管理员身份', 'ok'); })
        .catch(function (e) { pv.disabled = false; toast(String(e.message || e), 'err'); });
    });

    var gotoPlans = q('ac-goto-plans');
    if (gotoPlans) gotoPlans.addEventListener('click', function () {
      var box = q('ac-plans');
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  root.MSAuth = {
    viewLogin: viewLogin, bindLogin: bindLogin,
    viewRegister: viewRegister, bindRegister: bindRegister,
    viewVerify: viewVerify, bindVerify: bindVerify,
    viewForgot: viewForgot, bindForgot: bindForgot,
    viewReset: viewReset, bindReset: bindReset,
    viewAccount: viewAccount, bindAccount: bindAccount,
    money: money, yuanToCents: yuanToCents,
    validEmail: validEmail, validPhone: validPhone, validEmpNo: validEmpNo
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
