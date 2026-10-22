/* ============================================================
 *  db.js —— 数据访问层（v2 多用户版）
 *
 *  · 首选：Supabase 云端（Auth 登录 + RLS 按用户隔离）
 *  · 退路：本机演示模式（localStorage，单用户，用于离线试用与自检）
 *
 *  所有敏感操作（改档案、买套餐、充值、超管操作）都走数据库函数，
 *  不在前端做权限判断 —— 前端算出来的结果一律不可信。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MSDB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LS_KEY = 'ms_local_db_v2';

  function cfg() { return (typeof window !== 'undefined' && window.MS_CONFIG) || {}; }

  /* ================= 地址规范化与配置体检 ================= */
  function normUrl(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    var guard = 0;
    while (/^https?:\/\//i.test(u) && guard++ < 5) u = u.replace(/^https?:\/\//i, '');
    u = u.replace(/\/+$/, '').replace(/\/rest(\/v\d+)?$/i, '');
    u = u.replace(/\/+$/, '').trim();
    return u ? 'https://' + u : '';
  }

  function configCheck() {
    var c = cfg();
    var rawUrl = String(c.SUPABASE_URL || '');
    var url = normUrl(rawUrl);
    var key = String(c.SUPABASE_ANON_KEY || '').trim();
    return {
      url: url,
      urlOk: /^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+$/i.test(url) && url.indexOf('supabase') > 0,
      urlRaw: rawUrl,
      urlChanged: !!url && url !== rawUrl.trim(),
      key: key,
      keyOk: key.length > 40 && key.indexOf('在这里') < 0
    };
  }

  function isCloud() {
    var r = configCheck();
    return !!(r.urlOk && r.keyOk);
  }

  /* ================= Supabase 客户端 ================= */
  var _client = null;
  function client() {
    if (!isCloud()) throw new Error('尚未配置 Supabase（请编辑 config/config.js）');
    if (_client) return _client;
    var r = configCheck();
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      throw new Error('Supabase 客户端库没加载成功（cdn.jsdelivr.net 被拦截或断网），请检查网络后刷新');
    }
    _client = window.supabase.createClient(r.url, r.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // 用 implicit 而不是 pkce：邮件里的链接可以直接在任意浏览器/手机上打开。
        // pkce 会把 code_verifier 存在"发起请求的那台浏览器"里，
        // 用户在电脑上申请、用手机点开邮件就会失败 —— 学校场景里这太常见了。
        flowType: 'implicit',
        storageKey: 'ms_auth_token'
      }
    });
    return _client;
  }

  /* ================= 本机演示存储 ================= */
  function readLocal() {
    var empty = { meetings: [], responses: [], roster: [], profile: null, plans: [], wallet: [], recharges: [], users: [] };
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return empty;
      var d = JSON.parse(raw);
      return Object.assign(empty, d);
    } catch (e) {
      return empty;
    }
  }
  function writeLocal(db) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    catch (e) { throw new Error('本机存储写入失败（可能空间不足或处于隐私模式）'); }
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0;
      return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function randToken(len) {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789', out = '';
    for (var i = 0; i < (len || 12); i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  function nowISO() { return new Date().toISOString(); }

  function localPlans() {
    var db = readLocal();
    if (!db.plans.length) {
      db.plans = [
        { id: 'plan-month', name: '月卡', price_cents: 9900, duration_days: 30, description: '有效期内发布会议不限场次', is_active: true, sort_no: 1 },
        { id: 'plan-quarter', name: '季卡', price_cents: 26800, duration_days: 90, description: '比月卡更划算', is_active: true, sort_no: 2 },
        { id: 'plan-year', name: '年卡', price_cents: 89900, duration_days: 365, description: '一年内不限场次', is_active: true, sort_no: 3 }
      ];
      writeLocal(db);
    }
    return db.plans;
  }

  /* ================= 错误翻译 ================= */
  function humanError(msg) {
    var m = String(msg || '');
    if (/Invalid login credentials/i.test(m)) return '邮箱或密码不正确';
    if (/Email not confirmed/i.test(m)) return '邮箱还没验证，请先到邮箱点击验证链接，或输入邮件里的验证码';
    if (/User already registered/i.test(m)) return '这个邮箱已经注册过了，请直接登录';
    if (/Password should be at least/i.test(m)) return '密码太短，至少 6 位';
    if (/rate limit|too many requests|email rate limit/i.test(m)) return '邮件发送太频繁，请稍后再试（可在 Supabase 配置自定义 SMTP 提升额度）';
    if (/套餐未开通|套餐已过期/.test(m)) return m;
    if (/账号已被锁定/.test(m)) return m;
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(m)) {
      return '无法连接服务器，请检查网络或稍后再试（原始错误：' + m + '）';
    }
    return m;
  }

  function unwrap(res, what) {
    if (res && res.error) throw new Error(humanError(res.error.message || String(res.error)));
    return res ? res.data : null;
  }

  /* ================= 认证 ================= */
  function redirectTo(params) {
    var base = location.origin + location.pathname;
    var q = new URLSearchParams(params || {}).toString();
    return base + (q ? '?' + q : '');
  }

  var auth = {
    /* 当前会话；本机演示模式返回假会话 */
    getSession: function () {
      if (!isCloud()) {
        var db = readLocal();
        if (!db.profile) return Promise.resolve(null);
        return Promise.resolve({ user: { id: db.profile.id, email: db.profile.email } });
      }
      return client().auth.getSession().then(function (r) {
        if (r.error) return null;
        return r.data ? r.data.session : null;
      });
    },

    signUp: function (info) {
      if (!isCloud()) {
        var db = readLocal();
        if (db.users.some(function (u) { return u.email === info.email; })) {
          return Promise.reject(new Error('这个邮箱已经注册过了，请直接登录'));
        }
        if (db.users.some(function (u) { return u.emp_no === info.empNo; })) {
          return Promise.reject(new Error('工号 ' + info.empNo + ' 已经被注册'));
        }
        db.users.push({
          id: uuid(), emp_no: info.empNo, name: info.name, phone: info.phone,
          email: info.email, password: info.password, is_super: db.users.length === 0,
          locked: false, locked_reason: '', balance_cents: 0, plan_id: null, plan_expires_at: null,
          created_at: nowISO()
        });
        writeLocal(db);
        return Promise.resolve({ needConfirm: false });
      }
      return client().auth.signUp({
        email: info.email,
        password: info.password,
        options: {
          data: { emp_no: info.empNo, name: info.name, phone: info.phone },
          emailRedirectTo: redirectTo({ goto: 'login', confirm: '1' })
        }
      }).then(function (r) {
        if (r.error) throw new Error(humanError(r.error.message));
        return { needConfirm: !(r.data && r.data.session) };
      });
    },

    signIn: function (email, password) {
      if (!isCloud()) {
        var db = readLocal();
        var u = db.users.filter(function (x) { return x.email === email; })[0];
        if (!u || u.password !== password) return Promise.reject(new Error('邮箱或密码不正确'));
        if (u.locked) return Promise.reject(new Error('账号已被锁定，请联系管理员'));
        db.profile = u;
        writeLocal(db);
        return Promise.resolve({ user: u });
      }
      return client().auth.signInWithPassword({ email: email, password: password })
        .then(function (r) {
          if (r.error) throw new Error(humanError(r.error.message));
          return r.data;
        });
    },

    signOut: function () {
      if (!isCloud()) {
        var db = readLocal();
        db.profile = null;
        writeLocal(db);
        return Promise.resolve();
      }
      return client().auth.signOut();
    },

    getProfile: function () {
      if (!isCloud()) return Promise.resolve(readLocal().profile);
      return client().auth.getUser().then(function (r) {
        if (r.error || !r.data || !r.data.user) return null;
        return client().from('profiles').select('*').eq('id', r.data.user.id).maybeSingle()
          .then(function (res) {
            if (res.error) throw new Error(humanError(res.error.message));
            return res.data;
          });
      });
    },

    isEmpNoTaken: function (empNo) {
      if (!isCloud()) {
        var db = readLocal();
        return Promise.resolve(db.users.some(function (u) { return u.emp_no === empNo; }));
      }
      return client().rpc('is_emp_no_taken', { p_emp_no: empNo })
        .then(function (r) { return r.error ? false : !!r.data; });
    },

    /* 发送重置密码邮件（邮件里是 6 位验证码，也可能带链接） */
    sendResetCode: function (email) {
      if (!isCloud()) {
        var db = readLocal();
        var u = db.users.filter(function (x) { return x.email === email; })[0];
        if (!u) return Promise.reject(new Error('该邮箱还没有注册'));
        u._reset = String(Math.floor(100000 + Math.random() * 900000));
        writeLocal(db);
        if (typeof console !== 'undefined') console.log('[本机演示] 重置验证码：', u._reset);
        return Promise.resolve({ demoCode: u._reset });
      }
      return client().auth.resetPasswordForEmail(email, {
        redirectTo: redirectTo({ goto: 'reset' })
      }).then(function (r) {
        if (r.error) throw new Error(humanError(r.error.message));
        return { ok: true };
      });
    },

    /* 用邮件里的 6 位码换取可改密码的会话 */
    verifyRecoveryCode: function (email, token) {
      if (!isCloud()) {
        var db = readLocal();
        var u = db.users.filter(function (x) { return x.email === email; })[0];
        if (!u) return Promise.reject(new Error('该邮箱还没有注册'));
        if (!u._reset || u._reset !== String(token).trim()) {
          return Promise.reject(new Error('验证码不正确或已过期'));
        }
        return Promise.resolve({ email: email });
      }
      return client().auth.verifyOtp({ email: email, token: String(token).trim(), type: 'recovery' })
        .then(function (r) {
          if (r.error) throw new Error(humanError(r.error.message));
          return r.data;
        });
    },

    /* 注册确认用验证码（需在 Supabase 邮件模板里放 {{ .Token }}） */
    verifySignupCode: function (email, token) {
      if (!isCloud()) return Promise.reject(new Error('本机演示模式不需要邮箱验证'));
      return client().auth.verifyOtp({ email: email, token: String(token).trim(), type: 'signup' })
        .then(function (r) {
          if (r.error) throw new Error(humanError(r.error.message));
          return r.data;
        });
    },

    resendConfirm: function (email) {
      if (!isCloud()) return Promise.resolve(true);
      return client().auth.resend({ type: 'signup', email: email })
        .then(function (r) {
          if (r.error) throw new Error(humanError(r.error.message));
          return true;
        });
    },

    updatePassword: function (password) {
      if (!isCloud()) {
        var db = readLocal();
        var me = db.profile && db.profile.email;
        db.users.forEach(function (u) { if (u.email === me) u.password = password; });
        writeLocal(db);
        return Promise.resolve(true);
      }
      return client().auth.updateUser({ password: password })
        .then(function (r) {
          if (r.error) throw new Error(humanError(r.error.message));
          return true;
        });
    },

    onAuthChange: function (cb) {
      if (!isCloud()) return;
      client().auth.onAuthStateChange(function (event, session) {
        try { cb(event, session); } catch (e) { /* 忽略 */ }
      });
    }
  };

  /* ================= 档案与钱包 ================= */
  function updateMyProfile(name, phone) {
    if (!isCloud()) {
      var db = readLocal();
      if (db.profile) {
        db.profile.name = name; db.profile.phone = phone;
        db.users = db.users.map(function (u) { return u.id === db.profile.id ? db.profile : u; });
      }
      writeLocal(db);
      return Promise.resolve({ ok: true });
    }
    return client().rpc('update_my_profile', { p_name: name, p_phone: phone })
      .then(function (r) { return unwrap(r, '保存资料'); });
  }

  function listPlans() {
    if (!isCloud()) {
      return Promise.resolve(localPlans().filter(function (p) { return p.is_active; })
        .sort(function (a, b) { return a.sort_no - b.sort_no; }));
    }
    return client().from('plans').select('*').eq('is_active', true)
      .order('sort_no', { ascending: true })
      .then(function (r) { return unwrap(r, '读取套餐') || []; });
  }

  function listWalletLogs(userId) {
    if (!isCloud()) {
      var db = readLocal();
      var me = userId || (db.profile && db.profile.id);
      return Promise.resolve(db.wallet.filter(function (w) { return w.user_id === me; })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }));
    }
    var q = client().from('wallet_logs').select('*').order('created_at', { ascending: false }).limit(200);
    if (userId) q = q.eq('user_id', userId);
    return q.then(function (r) { return unwrap(r, '读取账单') || []; });
  }

  function purchasePlan(planId) {
    if (!isCloud()) {
      var db = readLocal();
      var p = localPlans().filter(function (x) { return x.id === planId; })[0];
      if (!p) return Promise.reject(new Error('套餐不存在'));
      var me = db.profile;
      if (!me) return Promise.reject(new Error('请先登录'));
      if (me.balance_cents < p.price_cents) {
        return Promise.reject(new Error('余额不足：需要 ' + (p.price_cents / 100).toFixed(2) +
          ' 元，当前余额 ' + (me.balance_cents / 100).toFixed(2) + ' 元，请先充值'));
      }
      var base = Math.max(Date.now(), me.plan_expires_at ? new Date(me.plan_expires_at).getTime() : 0);
      me.balance_cents -= p.price_cents;
      me.plan_id = p.id;
      me.plan_expires_at = new Date(base + p.duration_days * 86400000).toISOString();
      db.users = db.users.map(function (u) { return u.id === me.id ? Object.assign({}, u, me) : u; });
      db.wallet.push({
        id: uuid(), user_id: me.id, delta_cents: -p.price_cents,
        balance_after: me.balance_cents, kind: 'plan',
        note: '购买套餐：' + p.name, created_at: nowISO()
      });
      writeLocal(db);
      return Promise.resolve({ ok: true, balance_cents: me.balance_cents, plan_expires_at: me.plan_expires_at, plan_name: p.name });
    }
    return client().rpc('purchase_plan', { p_plan_id: planId })
      .then(function (r) {
        var d = unwrap(r, '购买套餐');
        if (d && d.ok === false) throw new Error(d.error || '购买失败');
        return d;
      });
  }

  function requestRecharge(amountCents, method, note) {
    if (!isCloud()) {
      var db = readLocal();
      db.recharges.push({
        id: uuid(), user_id: db.profile.id, amount_cents: amountCents,
        method: method || '', note: note || '', status: 'pending',
        review_note: '', reviewed_at: null, created_at: nowISO()
      });
      writeLocal(db);
      return Promise.resolve({ ok: true });
    }
    return client().rpc('request_recharge', {
      p_amount_cents: amountCents, p_method: method || '', p_note: note || ''
    }).then(function (r) {
      var d = unwrap(r, '提交充值申请');
      if (d && d.ok === false) throw new Error(d.error || '提交失败');
      return d;
    });
  }

  function listMyRecharges() {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile && db.profile.id;
      return Promise.resolve(db.recharges.filter(function (x) { return x.user_id === me; })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }));
    }
    return client().from('recharge_requests').select('*')
      .order('created_at', { ascending: false }).limit(100)
      .then(function (r) { return unwrap(r, '读取充值记录') || []; });
  }

  /* ================= 免费版操作配额 ================= */
  var QUOTA_LIMIT = 10;

  function quotaStatus() {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile || {};
      var unlimited = !!((me.is_super && !me.preview_member) || (me.plan_expires_at && new Date(me.plan_expires_at) > new Date()));
      var r = me.quota_remind_used || 0, p = me.quota_promote_used || 0;
      return Promise.resolve({
        ok: true, unlimited: unlimited, limit: QUOTA_LIMIT,
        remind: { used: r, left: Math.max(0, QUOTA_LIMIT - r) },
        promote: { used: p, left: Math.max(0, QUOTA_LIMIT - p) }
      });
    }
    return client().rpc('quota_status').then(function (r) { return unwrap(r, '读取配额'); });
  }

  function consumeQuota(kind) {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile;
      if (!me) return Promise.resolve({ ok: false, error: '请先登录' });
      var unlimited = !!((me.is_super && !me.preview_member) || (me.plan_expires_at && new Date(me.plan_expires_at) > new Date()));
      if (unlimited) return Promise.resolve({ ok: true, unlimited: true });
      var field = kind === 'remind' ? 'quota_remind_used' : 'quota_promote_used';
      var used = me[field] || 0;
      if (used >= QUOTA_LIMIT) {
        return Promise.resolve({
          ok: false, exhausted: true,
          error: kind === 'remind'
            ? '免费版「复制催办文本」已用完 10 次，购买套餐后可不限次数使用'
            : '免费版「一键加入名单」已用完 10 次，购买套餐后可不限次数使用'
        });
      }
      me[field] = used + 1;
      db.users = db.users.map(function (u) { return u.id === me.id ? Object.assign({}, u, me) : u; });
      writeLocal(db);
      return Promise.resolve({ ok: true, unlimited: false, used: me[field],
        left: Math.max(0, QUOTA_LIMIT - me[field]), limit: QUOTA_LIMIT });
    }
    return client().rpc('consume_quota', { p_kind: kind }).then(function (r) { return unwrap(r, '扣减配额'); });
  }

  /* 把名单外参会人一键加入名单 */
  function promoteResponse(responseId) {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile;
      if (!me) return Promise.resolve({ ok: false, error: '请先登录' });
      var resp = (db.responses || []).filter(function (x) { return x.id === responseId; })[0];
      if (!resp) return Promise.resolve({ ok: false, error: '找不到这条参会记录' });
      var name = String(resp.name_raw || '').trim();
      var emp = String(resp.emp_no || '').trim();
      var already = db.roster.some(function (p) {
        return (emp && String(p.emp_no || '').toLowerCase() === emp.toLowerCase()) ||
               (!emp && p.name === name && (p.dept || '') === (resp.dept || ''));
      });
      if (already) {
        resp.promoted = true;
        writeLocal(db);
        return Promise.resolve({ ok: true, already: true, message: '这个人已经在你的名单里了' });
      }
      return consumeQuota('promote').then(function (q) {
        if (!q || !q.ok) return q;
        var d = readLocal();
        var maxSort = d.roster.reduce(function (m, p) { return Math.max(m, p.sort_no || 0); }, 0);
        var hit = d.roster.filter(function (p) {
          return p.name === name && (p.dept || '') === (resp.dept || '') && (p.category || '') === (resp.category || '');
        })[0];
        if (hit) {
          if (emp && !hit.emp_no) hit.emp_no = emp;
          hit.active = true;
        } else {
          d.roster.push({
            id: uuid(), owner_id: me.id, emp_no: emp, dept: resp.dept || '',
            category: resp.category || '', name: name, phone: '', note: '',
            sort_no: maxSort + 1, active: true, created_at: nowISO()
          });
        }
        (d.responses || []).forEach(function (x) { if (x.id === responseId) x.promoted = true; });
        writeLocal(d);
        return { ok: true, already: false, quota: q, added: { name: name, emp_no: emp } };
      });
    }
    return client().rpc('promote_response_to_roster', { p_response_id: responseId })
      .then(function (r) { return unwrap(r, '加入名单'); });
  }

  /* ================= 名单 ================= */
  function listRoster() {
    if (!isCloud()) {
      var db = readLocal();
      var umap = {};
      (db.users || []).forEach(function (u) { umap[u.id] = u; });
      return Promise.resolve(db.roster.slice().map(function (x) {
        var u = umap[x.owner_id] || {};
        return Object.assign({}, x, { owner_name: u.name || '', owner_emp_no: u.emp_no || '' });
      }).sort(function (a, b) {
        return (a.sort_no || 0) - (b.sort_no || 0);
      }));
    }
    return client().from('roster').select('*')
      .order('sort_no', { ascending: true })
      .order('dept', { ascending: true })
      .then(function (r) {
        var rows = unwrap(r, '读取名单') || [];
        // 超管能看到所有人的名单：补上归属人，便于按用户区分
        var ids = [];
        rows.forEach(function (x) { if (x.owner_id && ids.indexOf(x.owner_id) < 0) ids.push(x.owner_id); });
        if (!ids.length) return rows;
        return client().from('profiles').select('id,name,emp_no').in('id', ids)
          .then(function (pr) {
            var list = unwrap(pr, '读取用户') || [];
            var map = {};
            list.forEach(function (u) { map[u.id] = u; });
            return rows.map(function (x) {
              var u = map[x.owner_id] || {};
              return Object.assign({}, x, { owner_name: u.name || '', owner_emp_no: u.emp_no || '' });
            });
          }).catch(function () { return rows; });
      });
  }

  function insertRoster(rows) {
    if (!rows || !rows.length) return Promise.resolve([]);
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile ? db.profile.id : null;
      rows.forEach(function (x) {
        var hit = db.roster.filter(function (y) {
          return y.dept === x.dept && y.name === x.name && (y.category || '') === (x.category || '');
        })[0];
        if (hit) Object.assign(hit, x, { updated_at: nowISO() });
        else db.roster.push(Object.assign({ id: uuid(), owner_id: me, active: true }, x));
      });
      writeLocal(db);
      return Promise.resolve(rows);
    }
    return client().from('roster')
      .upsert(rows.map(function (x) {
        return {
          emp_no: x.emp_no || '', dept: x.dept || '', category: x.category || '', name: x.name,
          phone: x.phone || '', note: x.note || '',
          sort_no: x.sort_no == null ? 0 : x.sort_no,
          active: x.active === false ? false : true
        };
      }), { onConflict: 'owner_id,dept,category,name' })
      .select()
      .then(function (r) { return unwrap(r, '写入名单'); });
  }

  function updateRoster(id, patch) {
    if (!isCloud()) {
      var db = readLocal();
      db.roster.forEach(function (x) { if (x.id === id) Object.assign(x, patch); });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('roster').update(patch).eq('id', id)
      .then(function (r) { return unwrap(r, '修改名单'); });
  }

  function deleteRoster(ids) {
    if (!ids || !ids.length) return Promise.resolve(true);
    if (!isCloud()) {
      var db = readLocal();
      db.roster = db.roster.filter(function (x) { return ids.indexOf(x.id) < 0; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('roster').delete().in('id', ids)
      .then(function (r) { return unwrap(r, '删除名单'); });
  }

  /* ================= 会议 ================= */
  function listMeetings() {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.meetings.slice().sort(function (a, b) {
        var da = a.meet_date || '', db2 = b.meet_date || '';
        if (da !== db2) return da < db2 ? 1 : -1;
        return String(b.created_at || '') < String(a.created_at || '') ? -1 : 1;
      }));
    }
    return client().from('meetings').select('*')
      .order('meet_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取会议') || []; });
  }

  function getMeeting(id) {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.meetings.filter(function (m) { return m.id === id; })[0] || null);
    }
    return client().from('meetings').select('*').eq('id', id).maybeSingle()
      .then(function (r) { return unwrap(r, '读取会议'); });
  }

  function normalizeMeeting(m, isPatch) {
    var keys = ['title', 'meet_date', 'start_time', 'end_time', 'location', 'convene_dept',
                'host', 'contact', 'agenda', 'ask_reason', 'ask_note', 'deadline', 'invite', 'status',
                'layout_enabled', 'checkin_start', 'checkin_end'];
    var out = {};
    keys.forEach(function (k) {
      if (m[k] !== undefined) {
        var nullable = (k === 'meet_date' || k === 'deadline' ||
                        k === 'checkin_start' || k === 'checkin_end');
        out[k] = (m[k] === '' && nullable) ? null : m[k];
      }
    });
    if (!isPatch) {
      if (out.title === undefined) out.title = '未命名会议';
      if (out.invite === undefined) out.invite = [];
    }
    return out;
  }

  function createMeeting(m) {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile;
      if (!me) throw new Error('请先登录');
      var planOk = me.is_super || (me.plan_expires_at && new Date(me.plan_expires_at).getTime() > Date.now());
      if (!planOk) {
        var mine = db.meetings.filter(function (x) { return x.owner_id === me.id; });
        if (mine.length >= 1) {
          throw new Error('免费额度已用完：未开通套餐最多发布 1 场会议，请到「我的账户」购买套餐后继续');
        }
        if ((m.invite || []).length > 20) {
          throw new Error('免费额度限制：单场最多邀请 20 人（当前 ' + (m.invite || []).length +
            ' 人），购买套餐后不限人数');
        }
      }
      var row = Object.assign({
        id: uuid(), owner_id: me.id, share_token: randToken(12),
        status: 'published', created_at: nowISO()
      }, m);
      db.meetings.push(row);
      writeLocal(db);
      return Promise.resolve(row);
    }
    return client().from('meetings').insert(normalizeMeeting(m)).select().single()
      .then(function (r) { return unwrap(r, '创建会议'); });
  }

  function updateMeeting(id, patch) {
    if (!isCloud()) {
      var db = readLocal();
      db.meetings.forEach(function (m) { if (m.id === id) Object.assign(m, patch); });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('meetings').update(normalizeMeeting(patch, true)).eq('id', id).select().single()
      .then(function (r) { return unwrap(r, '保存会议'); });
  }

  function listTrash() {
    if (!isCloud()) {
      var db = readLocal();
      var me = db.profile || {};
      return Promise.resolve((db.trash || []).filter(function (x) {
        return !x.owner_id || x.owner_id === me.id;
      }).sort(function (a, b) { return a.deleted_at < b.deleted_at ? 1 : -1; }));
    }
    return client().from('meetings_trash').select('*')
      .order('deleted_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取回收站') || []; });
  }

  function restoreMeeting(id) {
    if (!isCloud()) {
      var db = readLocal();
      var row = (db.trash || []).filter(function (x) { return x.id === id; })[0];
      if (!row) return Promise.resolve({ ok: false, error: '回收站里没有这场会议' });
      var m = JSON.parse(JSON.stringify(row.data));
      db.meetings.push(m);
      db.trash = db.trash.filter(function (x) { return x.id !== id; });
      writeLocal(db);
      return Promise.resolve({ ok: true });
    }
    return client().rpc('restore_meeting', { p_id: id })
      .then(function (r) { return unwrap(r, '恢复会议'); });
  }

  function purgeMeeting(id) {
    if (!isCloud()) {
      var db = readLocal();
      db.trash = (db.trash || []).filter(function (x) { return x.id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('meetings_trash').delete().eq('id', id)
      .then(function (r) { return unwrap(r, '彻底删除'); });
  }

  /* 清掉超过 30 天的回收站记录 */
  function purgeExpired() {
    var cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    if (!isCloud()) {
      var db = readLocal();
      db.trash = (db.trash || []).filter(function (x) { return x.deleted_at >= cutoff; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('meetings_trash').delete().lt('deleted_at', cutoff)
      .then(function () { return true; }).catch(function () { return true; });
  }


  function deleteMeeting(id) {
    function moveToTrash(row) {
      if (isCloud()) {
        return client().from('meetings_trash')
          .upsert({ id: row.id, owner_id: row.owner_id, title: row.title, data: row,
                    deleted_at: new Date().toISOString() }, { onConflict: 'id' })
          .then(function () { return client().from('meetings').delete().eq('id', id); })
          .then(function () { return true; });
      }
      var db = readLocal();
      db.trash = db.trash || [];
      db.trash.push({ id: row.id, owner_id: row.owner_id, title: row.title,
        data: JSON.parse(JSON.stringify(row)), deleted_at: nowISO() });
      db.meetings = (db.meetings || []).filter(function (x) { return x.id !== id; });
      db.responses = (db.responses || []).filter(function (x) { return x.meeting_id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }

    if (!isCloud()) {
      var db = readLocal();
      var row = (db.meetings || []).filter(function (x) { return x.id === id; })[0];
      if (!row) return Promise.resolve(true);
      return moveToTrash(row);
    }
    return client().from('meetings').select('*').eq('id', id).maybeSingle()
      .then(function (r) {
        var row = unwrap(r, '读取会议');
        if (!row) return true;
        return moveToTrash(row);
      });
  }

  function listResponses(meetingId) {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.responses.filter(function (r) { return r.meeting_id === meetingId; }));
    }
    return client().from('responses').select('*').eq('meeting_id', meetingId)
      .order('updated_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取回执') || []; });
  }

  function listAllResponses() {
    if (!isCloud()) return Promise.resolve(readLocal().responses);
    return client().from('responses').select('*')
      .order('updated_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取回执') || []; });
  }

  function deleteResponse(id) {
    if (!isCloud()) {
      var db = readLocal();
      db.responses = db.responses.filter(function (r) { return r.id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('responses').delete().eq('id', id)
      .then(function (r) { return unwrap(r, '删除回执'); });
  }

  /* ================= 参会人填报（匿名） ================= */
  function openMeeting(token) {
    if (!isCloud()) {
      var db = readLocal();
      var m = db.meetings.filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效或会议已撤销' });
      var closed = !!(m.deadline && Date.now() > new Date(m.deadline).getTime());
      return Promise.resolve({
        ok: true,
        meeting: {
          title: m.title, meet_date: m.meet_date, start_time: m.start_time, end_time: m.end_time,
          location: m.location, convene_dept: m.convene_dept, host: m.host, contact: m.contact,
          agenda: m.agenda, ask_reason: m.ask_reason !== false, ask_note: m.ask_note !== false,
          deadline: m.deadline, closed: closed, invite_count: (m.invite || []).length,
          layout_enabled: !!m.layout_enabled,
          organizer: (db.profile && db.profile.name) || ''
        },
        names: (m.invite || []).map(function (x) { return x.name; })
      });
    }
    return client().rpc('open_meeting', { p_token: token })
      .then(function (r) { return unwrap(r, '打开会议'); });
  }

  function submitResponse(token, name, attending, reason, note, empNo) {
    if (!isCloud()) {
      var db = readLocal();
      var m = db.meetings.filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效或会议已撤销' });
      if (m.deadline && Date.now() > new Date(m.deadline).getTime()) {
        return Promise.resolve({ ok: false, error: '本次填报已截止，如需变更请联系会议联系人' });
      }
      var emp = String(empNo || '').replace(/\s+/g, '').toLowerCase();
      var key = String(name).replace(/\s+/g, '').toLowerCase();
      var invite = m.invite || [];
      var hit = emp
        ? invite.filter(function (x) { return String(x.emp_no || '').replace(/\s+/g, '').toLowerCase() === emp; })[0]
        : null;
      if (!hit) {
        hit = invite.filter(function (x) {
          return String(x.name).replace(/\s+/g, '').toLowerCase() === key;
        })[0];
      }
      var rowKey = emp || key;
      var cur = db.responses.filter(function (r) { return r.meeting_id === m.id && r.name_key === rowKey; })[0];
      var row = {
        id: cur ? cur.id : uuid(), meeting_id: m.id, name_key: rowKey, name_raw: name, emp_no: emp,
        dept: hit ? hit.dept : '', category: hit ? hit.category : '',
        attending: !!attending, reason: reason || '', note: note || '',
        on_list: !!hit, updated_at: nowISO(),
        created_at: cur ? cur.created_at : nowISO()
      };
      db.responses = db.responses.filter(function (r) { return r.id !== row.id; });
      db.responses.push(row);
      writeLocal(db);
      return Promise.resolve({
        ok: true, attending: row.attending, name: row.name_raw, emp_no: row.emp_no, on_list: row.on_list,
        updated_at: row.updated_at,
        message: row.attending ? '已记录：您将按时参会' : '已记录：您不参会'
      });
    }
    return client().rpc('submit_response', {
      p_token: token, p_name: name, p_attending: !!attending,
      p_reason: reason || '', p_note: note || '',
      p_ua: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      p_emp_no: empNo || ''
    }).then(function (r) { return unwrap(r, '提交回执'); });
  }

  function myResponse(token, name, empNo) {
    if (!isCloud()) {
      var db = readLocal();
      var m = db.meetings.filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效' });
      var emp = String(empNo || '').replace(/\s+/g, '').toLowerCase();
      var key = String(name).replace(/\s+/g, '').toLowerCase();
      var row = (emp ? db.responses.filter(function (r) {
        return r.meeting_id === m.id && (r.name_key === emp || String(r.emp_no || '') === emp);
      })[0] : null) || db.responses.filter(function (r) {
        return r.meeting_id === m.id && r.name_key === key;
      })[0];
      if (!row) return Promise.resolve({ ok: true, found: false });
      return Promise.resolve({
        ok: true, found: true, attending: row.attending,
        reason: row.reason, note: row.note, updated_at: row.updated_at, emp_no: row.emp_no
      });
    }
    return client().rpc('my_response', { p_token: token, p_name: name, p_emp_no: empNo || '' })
      .then(function (r) { return unwrap(r, '读取回执'); });
  }

  /* ================= 会场布局 ================= */
  function getLayout(meetingId) {
    if (!isCloud()) {
      var db = readLocal();
      var row = (db.layouts || {})[meetingId];
      return Promise.resolve(row || null);
    }
    return client().from('meeting_layouts').select('*').eq('meeting_id', meetingId).maybeSingle()
      .then(function (r) { return unwrap(r, '读取布局'); });
  }

  function saveLayout(meetingId, mode, layout) {
    if (!isCloud()) {
      var db = readLocal();
      db.layouts = db.layouts || {};
      db.layouts[meetingId] = { meeting_id: meetingId, mode: mode, layout: layout, updated_at: nowISO() };
      writeLocal(db);
      return Promise.resolve(db.layouts[meetingId]);
    }
    return client().from('meeting_layouts')
      .upsert({ meeting_id: meetingId, mode: mode, layout: layout, updated_at: new Date().toISOString() },
              { onConflict: 'meeting_id' })
      .select().single()
      .then(function (r) { return unwrap(r, '保存布局'); });
  }

  /* ================= 签到 ================= */
  function personKey(empNo, name) {
    var e = String(empNo || '').replace(/\s+/g, '').toLowerCase();
    if (e) return 'e:' + e;
    var n = String(name || '').replace(/\s+/g, '').toLowerCase();
    return n ? 'n:' + n : '';
  }

  function seatOf(layout, pk) {
    var empty = { seat_key: '', seat_label: '', scene_name: '' };
    if (!layout || !layout.assign || !pk) return empty;
    var key = null;
    Object.keys(layout.assign).forEach(function (k) {
      if (!key && layout.assign[k] === pk) key = k;
    });
    if (!key) return empty;
    var s = (layout.seats || []).filter(function (x) { return x.key === key; })[0];
    return {
      seat_key: key,
      seat_label: s ? (s.label || '') : '',
      scene_name: s ? (s.sceneName || '') : ''
    };
  }

  /* 双键查座：名单没录工号时，参会人自己填的工号也要能对上 */
  function seatOfAny(layout, empNo, name) {
    var byEmp = seatOf(layout, personKey(empNo, ''));
    if (byEmp.seat_key) return byEmp;
    return seatOf(layout, personKey('', name));
  }
  function checkinWindow(m) {
    var now = Date.now();
    var st = m.checkin_start ? new Date(m.checkin_start).getTime() : null;
    var en = m.checkin_end ? new Date(m.checkin_end).getTime() : null;
    return (st === null || now >= st) && (en === null || now <= en);
  }

  function listCheckins(meetingId) {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve((db.checkins || []).filter(function (x) { return x.meeting_id === meetingId; })
        .sort(function (a, b) { return a.checked_in_at < b.checked_in_at ? 1 : -1; }));
    }
    return client().from('checkins').select('*').eq('meeting_id', meetingId)
      .order('checked_in_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取签到') || []; });
  }

  function manualCheckin(meetingId, person) {
    if (!isCloud()) {
      var db = readLocal();
      db.checkins = db.checkins || [];
      var pk = personKey(person.emp_no, person.name);
      var layout = (db.layouts || {})[meetingId] && db.layouts[meetingId].layout;
      var seat = seatOfAny(layout, person.emp_no, person.name);
      var exist = db.checkins.filter(function (x) { return x.meeting_id === meetingId && x.person_key === pk; })[0];
      if (exist) return Promise.resolve(exist);
      var row = {
        id: uuid(), meeting_id: meetingId, person_key: pk,
        emp_no: String(person.emp_no || '').toLowerCase(), name: person.name,
        seat_key: seat.seat_key, scene_name: seat.scene_name, seat_label: seat.seat_label,
        checked_in_at: nowISO(), source: 'manual'
      };
      db.checkins.push(row);
      writeLocal(db);
      return Promise.resolve(row);
    }
    var pk2 = personKey(person.emp_no, person.name);
    return client().from('checkins').upsert({
      meeting_id: meetingId, person_key: pk2,
      emp_no: String(person.emp_no || '').toLowerCase(), name: person.name,
      source: 'manual'
    }, { onConflict: 'meeting_id,person_key' }).select().single()
      .then(function (r) { return unwrap(r, '补签'); });
  }

  function deleteCheckin(id) {
    if (!isCloud()) {
      var db = readLocal();
      db.checkins = (db.checkins || []).filter(function (x) { return x.id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('checkins').delete().eq('id', id)
      .then(function (r) { return unwrap(r, '撤销签到'); });
  }

  function checkinInfo(token, empNo, name) {
    if (!isCloud()) {
      var db = readLocal();
      var m = (db.meetings || []).filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效' });
      var pk = personKey(empNo, name);
      var ci = (db.checkins || []).filter(function (x) {
        return x.meeting_id === m.id && x.person_key === pk;
      })[0];
      var layout = (db.layouts || {})[m.id] && db.layouts[m.id].layout;
      if (ci) {
        return Promise.resolve({
          ok: true, layout_enabled: !!m.layout_enabled, open: false, checked_in: true,
          checked_in_at: ci.checked_in_at,
          seat: { seat_key: ci.seat_key, seat_label: ci.seat_label, scene_name: ci.scene_name }
        });
      }
      return Promise.resolve({
        ok: true, layout_enabled: !!m.layout_enabled,
        open: !!m.layout_enabled && checkinWindow(m),
        checked_in: false, start: m.checkin_start, end: m.checkin_end, person_key: pk,
        seat: seatOfAny(layout, empNo, name)
      });
    }
    return client().rpc('checkin_info', {
      p_token: token, p_emp_no: empNo || '', p_name: name || ''
    }).then(function (r) { return unwrap(r, '读取签到状态'); });
  }

  function submitCheckin(token, empNo, name) {
    if (!isCloud()) {
      var db = readLocal();
      var m = (db.meetings || []).filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效或会议已撤销' });
      if (!m.layout_enabled) return Promise.resolve({ ok: false, error: '这场会议没有开启签到' });
      if (!checkinWindow(m)) return Promise.resolve({ ok: false, error: '签到未开始或已截止' });
      if (!empNo) return Promise.resolve({ ok: false, error: '请填写你的工号' });
      var pk = personKey(empNo, name);
      var layout = (db.layouts || {})[m.id] && db.layouts[m.id].layout;
      var seat = seatOfAny(layout, empNo, name);
      db.checkins = db.checkins || [];
      db.checkins = db.checkins.filter(function (x) { return !(x.meeting_id === m.id && x.person_key === pk); });
      var row = {
        id: uuid(), meeting_id: m.id, person_key: pk, emp_no: String(empNo).toLowerCase(),
        name: name, seat_key: seat.seat_key, scene_name: seat.scene_name, seat_label: seat.seat_label,
        checked_in_at: nowISO(), source: 'link'
      };
      db.checkins.push(row);
      writeLocal(db);
      return Promise.resolve({ ok: true, checked_in_at: row.checked_in_at, name: row.name, seat: seat });
    }
    return client().rpc('submit_checkin', {
      p_token: token, p_emp_no: empNo || '', p_name: name || ''
    }).then(function (r) { return unwrap(r, '签到'); });
  }

  function seatMap(token, empNo, name) {
    if (!isCloud()) {
      var db = readLocal();
      var m = (db.meetings || []).filter(function (x) { return x.share_token === token; })[0];
      if (!m || !m.layout_enabled) return Promise.resolve({ ok: false, error: '这场会议没有座位图' });
      var L = (db.layouts || {})[m.id] && db.layouts[m.id].layout;
      if (!L) return Promise.resolve({ ok: false, error: '会议还没有排座位' });
      var seat = seatOfAny(L, empNo, name);
      return Promise.resolve({
        ok: true, mode: L.mode, style: L.style, canvas: L.canvas,
        seats: L.seats, scenes: L.scenes || [],
        my_seat_key: seat.seat_key, my_seat_label: seat.seat_label, my_scene_name: seat.scene_name
      });
    }
    return client().rpc('seat_map', { p_token: token, p_emp_no: empNo || '', p_name: name || '' })
      .then(function (r) { return unwrap(r, '读取座位图'); });
  }


  /* 超管：以普通会员身份预览 */
  function setPreviewMode(on) {
    if (!isCloud()) {
      var db = readLocal();
      if (db.profile) db.profile.preview_member = !!on;
      writeLocal(db);
      return Promise.resolve({ ok: true, preview: !!on });
    }
    return client().rpc('set_preview_mode', { p_on: !!on })
      .then(function (r) { return unwrap(r, '切换身份'); });
  }

  /* ================= 布局模板（会议室样式） ================= */
  function listTemplates() {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve((db.templates || []).slice().sort(function (x, y) {
        return x.created_at < y.created_at ? 1 : -1;
      }));
    }
    return client().from('layout_templates').select('*')
      .order('created_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取模板') || []; });
  }

  function saveTemplate(name, mode, layout) {
    if (!isCloud()) {
      var db = readLocal();
      db.templates = db.templates || [];
      var me = db.profile || {};
      var hit = db.templates.filter(function (x) { return x.name === name; })[0];
      if (hit) {
        hit.mode = mode; hit.layout = layout; hit.updated_at = nowISO();
      } else {
        db.templates.push({ id: uuid(), owner_id: me.id, name: name, mode: mode,
          layout: layout, created_at: nowISO(), updated_at: nowISO() });
      }
      writeLocal(db);
      return Promise.resolve({ ok: true, name: name });
    }
    return client().rpc('save_layout_template', {
      p_name: name, p_mode: mode || 'grid', p_layout: layout
    }).then(function (r) { return unwrap(r, '保存模板'); });
  }

  function deleteTemplate(id) {
    if (!isCloud()) {
      var db = readLocal();
      db.templates = (db.templates || []).filter(function (x) { return x.id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('layout_templates').delete().eq('id', id)
      .then(function (r) { return unwrap(r, '删除模板'); });
  }

  /* ================= 超级管理员 ================= */
  var admin = {
    listUsers: function () {
      if (!isCloud()) {
        var db = readLocal();
        return Promise.resolve(db.users.map(function (u) {
          var c = Object.assign({}, u);
          delete c.password; delete c._reset;
          return c;
        }));
      }
      return client().from('profiles').select('*').order('created_at', { ascending: true })
        .then(function (r) { return unwrap(r, '读取用户') || []; });
    },

    updateUser: function (id, patch) {
      if (!isCloud()) {
        var db = readLocal();
        db.users.forEach(function (u) { if (u.id === id) Object.assign(u, patch); });
        writeLocal(db);
        return Promise.resolve(true);
      }
      return client().from('profiles').update(patch).eq('id', id)
        .then(function (r) { return unwrap(r, '修改用户'); });
    },

    adjustBalance: function (id, deltaCents, note) {
      if (!isCloud()) {
        var db = readLocal();
        var u = db.users.filter(function (x) { return x.id === id; })[0];
        if (!u) return Promise.reject(new Error('用户不存在'));
        u.balance_cents = Math.max(0, u.balance_cents + deltaCents);
        db.wallet.push({
          id: uuid(), user_id: id, delta_cents: deltaCents, balance_after: u.balance_cents,
          kind: 'adjust', note: '管理员调整' + (note ? '：' + note : ''), created_at: nowISO()
        });
        writeLocal(db);
        return Promise.resolve({ ok: true, balance_cents: u.balance_cents });
      }
      return client().rpc('admin_adjust_balance', {
        p_user_id: id, p_delta_cents: deltaCents, p_note: note || ''
      }).then(function (r) { return unwrap(r, '调整余额'); });
    },

    grantPlan: function (id, planId, days) {
      if (!isCloud()) {
        var db = readLocal();
        var u = db.users.filter(function (x) { return x.id === id; })[0];
        var p = localPlans().filter(function (x) { return x.id === planId; })[0];
        var n = days || (p ? p.duration_days : 0);
        if (!u || !n) return Promise.reject(new Error('参数不正确'));
        var base = Math.max(Date.now(), u.plan_expires_at ? new Date(u.plan_expires_at).getTime() : 0);
        u.plan_expires_at = new Date(base + n * 86400000).toISOString();
        if (p) u.plan_id = p.id;
        writeLocal(db);
        return Promise.resolve({ ok: true, plan_expires_at: u.plan_expires_at });
      }
      return client().rpc('admin_grant_plan', {
        p_user_id: id, p_plan_id: planId || null, p_days: days || 0
      }).then(function (r) { return unwrap(r, '开通套餐'); });
    },

    listAllPlans: function () {
      if (!isCloud()) return Promise.resolve(localPlans());
      return client().from('plans').select('*').order('sort_no', { ascending: true })
        .then(function (r) { return unwrap(r, '读取套餐') || []; });
    },

    savePlan: function (plan) {
      if (!isCloud()) {
        var db = readLocal();
        if (plan.id) {
          db.plans = db.plans.map(function (p) { return p.id === plan.id ? Object.assign({}, p, plan) : p; });
        } else {
          plan.id = uuid();
          db.plans.push(plan);
        }
        writeLocal(db);
        return Promise.resolve(plan);
      }
      var payload = {
        name: plan.name, price_cents: plan.price_cents, duration_days: plan.duration_days,
        description: plan.description || '', is_active: plan.is_active !== false,
        sort_no: plan.sort_no || 0
      };
      if (plan.id) {
        return client().from('plans').update(payload).eq('id', plan.id).select().single()
          .then(function (r) { return unwrap(r, '保存套餐'); });
      }
      return client().from('plans').insert(payload).select().single()
        .then(function (r) { return unwrap(r, '新增套餐'); });
    },

    deletePlan: function (id) {
      if (!isCloud()) {
        var db = readLocal();
        db.plans = db.plans.filter(function (p) { return p.id !== id; });
        writeLocal(db);
        return Promise.resolve(true);
      }
      return client().from('plans').delete().eq('id', id)
        .then(function (r) { return unwrap(r, '删除套餐'); });
    },

    /* 充值申请：两次查询后在本地拼用户信息，避免依赖 PostgREST 的嵌套写法 */
    listRecharges: function (status) {
      if (!isCloud()) {
        var db = readLocal();
        return Promise.resolve(db.recharges
          .filter(function (x) { return !status || x.status === status; })
          .map(function (x) {
            var u = db.users.filter(function (y) { return y.id === x.user_id; })[0];
            return Object.assign({}, x, { user_name: u ? u.name : '', user_emp_no: u ? u.emp_no : '' });
          })
          .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }));
      }
      var q = client().from('recharge_requests').select('*')
        .order('created_at', { ascending: false }).limit(300);
      if (status) q = q.eq('status', status);
      return Promise.all([q, client().from('profiles').select('id,name,emp_no')]).then(function (arr) {
        var list = unwrap(arr[0], '读取充值申请') || [];
        var users = unwrap(arr[1], '读取用户') || [];
        var map = {};
        users.forEach(function (u) { map[u.id] = u; });
        return list.map(function (x) {
          var u = map[x.user_id] || {};
          return Object.assign({}, x, { user_name: u.name || '', user_emp_no: u.emp_no || '' });
        });
      });
    },

    reviewRecharge: function (id, approve, note) {
      if (!isCloud()) {
        var db = readLocal();
        var req = db.recharges.filter(function (x) { return x.id === id; })[0];
        if (!req) return Promise.reject(new Error('申请不存在'));
        if (req.status !== 'pending') return Promise.reject(new Error('该申请已经处理过了'));
        req.status = approve ? 'approved' : 'rejected';
        req.review_note = note || '';
        req.reviewed_at = nowISO();
        if (approve) {
          var u = db.users.filter(function (x) { return x.id === req.user_id; })[0];
          if (u) {
            u.balance_cents += req.amount_cents;
            db.wallet.push({
              id: uuid(), user_id: u.id, delta_cents: req.amount_cents,
              balance_after: u.balance_cents, kind: 'recharge',
              note: '充值审批通过', created_at: nowISO()
            });
          }
        }
        writeLocal(db);
        return Promise.resolve({ ok: true });
      }
      return client().rpc('admin_review_recharge', {
        p_request_id: id, p_approve: !!approve, p_note: note || ''
      }).then(function (r) { return unwrap(r, '审批充值'); });
    },

    /* 所有用户的会议：两次查询后本地拼归属人 */
    listAllMeetings: function () {
      if (!isCloud()) {
        var db = readLocal();
        return Promise.resolve(db.meetings.map(function (m) {
          var u = db.users.filter(function (y) { return y.id === m.owner_id; })[0];
          return Object.assign({}, m, {
            owner_name: u ? u.name : '', owner_emp_no: u ? u.emp_no : ''
          });
        }));
      }
      return Promise.all([
        client().from('meetings').select('*').order('created_at', { ascending: false }).limit(500),
        client().from('profiles').select('id,name,emp_no,email,locked')
      ]).then(function (arr) {
        var list = unwrap(arr[0], '读取会议') || [];
        var users = unwrap(arr[1], '读取用户') || [];
        var map = {};
        users.forEach(function (u) { map[u.id] = u; });
        return list.map(function (m) {
          var u = map[m.owner_id] || {};
          return Object.assign({}, m, {
            owner_name: u.name || '', owner_emp_no: u.emp_no || '',
            owner_email: u.email || '', owner_locked: !!u.locked
          });
        });
      });
    }
  };

  /* 本机演示模式：自动用一个本机账号登录 */
  function enterDemo() {
    if (isCloud()) return Promise.resolve(null);
    var db = readLocal();
    if (!db.user) {
      if (!db.users.length) {
        db.users.push({
          id: uuid(), emp_no: 'demo', name: '演示用户', phone: '', email: 'demo@local',
          password: 'demo', is_super: true, locked: false, locked_reason: '',
          balance_cents: 0, plan_id: null, plan_expires_at: null, created_at: nowISO()
        });
      }
      db.user = db.users[0];
    }
    db.profile = db.user;
    writeLocal(db);
    return Promise.resolve(db.profile);
  }

  return {
    isCloud: isCloud, configCheck: configCheck, normalizeUrl: normUrl,
    auth: auth,
    updateMyProfile: updateMyProfile,
    listPlans: listPlans, listWalletLogs: listWalletLogs,
    purchasePlan: purchasePlan, requestRecharge: requestRecharge, listMyRecharges: listMyRecharges,
    listRoster: listRoster, insertRoster: insertRoster, updateRoster: updateRoster, deleteRoster: deleteRoster,
    quotaStatus: quotaStatus, consumeQuota: consumeQuota, promoteResponse: promoteResponse,
    listMeetings: listMeetings, listTrash: listTrash, restoreMeeting: restoreMeeting, purgeMeeting: purgeMeeting, purgeExpired: purgeExpired, getMeeting: getMeeting, createMeeting: createMeeting,
    updateMeeting: updateMeeting, deleteMeeting: deleteMeeting,
    listResponses: listResponses, listAllResponses: listAllResponses, deleteResponse: deleteResponse,
    getLayout: getLayout, saveLayout: saveLayout,
    listTemplates: listTemplates, saveTemplate: saveTemplate, deleteTemplate: deleteTemplate,
    setPreviewMode: setPreviewMode,
    listCheckins: listCheckins, manualCheckin: manualCheckin, deleteCheckin: deleteCheckin,
    checkinInfo: checkinInfo, submitCheckin: submitCheckin, seatMap: seatMap,
    openMeeting: openMeeting, submitResponse: submitResponse, myResponse: myResponse,
    admin: admin, enterDemo: enterDemo
  };
});
