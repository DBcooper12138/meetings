/* ============================================================
 *  qr.js —— 零依赖二维码生成器（字节模式 / 纠错等级 L / 版本 1-20）
 *   返回值：{size, modules} —— modules 为 0/1 的二维数组
 *   另有 toSvg()、toPngDataUrl() 便于页面上直接展示
 *   用途：会议链接生成二维码，方便别人扫码填写
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MSQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 版本参数表：纠错等级 L ----------
     [每块纠错码字数, [ [块数, 每块数据码字数], ... ] ]  */
  var RS_L = {
    1:  [7,  [[1, 19]]],
    2:  [10, [[1, 34]]],
    3:  [15, [[1, 55]]],
    4:  [20, [[1, 80]]],
    5:  [26, [[1, 108]]],
    6:  [18, [[2, 68]]],
    7:  [20, [[2, 78]]],
    8:  [24, [[2, 97]]],
    9:  [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]],
    11: [20, [[4, 81]]],
    12: [24, [[2, 92], [2, 93]]],
    13: [26, [[4, 107]]],
    14: [30, [[3, 115], [1, 116]]],
    15: [22, [[5, 87], [1, 88]]],
    16: [24, [[5, 98], [1, 99]]],
    17: [28, [[1, 107], [5, 108]]],
    18: [30, [[5, 120], [1, 121]]],
    19: [28, [[3, 113], [4, 114]]],
    20: [28, [[3, 107], [5, 108]]]
  };

  /* ---------- 对齐图案中心坐标（版本 1-20，按规范表列全，避免公式出错） ---------- */
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
    14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
    17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90]
  };

  var EC_L_BITS = 1;          // 纠错等级 L 的格式信息编码

  /* ================= GF(256) 运算 ================= */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = new Uint8Array(data.length + ecLen);
    res.set(data, 0);
    for (var i = 0; i < data.length; i++) {
      var coef = res[i];
      if (coef === 0) continue;
      for (var j = 0; j < gen.length; j++) {
        res[i + j] ^= gmul(gen[j], coef);
      }
    }
    return res.subarray(data.length);
  }

  /* ================= 位缓冲 ================= */
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (value, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  /* ================= UTF-8 编码 ================= */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str));
    var out = [], s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function totalDataCodewords(ver) {
    return RS_L[ver][1].reduce(function (a, b) { return a + b[0] * b[1]; }, 0);
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 20; v++) {
      var cci = v < 10 ? 8 : 16;
      var need = 4 + cci + byteLen * 8;
      if (need <= totalDataCodewords(v) * 8) return v;
    }
    throw new Error('内容过长，二维码放不下（请缩短链接）');
  }

  /* ================= 主流程 ================= */
  function makeCodewords(text) {
    var bytes = utf8Bytes(text);
    var ver = pickVersion(bytes.length);
    var cci = ver < 10 ? 8 : 16;
    var buf = new BitBuf();
    buf.put(4, 4);                     // 字节模式
    buf.put(bytes.length, cci);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    var capacity = totalDataCodewords(ver) * 8;
    // 结束符最多 4 位
    var term = Math.min(4, capacity - buf.bits.length);
    buf.put(0, term);
    // 补零到字节边界
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);
    // 填充字节 0xEC / 0x11 交替
    var pads = [0xEC, 0x11], pi = 0;
    while (buf.bits.length < capacity) buf.put(pads[pi++ % 2], 8);

    var dataCw = new Uint8Array(capacity / 8);
    for (var b = 0; b < capacity; b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | buf.bits[b + k];
      dataCw[b / 8] = byteVal;
    }

    // 分块 + 纠错
    var ecLen = RS_L[ver][0];
    var groups = RS_L[ver][1];
    var blocks = [], offset = 0;
    groups.forEach(function (g) {
      for (var n = 0; n < g[0]; n++) {
        var chunk = dataCw.subarray(offset, offset + g[1]);
        offset += g[1];
        blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
      }
    });

    // 交错
    var out = [];
    var maxData = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
    for (var di = 0; di < maxData; di++) {
      blocks.forEach(function (b) { if (di < b.data.length) out.push(b.data[di]); });
    }
    for (var ei = 0; ei < ecLen; ei++) {
      blocks.forEach(function (b) { out.push(b.ec[ei]); });
    }
    return { version: ver, codewords: new Uint8Array(out) };
  }

  /* ================= 矩阵构建 ================= */
  function buildMatrix(version, codewords, maskPattern) {
    var size = version * 4 + 17;
    var mat = [], fn = [];
    for (var i = 0; i < size; i++) {
      mat.push(new Array(size).fill(0));
      fn.push(new Array(size).fill(false));
    }

    function setFn(r, c, v) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      mat[r][c] = v; fn[r][c] = true;
    }

    // 定位图案 + 分隔符
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
      var pr = p[0], pc = p[1];
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = pr + r, cc = pc + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          var inRing = (r >= 0 && r <= 6 && c >= 0 && c <= 6);
          var dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 ||
                                (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setFn(rr, cc, dark ? 1 : 0);
        }
      }
    });

    // 校正图案
    var centers = ALIGN[version] || [];
    centers.forEach(function (cr) {
      centers.forEach(function (cc) {
        var overlapsFinder = (cr <= 8 && cc <= 8) ||
                             (cr <= 8 && cc >= size - 9) ||
                             (cr >= size - 9 && cc <= 8);
        if (overlapsFinder) return;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var dark = (Math.max(Math.abs(r), Math.abs(c)) !== 1);
            setFn(cr + r, cc + c, dark ? 1 : 0);
          }
        }
      });
    });

    // 时序图案
    for (var t = 8; t < size - 8; t++) {
      var v = (t % 2 === 0) ? 1 : 0;
      setFn(6, t, v);
      setFn(t, 6, v);
    }

    // 格式信息占位
    for (var f = 0; f <= 8; f++) {
      if (!fn[8][f]) setFn(8, f, 0);
      if (!fn[f][8]) setFn(f, 8, 0);
    }
    for (var f2 = 0; f2 < 8; f2++) {
      setFn(8, size - 1 - f2, 0);
      setFn(size - 1 - f2, 8, 0);
    }
    setFn(8, size - 8, 1);   // 固定的暗模块

    // 版本信息（版本 >= 7）
    if (version >= 7) {
      var vinfo = versionInfoBits(version);
      for (var vi = 0; vi < 18; vi++) {
        var bit = (vinfo >> vi) & 1;
        var a = Math.floor(vi / 3), b = vi % 3;
        setFn(size - 11 + b, a, bit);
        setFn(a, size - 11 + b, bit);
      }
    }

    // 数据位填充（右下角起，两列一组，蛇形向上/向下）
    var bitIdx = 0;
    var totalBits = codewords.length * 8;
    function dataBit(i) {
      if (i >= totalBits) return 0;
      return (codewords[i >> 3] >> (7 - (i & 7))) & 1;
    }
    var col = size - 1;
    var upward = true;
    while (col > 0) {
      if (col === 6) col--;            // 跳过时序列
      for (var step = 0; step < size; step++) {
        var row = upward ? (size - 1 - step) : step;
        for (var dx = 0; dx < 2; dx++) {
          var c2 = col - dx;
          if (fn[row][c2]) continue;
          var bitValue = dataBit(bitIdx++);
          mat[row][c2] = bitValue;
        }
      }
      col -= 2;
      upward = !upward;
    }

    // 掩码
    for (var r2 = 0; r2 < size; r2++) {
      for (var c3 = 0; c3 < size; c3++) {
        if (fn[r2][c3]) continue;
        if (maskFn(maskPattern, r2, c3)) mat[r2][c3] ^= 1;
      }
    }

    // 写入格式信息（两处副本 + 固定暗模块）
    // 位序与 QR 规范一致；实测排布与 qrcode-generator 等主流实现完全一致，
    // 这样生成的码才能被微信、手机相机等常见扫码器识别。
    var fmt = formatBits(EC_L_BITS, maskPattern);
    // 副本一：列 8 的竖条（bit0..bit5 在 r=0..5；bit6,7 在 r=7,8；bit8..14 在 r=size-7..size-1）
    for (var i1 = 0; i1 < 15; i1++) {
      var b1 = (fmt >> i1) & 1;
      if (i1 < 6) mat[i1][8] = b1;
      else if (i1 < 8) mat[i1 + 1][8] = b1;
      else mat[size - 15 + i1][8] = b1;
    }
    // 副本二：行 8 的横条（bit0..bit7 在 c=size-1..size-8；bit8 在 c=7；bit9..14 在 c=5..0）
    for (var i2 = 0; i2 < 15; i2++) {
      var b2 = (fmt >> i2) & 1;
      if (i2 < 8) mat[8][size - 1 - i2] = b2;
      else if (i2 < 9) mat[8][7] = b2;
      else mat[8][14 - i2] = b2;
    }
    // 固定暗模块
    mat[size - 8][8] = 1;

    return mat;
  }

  function maskFn(p, r, c) {
    switch (p) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function bchFormat(data) {
    var d = data << 10;
    var g = 0x537;
    for (var i = 14; i >= 10; i--) {
      if ((d >> i) & 1) d ^= g << (i - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function formatBits(ecBits, mask) {
    return bchFormat((ecBits << 3) | mask);
  }

  function versionInfoBits(version) {
    var d = version << 12;
    var g = 0x1F25;
    for (var i = 17; i >= 12; i--) {
      if ((d >> i) & 1) d ^= g << (i - 12);
    }
    return (version << 12) | d;
  }

  function penalty(mat) {
    var size = mat.length, score = 0, r, c, i;
    // 规则1：连续同色
    for (r = 0; r < size; r++) {
      var run = 1;
      for (c = 1; c < size; c++) {
        if (mat[r][c] === mat[r][c - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      var run2 = 1;
      for (r = 1; r < size; r++) {
        if (mat[r][c] === mat[r - 1][c]) run2++;
        else { if (run2 >= 5) score += 3 + (run2 - 5); run2 = 1; }
      }
      if (run2 >= 5) score += 3 + (run2 - 5);
    }
    // 规则2：2x2 同色块
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
      }
    }
    // 规则3：1:1:3:1:1 图案
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matchAt(get, len, pos, pat) {
      for (var k = 0; k < pat.length; k++) {
        if (pos + k >= len) return false;
        if (get(pos + k) !== pat[k]) return false;
      }
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) {
        var getR = (function (rr) { return function (cc) { return mat[rr][cc]; }; })(r);
        if (matchAt(getR, size, c, pat1) || matchAt(getR, size, c, pat2)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r <= size - 11; r++) {
        var getC = (function (cc) { return function (rr) { return mat[rr][cc]; }; })(c);
        if (matchAt(getC, size, r, pat1) || matchAt(getC, size, r, pat2)) score += 40;
      }
    }
    // 规则4：黑白比例
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mat[r][c]) dark++;
    var ratio = dark * 100 / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function generate(text) {
    var cw = makeCodewords(text);
    var best = null, bestScore = Infinity;
    for (var p = 0; p < 8; p++) {
      var mat = buildMatrix(cw.version, cw.codewords, p);
      var s = penalty(mat);
      if (s < bestScore) { bestScore = s; best = mat; }
    }
    return { size: best.length, modules: best, version: cw.version };
  }

  /* ================= 输出 ================= */
  function toSvg(text, opts) {
    var q = generate(text);
    var scale = (opts && opts.scale) || 4;
    var quiet = 4;
    var dim = (q.size + quiet * 2) * scale;
    var parts = [];
    for (var r = 0; r < q.size; r++) {
      for (var c = 0; c < q.size; c++) {
        if (!q.modules[r][c]) continue;
        parts.push('<rect x="' + ((c + quiet) * scale) + '" y="' + ((r + quiet) * scale) +
                   '" width="' + scale + '" height="' + scale + '"/>');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
           '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
           '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
           '<g fill="#000000">' + parts.join('') + '</g></svg>';
  }

  /* 最小 PNG 编码（灰度、1 像素 = 1 模块，缩放用 CSS 控制） */
  function crc32(bytes) {
    var table = crc32._t;
    if (!table) {
      table = crc32._t = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  function toPngBytes(text, scale) {
    var q = generate(text);
    var s = scale || 4, quiet = 4;
    var n = (q.size + quiet * 2) * s;
    var raw = new Uint8Array((n + 1) * n);
    var pos = 0;
    for (var y = 0; y < n; y++) {
      raw[pos++] = 0; // filter: none
      for (var x = 0; x < n; x++) {
        var mr = Math.floor(y / s) - quiet;
        var mc = Math.floor(x / s) - quiet;
        var dark = (mr >= 0 && mc >= 0 && mr < q.size && mc < q.size) ? q.modules[mr][mc] : 0;
        raw[pos++] = dark ? 0 : 255;
      }
    }
    // zlib 使用 stored block，避免实现 deflate
    var zlib = [];
    zlib.push(0x78, 0x01);
    var off = 0;
    while (off < raw.length) {
      var len = Math.min(65535, raw.length - off);
      var last = (off + len >= raw.length) ? 1 : 0;
      zlib.push(last, len & 0xFF, (len >> 8) & 0xFF, (~len) & 0xFF, ((~len) >> 8) & 0xFF);
      for (var i = 0; i < len; i++) zlib.push(raw[off + i]);
      off += len;
    }
    var ad = adler32(raw);
    zlib.push((ad >>> 24) & 0xFF, (ad >>> 16) & 0xFF, (ad >>> 8) & 0xFF, ad & 0xFF);
    var idat = new Uint8Array(zlib);

    var ihdr = new Uint8Array(13);
    var dv = new DataView(ihdr.buffer);
    dv.setUint32(0, n); dv.setUint32(4, n);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // grayscale
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    var chunks = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
    var total = chunks.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  function toPngDataUrl(text, scale) {
    var bytes = toPngBytes(text, scale);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:image/png;base64,' + btoa(bin);
  }

  return {
    generate: generate, toSvg: toSvg,
    toPngBytes: toPngBytes, toPngDataUrl: toPngDataUrl
  };
});
