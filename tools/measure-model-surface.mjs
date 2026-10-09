#!/usr/bin/env node
/**
 * measure-model-surface.mjs —— 量「模型读到的那一面」有多大。
 *
 * 为什么要有它：改工具 description / 参数说明 / SYSTEM_HINT 是**改了首轮提示**，
 * 而首轮提示的代价没有任何东西会报错（agent-experience 第 11 条：改定义要对比 token）。
 * 这里把「模型面」变成一条可复现的命令：改前 `--rev HEAD`、改后直接跑，比一比。
 *
 * 口径（**两项都给**，别只看一项）：
 *
 *   ① 宿主口径 —— 与 DSH 宿主的 `@deepseek-ai/dsh-token-meter/estimate` **同一个公式**：
 *        · 工具块：`ceil(JSON.stringify(tools).length / 4) + 4`
 *        · 系统提示：`ceil(text.length / 4) + 4`
 *      这是宿主给上下文计价用的数（`CHARS_PER_TOKEN = 4`、`BLOCK_OVERHEAD = 4`）。
 *      ⚠️ 对**中文密集**的文本它**明显低估**（中文 1 字 ≈ 1 token，公式按 4 字 ≈ 1 token 算）。
 *   ② CJK 口径 —— 更接近真实分词：`CJK 字数 × 1 + 其余字符数 / 4`。
 *      这个插件的提示与描述几乎全是中文，所以两项差 3~4 倍是正常的，**别拿①当真实开销**。
 *
 * 报告里 `字符` 一律是 **JS `.length`（UTF-16 code unit）** —— 与宿主 estimate 同口径。
 *
 * 用法：
 *   node tools/measure-model-surface.mjs              # 量当前工作树
 *   node tools/measure-model-surface.mjs --rev HEAD   # 量某个 git 版本（改前基线）
 *   node tools/measure-model-surface.mjs --json       # 机器可读
 *   node tools/measure-model-surface.mjs --detail      # 逐个工具的量
 *
 * 注：`output.schema` **不进首轮提示**（宿主只把 `{name, description, parameters}` 投影给模型，
 * 见 `dsh-tools` 的 `schemaOf`），所以它单列一栏、**不计入**「首轮提示」合计。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

/* ── 宿主口径的两个公式（与 dsh-token-meter/estimate 逐字一致；下面会尝试动态导入做对拍）── */
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const hostToolsTokens = (tools) => Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
const hostSystemTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN) + 4;

/* ── CJK 口径 ── */
const isCJK = (cp) => (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x3400 && cp <= 0x4dbf)
  || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2ffff);
function cjkStats(s) {
  let cjk = 0;
  for (const ch of s) if (isCJK(ch.codePointAt(0))) cjk += 1;
  const other = s.length - cjk;
  return { cjk, other, est: cjk + Math.ceil(other / 4) };
}

/** 一份「模型面」的价签。 */
function price(label, s) {
  const { cjk, other, est } = cjkStats(s);
  return { label, chars: s.length, cjk, other, host: Math.ceil(s.length / 4) + 4, cjkEst: est };
}

/** 与真实宿主模块对拍（拿不到就只说清依据，不当失败）。 */
async function crossCheckHostFormula() {
  const cands = [
    process.env.DSH_TOKEN_METER,
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/estimate.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh-token-meter/lib/types/estimate.js'),
  ].filter(Boolean);
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const m = await import(pathToFileURL(p).href);
    const tools = [{ name: 'x', description: '汉'.repeat(9), parameters: { type: 'object' } }];
    const mine = hostToolsTokens(tools);
    const real = m.estimateToolsTokens({ tools });
    const sys = hostSystemTokens('汉'.repeat(11));
    const realSys = m.estimateSystemMessage({ role: 'system', content: [{ type: 'text', text: '汉'.repeat(11) }] });
    return { path: p, ok: mine === real && sys === realSys, mine, real, sys, realSys };
  }
  return null;
}

/** 载入一份 lib/index.js：当前工作树，或某个 git 版本（改前基线）。 */
async function load(rev) {
  let modPath = path.join(ROOT, 'lib', 'index.js');
  let tmp = null;
  if (rev) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanhu-measure-'));
    for (const rel of ['lib/index.js', 'lanhu.mjs']) {
      const out = execFileSync('git', ['show', `${rev}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const dst = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, out);
    }
    modPath = path.join(tmp, 'lib', 'index.js');
  }
  const mod = await import(pathToFileURL(modPath).href);
  return { mod, modPath, tmp };
}

/** 取**模型真正读到的那份** SYSTEM_HINT（源码里的是拼接表达式，验不出真值）。 */
function captureSystemHint(mod) {
  let hint = null;
  mod.apply({
    inject: (_svcs, fn) => fn({
      effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
      get: (n) => (n === 'systemPrompt'
        ? { section: (s) => { hint = s.text; return () => {}; } }
        : { register: () => () => {} }),
    }),
  });
  return hint;
}

const { mod, tmp } = await load(opt('--rev'));
const hint = captureSystemHint(mod);
const tools = mod.TOOLS;
const modelTools = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

const rows = [];
for (const t of tools) {
  const modelFacing = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
  const outSchema = JSON.stringify(t.output?.schema ?? null);
  rows.push({
    name: t.name,
    descChars: (t.description ?? '').length,
    paramsChars: JSON.stringify(t.parameters).length,
    modelChars: modelFacing.length,
    ...price('model', modelFacing),
    outputSchemaChars: outSchema.length,
  });
}

const total = {
  system: price('SYSTEM_HINT', hint),
  toolBlockChars: JSON.stringify(modelTools).length,
  toolBlockHost: hostToolsTokens(modelTools),
  descChars: tools.reduce((a, t) => a + (t.description ?? '').length, 0),
  paramsChars: tools.reduce((a, t) => a + JSON.stringify(t.parameters).length, 0),
  outputSchemaChars: rows.reduce((a, r) => a + r.outputSchemaChars, 0),
  outputSchemaHost: Math.ceil(rows.reduce((a, r) => a + r.outputSchemaChars, 0) / 4),
};
total.modelCjkEst = cjkStats(JSON.stringify(modelTools)).est;
total.firstTurnChars = total.system.chars + total.toolBlockChars;
total.firstTurnHost = total.system.host + total.toolBlockHost;
total.firstTurnCjkEst = total.system.cjkEst + total.modelCjkEst;

const cc = await crossCheckHostFormula();

if (flag('--json')) {
  console.log(JSON.stringify({ rev: opt('--rev') ?? 'worktree', crossCheck: cc, total, tools: rows }, null, 1));
} else {
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  const num = (n) => String(n).padStart(9);
  console.log(`# 模型面体量（rev=${opt('--rev') ?? 'worktree'}，${tools.length} 个工具）\n`);
  console.log(`${pad('部分', 26)}${'字符'.padStart(9)}${'CJK 字'.padStart(9)}${'宿主口径'.padStart(11)}${'CJK 口径'.padStart(11)}`);
  console.log(`${pad('SYSTEM_HINT（系统提示）', 26)}${num(total.system.chars)}${num(total.system.cjk)}${num(total.system.host)}${num(total.system.cjkEst)}`);
  console.log(`${pad('18 个工具（首轮提示的部分）', 26)}${num(total.toolBlockChars)}${num(cjkStats(JSON.stringify(modelTools)).cjk)}${num(total.toolBlockHost)}${num(total.modelCjkEst)}`);
  console.log('  └ 其中 description 合计 ' + total.descChars + ' 字符 / parameters 合计 ' + total.paramsChars + ' 字符');
  console.log(`${pad('★ 首轮提示合计', 26)}${num(total.firstTurnChars)}${num(total.system.cjk + cjkStats(JSON.stringify(modelTools)).cjk)}${num(total.firstTurnHost)}${num(total.firstTurnCjkEst)}`);
  console.log(`${pad('（参考）output.schema 合计', 26)}${num(total.outputSchemaChars)}${''.padStart(9)}${num(total.outputSchemaHost)}${''.padStart(11)}   ← 不进首轮提示`);
  if (flag('--detail')) {
    console.log('');
    console.log(`${pad('工具', 30)}${'description'.padStart(12)}${'parameters'.padStart(11)}${'模型面字符'.padStart(11)}${'宿主口径'.padStart(10)}`);
    for (const r of rows.slice().sort((a, b) => b.modelChars - a.modelChars)) {
      console.log(`${pad(r.name, 30)}${num(r.descChars)}${num(r.paramsChars)}${num(r.modelChars)}${num(Math.ceil(r.modelChars / 4))}`);
    }
  }
  console.log('');
  console.log(cc
    ? (cc.ok ? `✅ 宿主口径公式与真实模块对拍一致（${cc.path}）` : `❌ 对拍**不一致**：我算 ${cc.mine}/${cc.sys}，真实模块 ${cc.real}/${cc.realSys}`)
    : '⚠️ 没找到 dsh-token-meter 模块，宿主口径按 replicate（CHARS_PER_TOKEN=4 / BLOCK_OVERHEAD=4 / 系统 +4）计算');
}
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
