// 自测：不依赖 DSH，直接跑 node test/selftest.mjs
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../lib/store.mjs';
import { extractFacts } from '../lib/extract.mjs';
import { recall, standingBlock, recallBlock } from '../lib/recall.mjs';

const dir = mkdtempSync(join(tmpdir(), 'petmem-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const store = new MemoryStore(dir);

// 1. 抽取
const turn = '我今天好累啊，在打英雄联盟。我喜欢吃辣，不吃香菜。叫我阿哲就行。我答应你打完这局就睡。';
const facts = extractFacts(turn);
console.log('抽取到:', facts.map((f) => f.text));
ok('抽到事实', facts.length >= 3, String(facts.length));
ok('抽到喜欢', facts.some((f) => f.text.includes('喜欢')));
ok('抽到称呼', facts.some((f) => f.text.includes('阿哲')));

// 2. 写入
for (const f of facts) store.addFact(f);
ok('写入条数', store.facts().length === facts.length, String(store.facts().length));

// 3. 去重
store.addFact({ kind: facts[0].kind, text: facts[0].text, salience: 4 });
ok('去重生效', store.facts().length === facts.length);

// 4. 检索
const hits = recall(store, '他喜欢吃什么', { limit: 3 });
console.log('检索:', hits.map((h) => `${h.text}(${h.score})`));
ok('检索命中吃', hits.some((h) => h.text.includes('辣') || h.text.includes('吃')));

// 5. 时间衰减：很老的记忆分数更低
store.addFact({ kind: 'event', text: '他说他喜欢吃辣椒炒肉', salience: 3, ts: Date.now() - 365 * 86400000 });
const newHits = recall(store, '他喜欢吃什么', { limit: 5 });
const old = newHits.find((h) => h.text.includes('辣椒炒肉'));
const fresh = newHits.find((h) => h.text.includes('辣') && !h.text.includes('辣椒炒肉'));
ok('衰减让旧记忆靠后', !old || !fresh || fresh.score >= old.score);

// 6. 人格块
store.setPersona('- 我叫他笨蛋\n- 他叫我小可爱');
const block = standingBlock(store, { query: '喜欢', maxItems: 3 });
console.log('--- standing block ---\n' + block);
ok('人格块含 persona', block.includes('笨蛋'));
ok('人格块含记忆', block.includes('[preference]'));
ok('recallBlock 能出内容', recallBlock(store, '吃').includes('辣') || recallBlock(store, '吃').length > 0);

// 7. 导入旧 markdown
const n = store.importMarkdown('# 用户档案\n- 称呼：我叫他「笨蛋」\n- 阶段：3\n- 例：不要提他前任');
ok('导入 markdown', n >= 2, String(n));

// 8. v2 回归：注入的运行时上下文 / 转写残句不能被抽成事实
const dirty = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  '<dsh_im_source>{"channel":"weixin","conversationType":"direct"}',
  'Time sampled while preparing turn 1, step 1: 2026-10-22T04:54:31+08:00',
  '下次重启又 disconnected：给 id: openviking-memory',
  '他最近谁」这个想法',
  '你叫我笨蛋干嘛',
  '约定：明天说 / 不要，游走了',
].join('\n');
const junkFacts = extractFacts(dirty, { max: 10 });
ok('不抽系统垃圾', junkFacts.length === 0, JSON.stringify(junkFacts.map((f) => f.text)));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);