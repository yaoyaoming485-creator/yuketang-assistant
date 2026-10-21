// 非交互式推送：从 git credential helper 取凭据，只在内存使用，不打印
const { execFileSync } = require('child_process');
const path = require('path');

const LAB = __dirname;
const REMOTE = 'https://github.com/yaoyaoming485-creator/yuketang-assistant.git';

function cred() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8', cwd: LAB,
  });
  const m = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!m.username || !m.password) throw new Error('凭据不完整');
  return m;
}

const c = cred();
console.log('已从凭据管理器取得 github 凭据：用户=' + c.username + '（token 不打印）');

const url = 'https://' + encodeURIComponent(c.username) + ':' + encodeURIComponent(c.password) + '@github.com/yaoyaoming485-creator/yuketang-assistant.git';

// git 不读 WinINET 的系统代理，直连 443 会超时；显式带上本机代理（不写进仓库配置）
const PROXY = 'http://127.0.0.1:65532';

try {
  execFileSync('git', ['-c', 'http.proxy=' + PROXY, 'push', url, 'main:main'], {
    cwd: LAB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  console.log('推送成功（经本机代理 ' + PROXY + '）');
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '');
  console.log('推送输出: ' + out.replace(new RegExp(c.password, 'g'), '***').slice(0, 500));
  if (String(out).includes('Everything up-to-date')) console.log('（远端已是最新）');
  else process.exitCode = 1;
}
