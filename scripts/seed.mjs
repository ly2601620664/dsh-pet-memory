// 一次性：把旧 memory.md 的内容灌进插件数据库。
// 用法： node scripts/seed.mjs "C:\path\to\memory.md"
import { readFileSync, existsSync } from 'node:fs';
import { MemoryStore, defaultDir } from '../lib/store.mjs';

const mdPath = process.argv[2] || process.env.DSH_PET_SEED_MD;
const dir = defaultDir();
const store = new MemoryStore(dir);

if (!mdPath || !existsSync(mdPath)) {
  console.log('没有给出 memory.md 路径，跳过导入。数据目录:', dir);
  process.exit(0);
}

const md = readFileSync(mdPath, 'utf8');
const before = store.facts().length;
const added = store.importMarkdown(md);

// 从 md 里抽几行做 L3 人格档案
const pick = (label) => {
  const m = md.match(new RegExp(`${label}[：:]\\s*(.+)`));
  return m ? m[1].trim() : '';
};
const lines = [];
for (const [label, tpl] of [
  ['称呼', (v) => `我叫他「${v.replace(/^我叫他/, '').replace(/（.*?）/, '').trim()}」`],
  ['他怎么叫我', (v) => `他叫我${v}`],
  ['阶段', (v) => `关系阶段 ${v.match(/\d/)?.[0] || v}`],
]) {
  const v = pick(label);
  if (v) lines.push(tpl(v));
}
if (lines.length) store.setPersona(lines.join('\n'));

console.log(`数据目录: ${dir}`);
console.log(`导入前 ${before} 条，导入后 ${store.facts().length} 条（新增 ${added}）`);
console.log('人格档案:\n' + (store.persona() || '(空)'));