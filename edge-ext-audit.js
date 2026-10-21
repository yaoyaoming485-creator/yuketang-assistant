// 读取 Edge 配置：每个扩展的真实名字 + 当前启用状态 + Secure Preferences 里是否还有校验记录
const fs = require('fs');
const path = require('path');

const EDGE = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const profiles = ['Default', 'Profile 1'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function extName(dir) {
  // 扩展目录: Extensions/<id>/<version>/manifest.json
  const vers = fs.readdirSync(dir).filter(v => /^\d/.test(v)).sort();
  for (const v of vers.reverse()) {
    const m = readJson(path.join(dir, v, 'manifest.json'));
    if (m) {
      let n = m.name || '';
      n = n.replace(/^__MSG_(.+)__$/, (all, k) => {
        const loc = readJson(path.join(dir, v, '_locales', 'zh_CN', 'messages.json'));
        return (loc && loc[k] && loc[k].message) || all;
      });
      return { name: n, ver: v };
    }
  }
  return { name: '(读不到 manifest)', ver: '?' };
}

const STATE = { 1: '启用', 2: '禁用', 3: '需重新启用(被移除)', 4: '内部禁用', 5: '待确认' };

for (const prof of profiles) {
  const base = path.join(EDGE, prof);
  const extDir = path.join(base, 'Extensions');
  if (!fs.existsSync(extDir)) continue;
  console.log('='.repeat(70));
  console.log('配置档: ' + prof);
  console.log('='.repeat(70));

  const prefs = readJson(path.join(base, 'Preferences'));
  const secPrefs = readJson(path.join(base, 'Secure Preferences'));
  const settings = (prefs && prefs.extensions && prefs.extensions.settings) || {};
  const secSettings = (secPrefs && secPrefs.extensions && secPrefs.extensions.settings) || {};
  const macs = (secPrefs && secPrefs.protection && secPrefs.protection.macs &&
                secPrefs.protection.macs.extensions) || {};

  const ids = fs.readdirSync(extDir).filter(d => fs.statSync(path.join(extDir, d)).isDirectory());
  for (const id of ids) {
    const { name, ver } = extName(path.join(extDir, id));
    const s = settings[id] || {};
    const state = s.state === undefined ? '(不在 Preferences 里)' : (STATE[s.state] || ('state=' + s.state));
    const inSec = !!secSettings[id];
    const hasMac = !!macs[id];
    const fromStore = s.from_webstore === undefined ? '?' : s.from_webstore;
    const location = s.location === undefined ? '?' : s.location;
    console.log(
      `  ${id}\n` +
      `     名字    : ${name}\n` +
      `     版本    : ${ver}\n` +
      `     状态    : ${state}   location=${location}  商店=${fromStore}\n` +
      `     安全目录: ${inSec ? '有记录' : '无记录'}   校验MAC: ${hasMac ? '有' : '无'}`
    );
  }
  console.log();
}
