/* ============================================================
 *  xlsx.js —— 零依赖的 Excel 读写（浏览器 / Node 双用）
 *   · readXlsx(buffer)  -> [[cell, cell, ...], ...]   读 .xlsx
 *   · buildXlsx(sheets) -> Blob / Uint8Array          写 .xlsx
 *   · parseCSV(text)    -> 二维数组                    读 .csv
 *   不依赖任何 CDN，断网也能用。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MSXlsx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ================= 公共小工具 ================= */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function uint8(s) { return new TextEncoder().encode(s); }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function xmlUnesc(s) {
    return String(s == null ? '' : s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* 列号字母 -> 0 基下标 */
  function colIndex(ref) {
    var m = /^([A-Z]+)/i.exec(String(ref || ''));
    if (!m) return -1;
    var s = m[1].toUpperCase(), n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function colName(i) {
    var s = '';
    i = i + 1;
    while (i > 0) {
      var r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  /* ================= ZIP 读取 ================= */

  function findEOCD(u8) {
    for (var i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4B && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  function u16(u8, p) { return u8[p] | (u8[p + 1] << 8); }
  function u32(u8, p) { return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0; }

  function zipEntries(u8) {
    var eocd = findEOCD(u8);
    if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 结尾标记）');
    var count = u16(u8, eocd + 10);
    var cdOff = u32(u8, eocd + 16);
    var entries = Object.create(null);
    var p = cdOff;
    var dec = new TextDecoder('utf-8');
    for (var i = 0; i < count; i++) {
      if (u32(u8, p) !== 0x02014B50) break;
      var method = u16(u8, p + 10);
      var compSize = u32(u8, p + 20);
      var nameLen = u16(u8, p + 28);
      var extraLen = u16(u8, p + 30);
      var commentLen = u16(u8, p + 32);
      var localOff = u32(u8, p + 42);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, compSize: compSize, localOff: localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function zipRead(u8, entry) {
    var p = entry.localOff;
    if (u32(u8, p) !== 0x04034B50) throw new Error('ZIP 局部头损坏');
    var nameLen = u16(u8, p + 26);
    var extraLen = u16(u8, p + 28);
    var start = p + 30 + nameLen + extraLen;
    return u8.subarray(start, start + entry.compSize);
  }

  function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持本地解压（需要较新版 Chrome / Edge / Safari 16.4+）。' +
                      '请改用「导入 CSV」方式，或用新版浏览器打开。');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* 解出 zip 中某个文件的文本内容 */
  function zipText(u8, entries, name) {
    var e = entries[name];
    if (!e) return Promise.resolve('');
    var raw = zipRead(u8, e);
    if (e.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(raw));
    if (e.method !== 8) return Promise.resolve('');
    return inflateRaw(raw).then(function (out) { return new TextDecoder('utf-8').decode(out); });
  }

  /* ================= 解析 xlsx ================= */

  function parseSharedStrings(xml) {
    var out = [];
    if (!xml) return out;
    var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    var m;
    while ((m = siRe.exec(xml)) !== null) {
      var body = m[1] || '';
      var text = '';
      // 取所有 <t> 内容（富文本多个 run 拼接），跳过 <rPh> 拼音
      var clean = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
      var tm;
      while ((tm = tRe.exec(clean)) !== null) text += xmlUnesc(tm[1] || '');
      out.push(text);
    }
    return out;
  }

  /* 从一行 XML 里解出各单元格 {col, value} */
  function parseRow(rowXml, shared) {
    var cells = [];
    var cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var m;
    while ((m = cRe.exec(rowXml)) !== null) {
      var attrs = m[1] || '';
      var inner = m[2] || '';
      var refM = /\br="([A-Z]+\d+)"/i.exec(attrs);
      var tM = /\bt="([^"]+)"/.exec(attrs);
      var type = tM ? tM[1] : 'n';
      var idx = refM ? colIndex(refM[1]) : cells.length;
      var val = '';
      if (type === 'inlineStr') {
        var iRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g, im;
        while ((im = iRe.exec(inner)) !== null) val += xmlUnesc(im[1]);
      } else {
        var vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) {
          var raw = xmlUnesc(vM[1]);
          if (type === 's') {
            var si = parseInt(raw, 10);
            val = isNaN(si) ? '' : (shared[si] == null ? '' : shared[si]);
          } else {
            val = raw;
          }
        }
      }
      cells.push({ col: idx, value: val });
    }
    return cells;
  }

  function sheetToGrid(xml, shared) {
    var grid = [];
    if (!xml) return grid;
    var sd = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
    var body = sd ? sd[1] : xml;
    var rRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    var m, rowNo = 0;
    while ((m = rRe.exec(body)) !== null) {
      var attrs = m[1] || '';
      var inner = m[2] || '';
      var rnM = /\br="(\d+)"/.exec(attrs);
      rowNo = rnM ? parseInt(rnM[1], 10) : rowNo + 1;
      var cells = parseRow(inner, shared);
      var arr = [];
      cells.forEach(function (c) {
        if (c.col < 0) return;
        while (arr.length < c.col) arr.push('');
        arr[c.col] = c.value;
      });
      grid[rowNo - 1] = arr;
    }
    // 补齐空洞
    for (var i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    return grid;
  }

  function pickFirstSheetPath(workbookXml) {
    // 优先取工作簿里第一个 sheet；xlsx 的 sheet 顺序以 workbook.xml 为准
    var m = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbookXml || '');
    var rid = m ? m[1] : null;
    return rid;
  }

  function readXlsx(buffer) {
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var entries = zipEntries(u8);
    var dec = new TextDecoder('utf-8');

    return zipText(u8, entries, 'xl/sharedStrings.xml').then(function (ssXml) {
      var shared = parseSharedStrings(ssXml);
      return zipText(u8, entries, 'xl/workbook.xml').then(function (wbXml) {
        return zipText(u8, entries, 'xl/_rels/workbook.xml.rels').then(function (relsXml) {
          var rid = pickFirstSheetPath(wbXml);
          var target = null;
          if (rid && relsXml) {
            var re = new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*>', 'i');
            var rm = re.exec(relsXml);
            if (rm) {
              var tm = /Target="([^"]+)"/.exec(rm[0]);
              if (tm) target = tm[1];
            }
          }
          if (!target) {
            // 退路：Any sheet1.xml
            var keys = Object.keys(entries);
            for (var i = 0; i < keys.length; i++) {
              if (/^xl\/worksheets\/sheet\d+\.xml$/.test(keys[i])) { target = keys[i].replace(/^xl\//, ''); break; }
            }
          }
          if (!target) throw new Error('xlsx 里找不到工作表');
          var path = target.charAt(0) === '/' ? target.slice(1)
                   : (/^xl\//.test(target) ? target : 'xl/' + target.replace(/^\.\//, ''));
          return zipText(u8, entries, path);
        });
      }).then(function (sheetXml) {
        return sheetToGrid(sheetXml, shared);
      });
    });
  }

  /* ================= 生成 xlsx ================= */

  function fileEl(name, data) {
    var nameBytes = uint8(name);
    var crc = crc32(data);
    var head = new Uint8Array(30 + nameBytes.length);
    var dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034B50, true);
    dv.setUint16(4, 20, true);       // version needed
    dv.setUint16(6, 0x0800, true);   // UTF-8 文件名
    dv.setUint16(8, 0, true);        // method = stored
    dv.setUint16(10, 0, true);       // time
    dv.setUint16(12, 0x2821, true);  // date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    head.set(nameBytes, 30);
    return { head: head, data: data, crc: crc, nameBytes: nameBytes };
  }

  function buildZip(files) {
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var item = fileEl(f.name, f.data);
      parts.push(item.head, item.data);
      var cd = new Uint8Array(46 + item.nameBytes.length);
      var dv = new DataView(cd.buffer);
      dv.setUint32(0, 0x02014B50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0x2821, true);
      dv.setUint32(16, item.crc, true);
      dv.setUint32(20, item.data.length, true);
      dv.setUint32(24, item.data.length, true);
      dv.setUint16(28, item.nameBytes.length, true);
      dv.setUint32(42, offset, true);
      cd.set(item.nameBytes, 46);
      central.push(cd);
      offset += item.head.length + item.data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22);
    var edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054B50, true);
    edv.setUint16(8, files.length, true);
    edv.setUint16(10, files.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);

    var total = offset + cdSize + 22;
    var out = new Uint8Array(total), pos = 0;
    parts.concat(central, [end]).forEach(function (p) {
      out.set(p, pos); pos += p.length;
    });
    return out;
  }

  function buildSheetXml(rows, colWidths) {
    var cols = '';
    if (colWidths && colWidths.length) {
      cols = '<cols>' + colWidths.map(function (w, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      }).join('') + '</cols>';
    }
    var body = rows.map(function (row, ri) {
      var cells = (row || []).map(function (v, ci) {
        var ref = colName(ci) + (ri + 1);
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'number' && isFinite(v)) {
          return '<c r="' + ref + '"><v>' + v + '</v></c>';
        }
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
               xmlEsc(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (ri + 1) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      cols + '<sheetData>' + body + '</sheetData></worksheet>';
  }

  /* 工作表名：去掉 Excel 不允许的字符并限长。中文要保留，不能转成下划线。 */
  function safeSheetName(s) {
    var name = String(s == null ? '' : s)
      .replace(/[\\\/?*\[\]:]/g, '_')
      .replace(/[\x00-\x1F]/g, '')
      .replace(/^\s+|\s+$/g, '');
    if (!name) name = 'Sheet';
    if (name.length > 31) name = name.slice(0, 31);
    return name;
  }

  /* 同名工作表加序号，避免重名 */
  function uniqSheetNames(list) {
    var used = Object.create(null), out = [];
    list.forEach(function (n) {
      var base = safeSheetName(n), name = base, i = 2;
      while (used[name.toLowerCase()]) {
        var suffix = '(' + i + ')';
        name = base.slice(0, 31 - suffix.length) + suffix;
        i++;
      }
      used[name.toLowerCase()] = 1;
      out.push(name);
    });
    return out;
  }

  /* sheets: [{name, rows:[[...],...], colWidths:[...]}] -> Uint8Array */
  function buildXlsx(sheets) {
    sheets = sheets && sheets.length ? sheets : [{ name: 'Sheet', rows: [] }];
    var names = uniqSheetNames(sheets.map(function (s) { return s.name; }));
    var files = [];
    files.push({
      name: '[Content_Types].xml',
      data: uint8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
                 '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '</Types>')
    });
    files.push({
      name: '_rels/.rels',
      data: uint8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>')
    });
    files.push({
      name: 'xl/workbook.xml',
      data: uint8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function (s, i) {
          return '<sheet name="' + xmlEsc(names[i]) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('') +
        '</sheets></workbook>')
    });
    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: uint8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '</Relationships>')
    });
    sheets.forEach(function (s, i) {
      files.push({
        name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
        data: uint8(buildSheetXml(s.rows, s.colWidths))
      });
    });
    return buildZip(files);
  }

  /* ================= CSV 解析 ================= */

  function parseCSV(text) {
    var s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    var rows = [], row = [], cell = '', inQ = false, i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  return {
    readXlsx: readXlsx, buildXlsx: buildXlsx, parseCSV: parseCSV,
    colName: colName, colIndex: colIndex, xmlEsc: xmlEsc, crc32: crc32
  };
});
