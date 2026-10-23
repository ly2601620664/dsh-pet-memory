// 在隔离目录里用假 ctx 跑一遍插件，验证不依赖 DSH 也能加载与工作。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'petmem-plugin-'));
const pkgDir = join(root, 'plugin');
mkdirSync(pkgDir, { recursive: true });
cpSync(new URL('../index.js', import.meta.url), join(pkgDir, 'index.js'));
cpSync(new URL('../lib', import.meta.url), join(pkgDir, 'lib'), { recursive: true });
cpSync(new URL('../package.json', import.meta.url), join(pkgDir, 'package.json'));

// stub @deepseek-ai/dsh-tools，并让插件数据目录指向临时目录
const stubDir = join(pkgDir, 'node_modules', '@deepseek-ai', 'dsh-tools');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }));
writeFileSync(join(stubDir, 'index.js'), 'export const defineTool = (spec) => spec;\n');

const dataDir = join(root, 'data');
process.env.DSH_PET_MEMORY_DIR = dataDir;

const { apply } = await import('file://' + join(pkgDir, 'index.js').replaceAll('\\', '/'));
const mod = await import('file://' + join(pkgDir, 'index.js').replaceAll('\\', '/'));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n, extra); } };

const tools = new Map();
const sections = [];
const listeners = [];
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  systemPrompt: { section: (s) => sections.push(s) },
  on: (evt, fn) => { listeners.push([evt, fn]); },
  logger: { info: () => {}, warn: () => {} },
};

const api = apply(ctx, {});
ok('apply 返回 store', !!api?.store);
ok('注册了提示词段', sections.length === 1 && sections[0].name === 'pet-memory');
ok('注册了 3 个工具', tools.size === 3, String(tools.size));
ok('挂了 session/event 监听', listeners.some(([e]) => e === 'session/event'));

// 工具：写一条，再搜
const add = tools.get('memory_add');
const search = tools.get('memory_search');
const r1 = add.execute({ text: '他喜欢喝冰美式', kind: 'preference', tags: '吃的', salience: 4 }, {});
ok('memory_add 成功', r1.ok === true, JSON.stringify(r1));
const r2 = search.execute({ query: '他喝什么' }, {});
ok('memory_search 命中', r2.ok && r2.message.includes('冰美式'), JSON.stringify(r2.message));

// 提示词段包含记忆
const text = sections[0].text();
ok('提示词段含记忆', text.includes('冰美式'), text.slice(0, 120));

// 模拟一轮对话，验证回合结束抽取
const session = { id: 's1' };
const fire = (type, content) => {
  for (const [e, fn] of listeners) if (e === 'session/event') fn(session, { type, data: { content } });
};
fire('user/message', '我今天加班到很晚，好累，想吃辣的');
fire('assistant/message', '辛苦啦');
fire('turn/end', '');
const all = api.store.facts().map((f) => f.text).join(' | ');
ok('回合结束能抽取', /喜欢|累|吃/.test(all), all);

// 人格读写
const prof = tools.get('memory_profile');
prof.execute({ content: '- 我叫他笨蛋' }, {});
ok('档案写入', prof.execute({}, {}).message.includes('笨蛋'));

// 兜底：没有 systemPrompt 服务也不崩
const ctx2 = { tools: { register: (t) => tools.set('x' + t.name, t) }, on: () => {}, logger: { warn: () => {} } };
try { (apply)(ctx2, { dir: join(root, 'data2') }); ok('缺 systemPrompt 时降级', true); }
catch (e) { ok('缺 systemPrompt 时降级', false, e.message); }

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);