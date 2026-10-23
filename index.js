/**
 * dsh-pet-memory — 陪伴型长期记忆插件。
 *
 * 设计参考：腾讯 TencentDB-Agent-Memory 的分层（对话→事实→场景→人格）+
 * mem0 的"抽取→去重→检索" + dsh-living-memory 的时间衰减/命中强化。
 * 全部本地文件，不调额外模型，不花钱。
 *
 * 三个注入点：
 *  1) systemPrompt.section：每轮把「人格 + 高价值记忆」放进系统提示词
 *  2) 工具：memory_search / memory_add / memory_profile
 *  3) session/event：回合结束时用规则抽取新事实（失败记日志，不影响对话）
 *
 * v2 修复的严重问题（见审查报告）：
 *  - section 必须 interpolate:false：宿主会对 section 跑 {{var}} 插值，
 *    记忆里出现 {{ 会让整轮 renderPrompt 抛错。已经在 recall 层 neutralize 兜底。
 *  - textOf 用 '\n' 而非 ' ' 拼接 block：空格会把多块压成一行，行首锚定的清洗规则全部失效。
 *  - memory_search 按 id 做命中反馈：原来 hits.includes(f.text) 是字符串子串匹配，会误伤。
 *  - catch 不再静默：落盘失败要有 warn 日志，否则"以为在记其实没记"。
 *  - 监听器用 ctx.effect 注册，可随插件卸载回收。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync, existsSync } from 'node:fs';
import { MemoryStore, defaultDir } from './lib/store.mjs';
import { extractFacts, summarizeScene, isNearDuplicate, isPromptInjection } from './lib/extract.mjs';
import { standingBlock, recall, neutralize } from './lib/recall.mjs';

export const name = 'dsh-pet-memory';
export const inject = ['tools', 'systemPrompt'];

const jsonOutput = (message) => ({
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
});

const errText = (error) => `${error?.code ? error.code + ': ' : ''}${error?.message ?? error}`;

export function apply(ctx, config = {}) {
  const store = new MemoryStore(config.dir || defaultDir());
  const warn = (msg, error) => {
    const line = `[pet-memory] ${msg}${error ? ` (${errText(error)})` : ''}`;
    if (config.verbose || error) ctx.logger?.warn?.(line);
  };

  // 一次性迁移旧的 memory.md（只有空库时）
  try {
    if (config.migrateFrom && store.facts().length === 0 && existsSync(config.migrateFrom)) {
      store.importMarkdown(readFileSync(config.migrateFrom, 'utf8'));
    }
  } catch (error) {
    warn('迁移旧 memory.md 失败', error);
  }

  // ---- 1) 系统提示词注入 ----
  const maxItems = Number.isFinite(config.maxItems) ? config.maxItems : 6;
  const includeScenes = config.includeScenes !== false;
  const sectionText = () => {
    try {
      const block = standingBlock(store, { maxItems, includeScenes });
      if (!block) return '';
      return '## 长期记忆（你自己记的，自然使用，别说"根据我的记忆"）\n' + block;
    } catch (error) {
      warn('渲染长期记忆段失败', error);
      return '';
    }
  };
  try {
    // interpolate:false 是必须的：记忆是用户可控数据，不能让它参与 {{var}} 插值。
    // 参考 dsh-ops/lib/index.js 的同款写法。
    ctx.systemPrompt.section({
      name: 'pet-memory',
      order: 400,
      interpolate: false,
      text: sectionText,
    });
  } catch (error) {
    // 老版本没有 systemPrompt 服务时退化为只提供工具
    warn('无法注册提示词段，退化为仅工具模式', error);
  }

  // ---- 2) 工具 ----
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '查长期记忆。当你需要想起他之前说过的事（喜好、习惯、约定、关系进展）时调用。返回按相关度和时间衰减排序的条目。',
    parameters: {
      query: { type: 'string', description: '要查的话题或关键词，中英文都行' },
      limit: { type: 'number', description: '返回几条，默认 5，最多 20' },
    },
    output: jsonOutput(),
    execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { ok: false, message: '需要 query' };
      const n = Math.max(1, Math.min(20, Number(args.limit) || 5));
      try {
        const hits = recall(store, query, { limit: n });
        if (!hits.length) return { ok: true, message: '没有找到相关记忆。' };
        // 按 id 做命中反馈：一次写盘，不做文本子串匹配
        for (const f of hits) store.touch(f.id);
        return {
          ok: true,
          message: ['## 和当前话题相关的旧记忆', ...hits.map((f) => `- ${neutralize(f.text)}`)].join('\n'),
        };
      } catch (error) {
        warn('查询记忆失败', error);
        return { ok: false, message: `查询记忆失败：${errText(error)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: '手动往长期记忆里写一条。只在对话里出现了值得长期记住的事实（喜好/约定/重要事件/关系变化）时用。',
    parameters: {
      text: { type: 'string', description: '一句话描述，例如「他喜欢喝冰美式」' },
      kind: { type: 'string', description: '类型: profile / preference / event / promise / relationship / lesson，默认 profile' },
      tags: { type: 'string', description: '标签，空格分隔，例如「吃的 作息」' },
      salience: { type: 'number', description: '重要度 1-5，默认 3' },
    },
    output: jsonOutput(),
    execute(args) {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { ok: false, message: '需要 text' };
      // 工具入口同样要拦指令性内容：这条会进系统提示词，不能当指令通道
      if (isPromptInjection(text)) {
        return { ok: false, message: '这条看起来是指令而不是关于他的事实，没有写入。' };
      }
      try {
        const fact = store.addFact({
          kind: typeof args.kind === 'string' ? args.kind.trim() : 'profile',
          text,
          tags: typeof args.tags === 'string' ? args.tags.split(/\s+/).filter(Boolean) : [],
          salience: Number(args.salience) || 3,
          source: 'tool',
        });
        return { ok: true, message: fact ? `记下了：${neutralize(fact.text)}` : '这条已经记过了。' };
      } catch (error) {
        warn('写入记忆失败', error);
        return { ok: false, message: `写入失败：${errText(error)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_profile',
    description: '读或改「长期人格/关系档案」（L3）。不传 content 就是读；传了就把整段档案替换成新内容。',
    parameters: {
      content: { type: 'string', description: '新的档案正文（可选）' },
    },
    output: jsonOutput(),
    execute(args) {
      try {
        if (typeof args.content === 'string' && args.content.trim()) {
          const next = args.content.trim().slice(0, 4000);
          if (isPromptInjection(next)) {
            return { ok: false, message: '这段档案里含指令性内容，没有写入。' };
          }
          store.setPersona(next);
          return { ok: true, message: '档案已更新。' };
        }
        const persona = store.persona();
        return { ok: true, message: persona ? neutralize(persona) : '还没有写档案。' };
      } catch (error) {
        warn('读写档案失败', error);
        return { ok: false, message: `档案操作失败：${errText(error)}` };
      }
    },
  }));

  // ---- 3) 回合结束抽取 ----
  try {
    const buffers = new Map();
    const keyOf = (session) => String(session?.id || session?.key || 'default');

    // 关键：用 '\n' 拼接 block。用空格会把多块压成一行，
    // 而清洗规则里的行首锚定（Current runtime context 之类）就全失效了。
    // 另外只取 type === 'text' 的块：assistant 消息里 reasoning 是并列 block，
    // 那是模型的内心推理，绝不能当成"他说的话"写进记忆。
    const textOf = (event) => {
      const data = event?.data ?? event;
      const content = data?.content ?? data?.text ?? data?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((p) => {
            if (typeof p === 'string') return p;
            const type = p?.type;
            // 有 type 且不是 text → 丢弃（reasoning / tool-call / image 等）
            if (type !== undefined && type !== 'text') return '';
            return typeof p?.text === 'string' ? p.text : '';
          })
          .filter(Boolean)
          .join('\n');
      }
      return '';
    };

    const extractTurn = (key) => {
      const list = buffers.get(key) || [];
      buffers.delete(key);                    // 不留下空数组键
      const userText = list.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      if (!userText.trim()) return;
      let added = 0;
      const known = store.facts().map((f) => f.text);
      for (const f of extractFacts(userText)) {
        if (isNearDuplicate(f.text, known)) continue;
        if (store.addFact({ ...f, source: 'turn' })) { known.push(f.text); added++; }
      }
      if (list.length >= 4) {
        const scene = summarizeScene(list);
        if (scene) store.addScene(scene);     // addScene 内部去重 + 空摘要不写
      }
      if (added && config.verbose) ctx.logger?.info?.(`[pet-memory] 本轮抽到 ${added} 条`);
    };

    const listener = (session, event) => {
      const key = keyOf(session);
      try {
        const type = event?.type;
        // 只认真正的追加型消息：compaction/fork 的重放（surfaceOp !== 'append'）不重复抽取
        const surfaceOp = event?.surfaceOp ?? event?.data?.surfaceOp;
        if (surfaceOp !== undefined && surfaceOp !== 'append') return;
        if (type === 'user/message' || type === 'assistant/message' || type === 'message') {
          const text = textOf(event);
          if (!text) return;
          const list = buffers.get(key) || [];
          list.push({ role: String(type).startsWith('user') ? 'user' : 'assistant', content: text });
          if (list.length > 12) list.shift();
          buffers.set(key, list);
          return;
        }
        if (type === 'turn/end') extractTurn(key);
      } catch (error) {
        // 抽取失败不打断对话，但必须留痕
        warn(`回合抽取失败 (session=${key})`, error);
      }
    };

    // 用 ctx.effect 注册，插件卸载时监听器与缓冲一起回收
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const off = ctx.on('session/event', listener, { global: true });
        return () => {
          try { off?.(); } catch { /* 忽略重复释放 */ }
          buffers.clear();
        };
      }, 'pet-memory: turn extraction');
    } else {
      ctx.on('session/event', listener, { global: true });
    }
  } catch (error) {
    // 没有事件总线时只保留工具与提示词
    warn('无法挂载回合抽取，退化为仅工具/提示词模式', error);
  }

  return { store };
}

export default { name, inject, apply };
