#!/usr/bin/env node
/**
 * gen-readme-tools.mjs —— 从 `lib/index.js` 的 `TOOLS` 生成 README 的「工具速查」块。
 *
 * 为什么要有它：README 里那份手写的工具表**一定会落后**。工具的**唯一真身是 schema**
 * （AI 看到的就是它），手写的投影改了工具不会跟着动。实测过的代价：本仓库的
 * `lanhu_read_design` 一度在 schema 里声明了 `limit` / `mapBox` / `toBox`，
 * 而文档和实现都没接上 —— 没人发现，因为文档是手抄的。
 *
 * 用法：
 *   node tools/gen-readme-tools.mjs            # 打印到 stdout
 *   node tools/gen-readme-tools.mjs --write    # 写回 README（替换 BEGIN/END 之间）
 *   node tools/gen-readme-tools.mjs --check    # 只校验，不一致就 exit 1（test/readme-test.mjs 用它）
 *
 * 约定：README 里必须有一对标记
 *   <!-- BEGIN GENERATED:tools -->   … 生成内容 …   <!-- END GENERATED:tools -->
 * 标记之外的内容由人维护，生成器**一个字节都不碰**。
 *
 * ⚠️ 行尾跟随 README 自身（LF / CRLF）—— `dsh-miliastra` 踩过：生成器写 LF 而 README 是 CRLF，
 *    比对报「差 148 字符」（147 行各多一个 \r），看着像内容不符其实只是行尾。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../lib/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const BEGIN = '<!-- BEGIN GENERATED:tools -->';
const END = '<!-- END GENERATED:tools -->';

/** 表格单元格转义：竖线会破表，换行会破行。 */
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim();

export function renderToolsBlock() {
  const L = [];
  L.push(BEGIN);
  L.push('');
  L.push(`**${TOOLS.length} 个工具。** 下面每一个字都来自 AI 在 schema 里看到的那份 —— 本节由 `
    + '`node tools/gen-readme-tools.mjs --write` 生成，**别手改**；改了工具忘了跑生成器，'
    + '`test/readme-test.mjs` 会**逐字比对**并报红。');
  L.push('');
  for (const t of TOOLS) {
    const required = new Set(t.parameters?.required ?? []);
    const props = Object.entries(t.parameters?.properties ?? {});
    L.push(`#### \`${t.name}\``);
    L.push('');
    L.push(cell(t.description));
    L.push('');
    if (props.length === 0) {
      L.push('*无参数。*');
    } else {
      L.push('| 参数 | 类型 | 必填 | 取值 | 说明 |');
      L.push('|---|---|---|---|---|');
      for (const [key, node] of props) {
        const values = Array.isArray(node.enum) && node.enum.length
          ? node.enum.map((v) => '`' + v + '`').join(' / ')
          : '—';
        L.push(`| \`${key}\` | \`${node.type ?? '?'}\` | ${required.has(key) ? '**是**' : '否'} | ${values} | ${cell(node.description)} |`);
      }
    }
    L.push('');
  }
  L.push(END);
  return L.join('\n');
}

const detectEol = (md) => (md.includes('\r\n') ? '\r\n' : '\n');

export function readReadme() {
  return fs.readFileSync(README, 'utf8');
}

/** 把生成块（LF）套进 README 的承载，行尾跟随 README。 */
export function applyBlock(md, block = renderToolsBlock()) {
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(`README 里找不到生成标记对（${BEGIN} … ${END}），请先手动放好再跑 --write`);
  }
  const eol = detectEol(md);
  const body = block.split('\n').join(eol);
  return { next: md.slice(0, i) + body + md.slice(j + END.length), eol };
}

/** 行尾无关的比较（CRLF 与 LF 视为相同）。 */
const normalize = (s) => s.replace(/\r\n/g, '\n');

export function check() {
  const md = readReadme();
  let current;
  try {
    current = applyBlock(md).next;
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (normalize(current) !== normalize(md)) {
    return { ok: false, reason: 'README 的生成块与 lib/index.js 的 TOOLS 不一致 —— 跑 `node tools/gen-readme-tools.mjs --write`' };
  }
  return { ok: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--check')) {
    const r = check();
    if (r.ok) { console.log('✅ README 的工具速查块与 TOOLS 一致'); process.exit(0); }
    console.error('❌ ' + r.reason);
    process.exit(1);
  } else if (args.has('--write')) {
    const md = readReadme();
    const { next } = applyBlock(md);
    if (normalize(next) === normalize(md)) {
      console.log('✅ 已经是最新的，未改动 README');
    } else {
      fs.writeFileSync(README, next);
      const before = normalize(md).length;
      const after = normalize(next).length;
      console.log(`✅ 已写回 README（${before} → ${after} 字符，${after - before >= 0 ? '+' : ''}${after - before}）`);
    }
  } else {
    process.stdout.write(renderToolsBlock() + '\n');
  }
}
