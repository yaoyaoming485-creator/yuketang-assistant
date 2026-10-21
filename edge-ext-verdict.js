// 决定性检查：macs.extensions.settings 里到底覆盖了哪些扩展 id
const fs = require('fs');
const path = require('path');

const EDGE = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const base = path.join(EDGE, 'Default');
const sec = JSON.parse(fs.readFileSync(path.join(base, 'Secure Preferences'), 'utf8'));

const macExt = sec.protection.macs.extensions;
const macSettings = macExt.settings || {};
const macInstall = macExt.install || {};
const macUI = macExt.ui || {};

const st = sec.extensions.settings || {};
const extDir = path.join(base, 'Extensions');
const onDisk = fs.existsSync(extDir) ? fs.readdirSync(extDir) : [];

console.log('macs.extensions.settings 覆盖的 id 数: ' + Object.keys(macSettings).length);
console.log('macs.extensions.install   覆盖的 id 数: ' + Object.keys(macInstall).length);
console.log('');

const NAME = {
  ghbmnnjooekpmoecnnnilnnbdlolhkhi: 'Google Hangouts',
  hkglfocchlcpfjpakdebhfofikldecmb: 'Edge Flash Player',
  hmbbdgokgppejcnnoddmfocahieoibip: 'SDDYouTube',
  iikmkjmpaadaobahmlepeloendndfphd: '篡改猴 Tampermonkey',
  jmjflgjpcpepeafmmgdpfkogkghcpiha: 'Edge relevant text changes',
  knbckijjjbmkjiagojjneoplbjilfllc: 'Improve YouTube!',
  lepcimpolkbhimlaabjbinhlohocmjal: 'Enable Copy Paste',
  odlomjlbamekndcpllcnffbgeohgkmjh: 'Microsoft 侧组件(ChatGPT)',
  cjneempfhkonkkbcmnfdibgobmhbagaj: 'Mike Adblock',
};

console.log('商店类扩展（location=1）逐个看：');
console.log('id'.padEnd(36) + '名字'.padEnd(26) + '磁盘  MAC  disable_reasons');
for (const [id, v] of Object.entries(st)) {
  if (v.location !== 1) continue;
  const dir = onDisk.includes(id);
  const mac = !!macSettings[id];
  const dr = JSON.stringify(v.disable_reasons || []);
  let verdict;
  if (!dir) verdict = '【磁盘无文件 -> 真被卸载】';
  else if (!mac) verdict = '【无MAC -> Edge 会丢弃该条目】';
  else if (dr !== '[]') verdict = '【有MAC但被禁用 -> UI 里点一下就能开】';
  else verdict = 'OK 正常';
  console.log(id.padEnd(36) + (NAME[id] || '?').padEnd(24) + (dir ? '有 ' : '无 ') + '  ' + (mac ? '有 ' : '无 ') + '  ' + dr.padEnd(16) + verdict);
}

console.log('\n磁盘上有但 Secure Preferences 里没有条目的扩展:');
for (const id of onDisk) {
  if (!st[id]) console.log('  ' + id + '  ' + (NAME[id] || '?') + '   ← 条目缺失');
}
console.log('\nSecure Preferences 有条目但磁盘没文件的:');
for (const id of Object.keys(st)) {
  if (!onDisk.includes(id) && st[id].location === 1) console.log('  ' + id + '  ' + (NAME[id] || '?'));
}
