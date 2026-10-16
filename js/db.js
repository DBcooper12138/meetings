/* ============================================================
 *  db.js —— 数据访问层
 *   首选：Supabase 云端（真正的"任何地方都能填报/查看"）
 *   退路：本机 localStorage（云端没配置好时也能演示，但不同设备不互通）
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MSDB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LS_KEY = 'ms_local_db_v1';
  var ADMIN_KEY = 'ms_admin_secret';

  function cfg() { return (typeof window !== 'undefined' && window.MS_CONFIG) || {}; }

  /* 把用户手填的项目地址规范化：
     容忍常见的粘贴错误 —— 重复的 https://、结尾的 /rest/v1/、多余斜杠和空格。
     正确目标形态：https://xxxx.supabase.co
     这样即便 config.js 里写得不对，也不会退化成 "Failed to fetch"。 */
  function normUrl(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    // 反复去掉开头的 https:// / http:// （可能被粘了两三次）
    var guard = 0;
    while (/^https?:\/\//i.test(u) && guard++ < 5) u = u.replace(/^https?:\/\//i, '');
    // 去掉结尾的 /rest/v1、/rest、/(任意路径) 与多余斜杠
    u = u.replace(/\/+$/, '').replace(/\/rest(\/v\d+)?$/i, '');
    u = u.replace(/\/+$/, '');
    // 去掉结尾的 / 之后可能残留的多余空格
    u = u.trim();
    return u ? 'https://' + u : '';
  }

  /* 返回配置体检结果，供界面显示明确原因 */
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

  /* ================= 管理员口令（本机记忆） ================= */

  function getSecret() {
    try {
      var s = localStorage.getItem(ADMIN_KEY);
      if (s) return s;
    } catch (e) { /* 隐私模式 */ }
    return cfg().ADMIN_SECRET || '';
  }

  function setSecret(s) {
    try { localStorage.setItem(ADMIN_KEY, s || ''); } catch (e) {}
  }

  function clearSecret() {
    try { localStorage.removeItem(ADMIN_KEY); } catch (e) {}
  }

  /* ================= Supabase 客户端 ================= */

  var _client = null;
  var _clientSecret = null;

  function client() {
    var r = configCheck();
    if (!r.urlOk) {
      throw new Error('config/config.js 里的 SUPABASE_URL 不对：' +
        (r.urlRaw ? '“' + r.urlRaw + '”' : '（空的）') +
        '。正确格式只填域名，例如 https://abcdefghijk.supabase.co，' +
        '不要重复 https://，也不要带结尾的 /rest/v1/');
    }
    if (!r.keyOk) {
      throw new Error('config/config.js 里的 SUPABASE_ANON_KEY 不对：' +
        '应当是 Supabase 控制台 API Keys 里那串以 eyJ 开头的 anon public 密钥，且完整无换行');
    }
    var secret = getSecret();
    // 口令变化时重建客户端，保证请求头里带的是最新口令
    if (_client && _clientSecret === secret) return _client;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      throw new Error('Supabase 客户端库没加载成功（cdn.jsdelivr.net 被拦截或断网），请检查网络后刷新页面');
    }
    _client = window.supabase.createClient(r.url, r.key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-admin-secret': secret } }
    });
    _clientSecret = secret;
    return _client;
  }

  /* ================= 本机降级存储 ================= */

  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : { meetings: [], responses: [], roster: [] };
    } catch (e) {
      return { meetings: [], responses: [], roster: [] };
    }
  }

  function writeLocal(db) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) {
      throw new Error('本机存储写入失败（可能空间不足或处于隐私模式）');
    }
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

  /* ================= 通用错误包装 ================= */

  function unwrap(res, what) {
    if (res && res.error) {
      var msg = res.error.message || String(res.error);
      if (/permission denied|violates row-level security|JWT/i.test(msg)) {
        throw new Error('后台口令不正确，或数据库安全策略未生效。请重新输入口令；' +
                        '若始终不行，请确认已完整执行 supabase/01_schema.sql。');
      }
      throw new Error((what || '操作') + '失败：' + msg);
    }
    return res ? res.data : null;
  }

  /* ================= 管理员：连通性与口令校验 ================= */

  function ping() {
    if (!isCloud()) return Promise.resolve({ mode: 'local' });
    var r = configCheck();
    return client().from('roster').select('id', { count: 'exact', head: true })
      .then(function (res) {
        if (res.error) {
          var m = res.error.message || '';
          if (/permission denied|row-level security/i.test(m)) {
            var e = new Error('ADMIN_SECRET_WRONG');
            e.code = 'ADMIN_SECRET_WRONG';
            throw e;
          }
          if (/relation|does not exist|schema cache/i.test(m)) {
            var e2 = new Error('SCHEMA_MISSING');
            e2.code = 'SCHEMA_MISSING';
            throw e2;
          }
          throw new Error(m);
        }
        return { mode: 'cloud', count: res.count };
      })
      .catch(function (err) {
        var msg = String((err && err.message) || err);
        // 浏览器网络层的失败（地址不可达、DNS、被拦截、被暂停）统一翻译成人话
        if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
          throw new Error('无法连接 Supabase（' + r.url + '）。请依次检查：' +
            '① 该地址在浏览器里能打开；② Supabase 项目没有被暂停；' +
            '③ 这台电脑的网络没有拦截 *.supabase.co。原始错误：' + msg);
        }
        throw err;
      });
  }

  /* ================= 名单 ================= */

  function listRoster() {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.roster.slice().sort(function (a, b) {
        return (a.sort_no || 0) - (b.sort_no || 0);
      }));
    }
    return client().from('roster').select('*')
      .order('sort_no', { ascending: true })
      .order('dept', { ascending: true })
      .then(function (r) { return unwrap(r, '读取名单') || []; });
  }

  function insertRoster(rows) {
    if (!rows || !rows.length) return Promise.resolve([]);
    if (!isCloud()) {
      var db = readLocal();
      rows.forEach(function (x) {
        var hit = db.roster.filter(function (y) {
          return y.dept === x.dept && y.name === x.name && (y.category || '') === (x.category || '');
        })[0];
        if (hit) { Object.assign(hit, x, { updated_at: new Date().toISOString() }); }
        else { db.roster.push(Object.assign({ id: uuid(), active: true }, x)); }
      });
      writeLocal(db);
      return Promise.resolve(rows);
    }
    return client().from('roster')
      .upsert(rows.map(function (x) {
        return {
          dept: x.dept || '', category: x.category || '', name: x.name,
          phone: x.phone || '', note: x.note || '',
          sort_no: x.sort_no == null ? 0 : x.sort_no,
          active: x.active === false ? false : true
        };
      }), { onConflict: 'dept,category,name' })
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

  function clearRoster() {
    if (!isCloud()) {
      var db = readLocal(); db.roster = []; writeLocal(db);
      return Promise.resolve(true);
    }
    // 用 neq 一个不存在的 id 实现"全删"，避免依赖 filter 语法
    return client().from('roster').delete().neq('id', '00000000-0000-0000-0000-000000000000')
      .then(function (r) { return unwrap(r, '清空名单'); });
  }

  /* ================= 会议 ================= */

  function listMeetings() {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.meetings.slice().sort(byMeetingOrder));
    }
    return client().from('meetings').select('*').order('meet_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .then(function (r) { return unwrap(r, '读取会议') || []; });
  }

  function byMeetingOrder(a, b) {
    var da = a.meet_date || '', db2 = b.meet_date || '';
    if (da !== db2) return da < db2 ? 1 : -1;
    return String(b.created_at || '') < String(a.created_at || '') ? -1 : 1;
  }

  function getMeeting(id) {
    if (!isCloud()) {
      var db = readLocal();
      return Promise.resolve(db.meetings.filter(function (m) { return m.id === id; })[0] || null);
    }
    return client().from('meetings').select('*').eq('id', id).maybeSingle()
      .then(function (r) { return unwrap(r, '读取会议'); });
  }

  function createMeeting(m) {
    if (!isCloud()) {
      var db = readLocal();
      var row = Object.assign({
        id: uuid(), share_token: randToken(12),
        status: 'published', created_at: new Date().toISOString()
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

  function deleteMeeting(id) {
    if (!isCloud()) {
      var db = readLocal();
      db.meetings = db.meetings.filter(function (m) { return m.id !== id; });
      db.responses = db.responses.filter(function (x) { return x.meeting_id !== id; });
      writeLocal(db);
      return Promise.resolve(true);
    }
    return client().from('meetings').delete().eq('id', id)
      .then(function (r) { return unwrap(r, '删除会议'); });
  }

  function normalizeMeeting(m, isPatch) {
    var keys = ['title', 'meet_date', 'start_time', 'end_time', 'location', 'convene_dept',
                'host', 'contact', 'agenda', 'ask_reason', 'ask_note', 'deadline',
                'invite', 'status'];
    var out = {};
    keys.forEach(function (k) {
      if (m[k] !== undefined) out[k] = (m[k] === '' && (k === 'meet_date' || k === 'deadline')) ? null : m[k];
    });
    if (!isPatch) {
      if (out.title === undefined) out.title = '未命名会议';
      if (out.invite === undefined) out.invite = [];
    }
    return out;
  }

  /* ================= 回执 ================= */

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

  /* ================= 二级网页（参会人） ================= */

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
          deadline: m.deadline, closed: closed, invite_count: (m.invite || []).length
        },
        names: (m.invite || []).map(function (x) { return x.name; })
      });
    }
    return client().rpc('open_meeting', { p_token: token })
      .then(function (r) { return unwrap(r, '打开会议'); });
  }

  function submitResponse(token, name, attending, reason, note) {
    if (!isCloud()) {
      var db = readLocal();
      var m = db.meetings.filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效或会议已撤销' });
      if (m.deadline && Date.now() > new Date(m.deadline).getTime()) {
        return Promise.resolve({ ok: false, error: '本次填报已截止，如需变更请联系会议联系人' });
      }
      var key = String(name).replace(/\s+/g, '').toLowerCase();
      var hit = (m.invite || []).filter(function (x) {
        return String(x.name).replace(/\s+/g, '').toLowerCase() === key;
      })[0];
      var cur = db.responses.filter(function (r) { return r.meeting_id === m.id && r.name_key === key; })[0];
      var row = {
        id: cur ? cur.id : uuid(), meeting_id: m.id, name_key: key, name_raw: name,
        dept: hit ? hit.dept : '', category: hit ? hit.category : '',
        attending: !!attending, reason: reason || '', note: note || '',
        on_list: !!hit, updated_at: new Date().toISOString(),
        created_at: cur ? cur.created_at : new Date().toISOString()
      };
      db.responses = db.responses.filter(function (r) { return r.id !== row.id; });
      db.responses.push(row);
      writeLocal(db);
      return Promise.resolve({
        ok: true, attending: row.attending, name: row.name_raw, on_list: row.on_list,
        updated_at: row.updated_at,
        message: row.attending ? '已记录：您将按时参会' : '已记录：您不参会'
      });
    }
    var c = cfg();
    return client().rpc('submit_response', {
      p_token: token, p_name: name, p_attending: !!attending,
      p_reason: reason || '', p_note: note || '',
      p_ua: (typeof navigator !== 'undefined' ? navigator.userAgent : '')
    }).then(function (r) { return unwrap(r, '提交回执'); });
  }

  function myResponse(token, name) {
    if (!isCloud()) {
      var db = readLocal();
      var m = db.meetings.filter(function (x) { return x.share_token === token; })[0];
      if (!m) return Promise.resolve({ ok: false, error: '链接无效' });
      var key = String(name).replace(/\s+/g, '').toLowerCase();
      var row = db.responses.filter(function (r) { return r.meeting_id === m.id && r.name_key === key; })[0];
      if (!row) return Promise.resolve({ ok: true, found: false });
      return Promise.resolve({
        ok: true, found: true, attending: row.attending,
        reason: row.reason, note: row.note, updated_at: row.updated_at
      });
    }
    return client().rpc('my_response', { p_token: token, p_name: name })
      .then(function (r) { return unwrap(r, '读取回执'); });
  }

  return {
    isCloud: isCloud, ping: ping, configCheck: configCheck, normalizeUrl: normUrl,
    getSecret: getSecret, setSecret: setSecret, clearSecret: clearSecret,
    listRoster: listRoster, insertRoster: insertRoster, updateRoster: updateRoster,
    deleteRoster: deleteRoster, clearRoster: clearRoster,
    listMeetings: listMeetings, getMeeting: getMeeting, createMeeting: createMeeting,
    updateMeeting: updateMeeting, deleteMeeting: deleteMeeting,
    listResponses: listResponses, listAllResponses: listAllResponses,
    deleteResponse: deleteResponse,
    openMeeting: openMeeting, submitResponse: submitResponse, myResponse: myResponse
  };
});
