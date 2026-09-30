/**
 * 结构体检（零依赖）：
 *   1) 每个具名 import 都能在目标模块找到对应 export（删导出最容易踩这个）
 *   2) 列出「导出了但全仓库没人用」的符号
 * 用法：node scripts/check-structure.mjs   （第 1 项有问题时退出码非 0）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = /^(\.cache|node_modules|\.git|dist)$/;

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(path.join(dir, e.name)); }
    else if (/\.(mjs|js)$/.test(e.name)) files.push(path.join(dir, e.name));
  }
})(ROOT);

const textOf = new Map();
const exportsOf = new Map();
for (const f of files) {
  const t = fs.readFileSync(f, 'utf-8');
  textOf.set(f, t);
  const set = new Set();
  for (const m of t.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
  for (const m of t.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
  for (const m of t.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
  for (const m of t.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const nm = (bits.length > 1 ? bits[1] : bits[0]).trim();
      if (nm) set.add(nm);
    }
  }
  if (/^export\s+default\b/m.test(t)) set.add('default');
  if (/^export\s+\*/m.test(t)) set.add('*');
  exportsOf.set(f, set);
}

/* 1) 具名导入是否都有出处 */
let missing = 0; let checked = 0;
for (const f of files) {
  for (const m of textOf.get(f).matchAll(/import\s+([\s\S]*?)\s+from\s+['\"]([^'\"]+)['\"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    let target = path.resolve(path.dirname(f), spec);
    if (!textOf.has(target)) {
      if (textOf.has(target + '.mjs') || textOf.has(target + '.js')) target = textOf.has(target + '.mjs') ? target + '.mjs' : target + '.js';
      else { console.log('  无法解析 ' + rel(f) + ' → ' + spec); missing++; continue; }
    }
    const named = /\{([^}]*)\}/.exec(m[1]);
    if (!named) continue;
    const star = exportsOf.get(target).has('*');
    for (const part of named[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/)[0].trim();
      if (!nm) continue;
      checked++;
      if (!star && !exportsOf.get(target).has(nm)) {
        console.log('  缺失导出 ' + rel(f) + '  import ' + nm + ' ← ' + rel(target));
        missing++;
      }
    }
  }
}
console.log((missing ? '\u001b[31m' : '\u001b[32m') + '具名导入 ' + checked + ' 处 · ' + (missing ? missing + ' 处缺失' : '全部对得上') + '\u001b[0m');

/* 2) 没人用的导出（仅提示，不算失败） */
const dead = [];
for (const f of files) {
  for (const name of exportsOf.get(f)) {
    if (name === '*' || name === 'default') continue;
    /* $ 是合法标识符字符但 \b 不认它，用显式的「前后不是标识符字符」 */
    const esc = name.replace(/\$/g, '\\$');
    const re = new RegExp('(?<![\\w$])' + esc + '(?![\\w$])', 'g');
    /* 声明自己的那几行不算使用 */
    const decl = new RegExp('^\\s*export\\s+(?:(?:async\\s+)?(?:function|class)|(?:const|let|var))\\s+' + esc + '\\b|^\\s*export\\s*\\{[^}]*' + esc + '\\b');
    let hits = 0;
    for (const g of files) {
      const t = textOf.get(g);
      if (g === f) {
        for (const line of t.split(String.fromCharCode(10))) {
          if (decl.test(line)) continue;
          re.lastIndex = 0;
          if (re.test(line)) hits++;
        }
      } else { re.lastIndex = 0; hits += (t.match(re) || []).length; }
    }
    /* HTML 里可能以全局名出现 */
    const html = path.join(ROOT, 'public', 'index.html');
    if (fs.existsSync(html)) { re.lastIndex = 0; hits += (fs.readFileSync(html, 'utf-8').match(re) || []).length; }
    if (!hits) dead.push(rel(f) + '  →  ' + name);
  }
}
console.log('\u001b[33m无人引用的导出 ' + dead.length + ' 个\u001b[0m');
for (const d of dead) console.log('  · ' + d);
process.exit(missing ? 1 : 0);

function rel(f) { return path.relative(ROOT, f); }