#!/usr/bin/env node
/**
 * readme-test.mjs —— 文档绊线（纯离线，不碰网络）。
 *
 *   node test/readme-test.mjs           # 人读
 *   node test/readme-test.mjs --json    # 机器读
 *
 * 为什么要有它：**手写的文档一定会落后**，而且落后时没人会收到通知。
 * 这里把「文档说的事」变成可执行的断言：
 *
 *   ① 工具速查块必须与 `lib/index.js` 的 `TOOLS` **逐字一致**（手改了就红）
 *   ② `docs/…md` 链接必须存在；`docs/` 下**不许有孤立文件**（没人链接 = 没人会读）
 *   ③ 版本号**五处一起改**（package.json / package-lock ×2 / README / CHANGELOG）
 *      —— 这条以前是纯靠人核的，发布清单里专门写着「已知空缺」
 *   ④ 发布说明 与 公开纪律：双语锚点格式合规、**不许出现本机绝对路径**
 *
 * 退出码：0 全绿 / 1 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const results = [];
let currentGroup = '';
const group = (name) => { currentGroup = name; };
function ok(name, cond, detail = '') {
  results.push({ group: currentGroup, name, ok: !!cond, detail: String(detail) });
}

const readme = read('README.md');
const stripEol = (s) => s.replace(/\r\n/g, '\n');

/* ═══════════════ ① 生成块与 TOOLS 一致 ═══════════════ */
group('① 工具速查块');
{
  const BEGIN = '<!-- BEGIN GENERATED:tools -->';
  const END = '<!-- END GENERATED:tools -->';
  ok('README 有生成标记对', readme.includes(BEGIN) && readme.includes(END));
  try {
    const mod = await import('../tools/gen-readme-tools.mjs');
    const r = mod.check();
    ok('生成块与 lib/index.js 的 TOOLS 逐字一致', r.ok, r.ok ? '' : r.reason);
    const block = mod.renderToolsBlock();
    const { TOOLS } = await import('../lib/index.js');
    ok(`生成块覆盖全部 ${TOOLS.length} 个工具`,
      TOOLS.every((t) => block.includes('#### `' + t.name + '`')),
      TOOLS.filter((t) => !block.includes('#### `' + t.name + '`')).map((t) => t.name).join(', '));
    const missing = [];
    for (const t of TOOLS) {
      for (const k of t.parameters?.required ?? []) {
        if (!new RegExp('\\| `' + k + '` \\|[^\\n]*\\|\\s*\\*\\*是\\*\\*').test(block)) missing.push(`${t.name}.${k}`);
      }
    }
    ok('必填参数在生成块里都标了「是」', missing.length === 0, missing.join(', '));
  } catch (e) {
    ok('生成块与 lib/index.js 的 TOOLS 逐字一致', false, String(e.message ?? e));
  }
}

/* ═══════════════ ② docs 链接与孤立文件 ═══════════════ */
group('② docs 链接');
{
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((t) => !/^https?:|^#|^mailto:/.test(t))
    .map((t) => t.split('#')[0])
    .filter(Boolean);
  const dead = [...new Set(links)].filter((t) => !exists(t));
  ok('README 里的相对链接都存在', dead.length === 0, dead.join(', '));

  const docsDir = path.join(ROOT, 'docs');
  const docs = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))
    : [];
  ok('docs/ 目录存在且非空', docs.length > 0, `找到 ${docs.length} 篇`);
  const orphans = docs.filter((f) => !readme.includes('docs/' + f));
  ok('docs/ 下没有孤立文件（每篇都被 README 链接）', orphans.length === 0, orphans.join(', '));

  ok('README 抽到文档索引', /##\s*文档索引/.test(readme));
}

/* ═══════════════ ③ 版本号五处一致 ═══════════════ */
group('③ 版本号一致');
{
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const versions = {
    'package.json': pkg.version,
    'package-lock.json 根': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'README 版本行': (readme.match(/\*\*版本 `([^`]+)`\*\*/) ?? [])[1],
    'CHANGELOG 最新章节': (read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+) /m) ?? [])[1],
  };
  const values = [...new Set(Object.values(versions))];
  for (const [where, v] of Object.entries(versions)) {
    ok(`${where} 有版本号`, Boolean(v), v ? '' : '取不到');
  }
  ok('五处版本号**完全一致**', values.length === 1, JSON.stringify(versions));
  ok('README 版本行与 package.json 一致', versions['README 版本行'] === pkg.version,
    `${versions['README 版本行']} vs ${pkg.version}`);
}

/* ═══════════════ ④ 发布说明格式 + 公开纪律 ═══════════════ */
group('④ 发布说明与公开纪律');
{
  const dir = path.join(ROOT, '.github/release-notes');
  const notes = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    : [];
  ok('至少有一份发布说明', notes.length > 0, notes.join(', '));

  const LOCAL_PATH = /(\/Users\/[A-Za-z]|~\/\.dsh\/skills|C:\\\\Users)/;
  for (const f of notes) {
    const s = read(path.join('.github/release-notes', f));
    const v = f.replace(/\.md$/, '');
    const first = stripEol(s).split('\n')[0].trim();
    ok(`${f} 首行是双语锚点`, first === `[中文](#cn-${v}) | [English](#en-${v})`, first);
    ok(`${f} 有 cn / en 两个 HTML 锚点`,
      s.includes(`<h3 id="cn-${v}">`) && s.includes(`<h3 id="en-${v}">`));
    ok(`${f} 中英之间用 --- 分隔`, stripEol(s).includes('\n---\n'));
    ok(`${f} 两半各有 Full Changelog`, (s.match(/\*\*Full Changelog\*\*/g) ?? []).length === 2);
    ok(`${f} 不含本机绝对路径`, !LOCAL_PATH.test(s), (s.match(LOCAL_PATH) ?? []).join(', '));
  }

  ok('README 不含本机绝对路径', !LOCAL_PATH.test(readme), (readme.match(LOCAL_PATH) ?? []).join(', '));
  const docFiles = fs.existsSync(path.join(ROOT, 'docs'))
    ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))
    : [];
  const dirty = docFiles.filter((f) => LOCAL_PATH.test(read(path.join('docs', f))));
  ok('docs/ 不含本机绝对路径', dirty.length === 0, dirty.join(', '));
  ok('包内不写死绝对路径（package.json files 只含相对路径）',
    (pkgFilesOk(JSON.parse(read('package.json')).files)));
}
function pkgFilesOk(files) {
  return Array.isArray(files) && files.every((f) => !path.isAbsolute(f));
}

/* ═══════════════ 汇报 ═══════════════ */
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 1));
} else {
  let last = '';
  for (const r of results) {
    if (r.group !== last) { console.log(`\n── ${r.group}`); last = r.group; }
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail && !r.ok ? '  → ' + r.detail : (r.detail ? '  → ' + r.detail : '')}`);
  }
}
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
if (!process.argv.includes('--json')) console.log(`\n合计：${passed} 项 ✅ / ${failed} 项 ❌`);
process.exit(failed === 0 ? 0 : 1);
