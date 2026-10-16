/* ============================================================
 *  util.js —— 通用工具（无依赖，浏览器 / Node 双用）
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MSUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 姓名归一化：去所有空白 + 转小写 ---------- */
  function nameKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  /* ---------- HTML 转义（所有用户输入进 innerHTML 前必须过一遍） ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 多行文本 -> 带 <br> 的转义文本 ---------- */
  function escLines(s) {
    return esc(s).replace(/\r?\n/g, '<br>');
  }

  /* ---------- 只允许 http/https 链接，杜绝 javascript: 注入 ---------- */
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  /* ---------- 日期时间显示 ---------- */
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtDate(d) {
    if (!d) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (!m) return String(d);
    return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  function fmtDateWeek(d) {
    if (!d) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (!m) return String(d);
    var dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return fmtDate(d) + ' ' + WEEK[dt.getDay()];
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = Date.now();
    if (isNaN(d.getTime())) return '';
    var diff = Math.round((now - d.getTime()) / 1000);
    if (diff < 0) return fmtDateTime(iso);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
    return fmtDateTime(iso);
  }

  /* ---------- 本地"今天"的 YYYY-MM-DD（避免时区偏移） ---------- */
  function todayISO() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ---------- ISO 时间 -> datetime-local 输入框值（按本地时区） ---------- */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fromLocalInput(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* ---------- 随机 token（用于本地降级模式的链接） ---------- */
  function randToken(len) {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    var out = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var buf = new Uint8Array(len || 12);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) out += chars[buf[i] % chars.length];
      return out;
    }
    for (var j = 0; j < (len || 12); j++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  /* ---------- UUID（本地降级模式用） ---------- */
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ---------- 去重 + 稳定排序 ---------- */
  function uniqBy(arr, keyFn) {
    var seen = Object.create(null), out = [];
    (arr || []).forEach(function (x) {
      var k = keyFn(x);
      if (!seen[k]) { seen[k] = 1; out.push(x); }
    });
    return out;
  }

  /* ---------- CSV 单元格 ---------- */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows) {
    return '\ufeff' + rows.map(function (r) {
      return r.map(csvCell).join(',');
    }).join('\r\n');
  }

  /* ---------- 触发浏览器下载 ---------- */
  function download(filename, content, mime) {
    var blob = content instanceof Blob
      ? content
      : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ---------- 文件名安全化 ---------- */
  function safeFileName(s) {
    return String(s == null ? 'export' : s)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export';
  }

  /* ---------- 轻量提示条 ---------- */
  function toast(msg, type) {
    var box = document.getElementById('toast');
    if (!box) { return; }
    var el = document.createElement('div');
    el.className = 'toast-item ' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 2600);
    setTimeout(function () { el.remove(); }, 3200);
  }

  /* ---------- 简易确认框（Promise 化） ---------- */
  function confirmBox(text) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal"><div class="modal-body">' + escLines(text) + '</div>' +
        '<div class="modal-foot"><button class="btn ghost" data-x="0">取消</button>' +
        '<button class="btn danger" data-x="1">确定</button></div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) {
        var t = e.target.closest('[data-x]');
        if (!t && e.target !== mask) return;
        var v = t && t.getAttribute('data-x') === '1';
        mask.remove(); resolve(!!v);
      });
    });
  }

  function promptBox(title, defaultValue) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal"><div class="modal-body"><div class="modal-title">' +
        esc(title) + '</div><input class="input" id="__pb" value="' + esc(defaultValue || '') + '"></div>' +
        '<div class="modal-foot"><button class="btn ghost" data-x="0">取消</button>' +
        '<button class="btn" data-x="1">确定</button></div></div>';
      document.body.appendChild(mask);
      var input = mask.querySelector('#__pb');
      input.focus(); input.select();
      function done(ok) { var v = input.value; mask.remove(); resolve(ok ? v : null); }
      mask.addEventListener('click', function (e) {
        var t = e.target.closest('[data-x]');
        if (t) done(t.getAttribute('data-x') === '1');
        else if (e.target === mask) done(false);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
    });
  }

  return {
    nameKey: nameKey, esc: esc, escLines: escLines, safeUrl: safeUrl,
    fmtDate: fmtDate, fmtDateWeek: fmtDateWeek, fmtDateTime: fmtDateTime,
    fmtRelative: fmtRelative, todayISO: todayISO,
    toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    randToken: randToken, uuid: uuid, uniqBy: uniqBy,
    csvCell: csvCell, toCSV: toCSV, download: download,
    safeFileName: safeFileName, toast: toast,
    confirmBox: confirmBox, promptBox: promptBox
  };
});
