// 解析 Chromium blockfile 缓存：直接从 EntryStore 读出响应体的位置与大小
// 结构（net/disk_cache/blockfile/entry_store.cc）：
//   uint32 magic = 0xC001CAC1
//   uint32 next; uint32 rankings;
//   int32  reuse_count; int32 refetch_count; int32 state;
//   uint64 creation_time;
//   int32  key_len; int32 long_key;      // long_key==-1 => key 紧跟在头后面
//   uint32 data_size[4];
//   uint32 data_addr[4];                 // CacheAddr: {int32 file_type, int32 start_block, int32 num_blocks}
//   ...
// CacheAddr.file_type: 0=外部文件 f_XXXXXX, 1=data_1, 2=data_2, 3=data_3
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CACHE = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data');

// ---- 读 data 文件头，拿 block_size ----
function readBlockSize(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(256);
  fs.readSync(fd, b, 0, 256, 0);
  fs.closeSync(fd);
  const magic = b.readUInt32LE(0);
  // BlockFileHeader: magic(4) version(4) max_file_size(4) key_size(4) ... block_size 在偏移 20 附近
  for (let off = 16; off <= 64; off += 4) {
    const v = b.readUInt32LE(off);
    if (v === 8192 || v === 4096 || v === 16384) return { magic: magic.toString(16), blockSize: v, at: off };
  }
  return { magic: magic.toString(16), blockSize: 8192, at: -1 };
}

const hdr = readBlockSize(path.join(CACHE, 'data_1'));
console.log('data_1 头 magic=0x' + hdr.magic + '  blockSize=' + hdr.blockSize + ' (字段偏移 ' + hdr.at + ')');

const data1 = fs.readFileSync(path.join(CACHE, 'data_1'));
const MAGIC = 0xc001cac1;

function findEntryStores(buf) {
  const out = [];
  for (let i = 0; i < buf.length - 96; i++) {
    if (buf.readUInt32LE(i) === MAGIC) out.push(i);
  }
  return out;
}

const stores = findEntryStores(data1);
console.log('data_1 里的 EntryStore 头: ' + stores.length + ' 个');

const fileOf = (type) => {
  if (type === 0) return null;         // 外部文件，名字在 start_block
  return path.join(CACHE, 'data_' + type);
};

const externalCache = new Map();
function readExternal(name) {
  if (!externalCache.has(name)) {
    const p = path.join(CACHE, 'f_' + name.toString(16).padStart(6, '0'));
    externalCache.set(name, fs.existsSync(p) ? fs.readFileSync(p) : null);
  }
  return externalCache.get(name);
}

const TARGETS = [
  'get_exercise_list/<assignment_id_1>', 'get_exercise_list/<assignment_id_2>', 'get_exercise_list/<assignment_id_4>',
  'leaf_info/<classroom_id>/<exercise_id_2>', 'leaf_info/<classroom_id>/<exercise_id_4>', 'leaf_info/<classroom_id>/<exercise_id_3>',
  'comment/list/', 'discussion/v2/unit/discussion',
];

const found = [];
for (const st of stores) {
  const keyLen = data1.readInt32LE(st + 24);
  const longKey = data1.readInt32LE(st + 28);
  if (keyLen <= 0 || keyLen > 4096) continue;
  let key = '';
  let keyOff = st + 96;
  if (longKey === -1) {
    key = data1.slice(keyOff, keyOff + keyLen).toString('utf8').replace(/\0+$/, '');
  } else {
    const ext = readExternal(longKey);
    if (!ext) continue;
    key = ext.slice(0, keyLen).toString('utf8').replace(/\0+$/, '');
  }
  if (!/yuketang\.cn/.test(key)) continue;
  const dataSize = [];
  for (let i = 0; i < 4; i++) dataSize.push(data1.readUInt32LE(st + 32 + i * 4));
  const dataAddr = [];
  for (let i = 0; i < 4; i++) {
    const o = st + 48 + i * 12;
    dataAddr.push({ fileType: data1.readInt32LE(o), startBlock: data1.readInt32LE(o + 4), numBlocks: data1.readInt32LE(o + 8) });
  }
  const a0 = dataAddr[0];
  found.push({ key, dataSize, dataAddr });
}

console.log('yuketang 条目: ' + found.length);

const outDir = path.join(__dirname, '.test-runtime', 'cache-api2');
fs.mkdirSync(outDir, { recursive: true });

let saved = 0;
for (const f of found) {
  const want = TARGETS.some(t => f.key.includes(t));
  if (!want) continue;
  const a0 = f.dataAddr[0];
  const size = f.dataSize[0];
  let buf = null;
  let origin = '';
  if (a0.fileType === 0) {
    buf = readExternal(a0.startBlock);
    origin = 'f_' + a0.startBlock.toString(16).padStart(6, '0');
  } else {
    const fp = fileOf(a0.fileType);
    if (fp && fs.existsSync(fp)) {
      const fd = fs.openSync(fp, 'r');
      buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, a0.startBlock * hdr.blockSize);
      fs.closeSync(fd);
      origin = 'data_' + a0.fileType + '@' + (a0.startBlock * hdr.blockSize);
    }
  }
  if (!buf) { console.log('  [读不到] ' + f.key.slice(0, 90)); continue; }

  let text = null, kind = null;
  const tryJson = (b) => { const t = b.toString('utf8'); const s = t.indexOf('{'); return s >= 0 && s < 64 ? t.slice(s) : null; };
  text = tryJson(buf); if (text) kind = 'raw';
  if (!text && buf[0] === 0x1f) { try { text = zlib.gunzipSync(buf).toString('utf8'); kind = 'gzip'; } catch (e) {} }
  if (!text && buf[0] === 0x78) { try { text = zlib.inflateSync(buf).toString('utf8'); kind = 'zlib'; } catch (e) {} }
  if (!text) { try { text = zlib.brotliDecompressSync(buf).toString('utf8'); kind = 'brotli'; } catch (e) {} }
  if (!text) { console.log('  [解不开] ' + f.key.slice(0, 80) + '  size=' + size + ' origin=' + origin); continue; }

  const leaf = (text.match(/"leaf_id":"?(\d+)"?/) || [])[1];
  const exid = (text.match(/"exercise_id":(\d+)/) || [])[1];
  const ttl = (text.match(/"title":"([^"]{0,40})"/) || [])[1];
  const safe = f.key.replace(/[^a-z0-9]+/gi, '_').slice(-70);
  fs.writeFileSync(path.join(outDir, safe + '.json'), text, 'utf8');
  console.log('  [' + kind + '] ' + size + 'B  ' + origin + '  leaf=' + (leaf || '-') + ' exid=' + (exid || '-') + ' title=' + (ttl || '-'));
  console.log('        ' + f.key.slice(0, 120));
  saved++;
}
console.log('\n写出 ' + saved + ' 份 -> ' + outDir);
