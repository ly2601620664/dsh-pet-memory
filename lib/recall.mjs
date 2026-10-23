// 检索：中文 bigram + 英文词，打分 = 相关度 × 重要度 × 时间衰减，
// 输出可直接塞进 system prompt 的块。
//
// v2 的变化：
//  - 所有进入提示词的文本都过 neutralize()，把 {{...}} 中和掉。
//    宿主 @deepseek-ai/dsh-system-prompt 的 renderPrompt() 会对每个 section 跑
//    interpolate()，遇到未知/畸形 {{var}} 直接抛错 → 整轮 step 崩。记忆是用户
//    可控数据，不能让它带模板语法进提示词。
//  - 场景层接上真实读取方（includeScenes），不再是只写不读的死数据。
const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '就是', '什么', '怎么', '因为', '所以', '但是', '如果', '可以', '一个', '现在', '今天', '明天']);

export function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const zh = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of zh) {
    for (let i = 0; i < seg.length - 1; i++) {
      const bi = seg.slice(i, i + 2);
      if (!STOP.has(bi)) out.add(bi);
    }
  }
  return out;
}

/**
 * 中和提示词模板语法：{{ → ｛｛，}} → ｝｝。
 * 用全角字符替换，人读起来几乎一致，但宿主 interpolate() 不再认为是变量引用。
 */
export function neutralize(text) {
  return String(text ?? '').replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.sqrt(a.size * b.size);
}

const DAY = 86400000;

export function scoreFact(fact, queryTokens, now = Date.now(), { halfLifeDays = 45, query = '' } = {}) {
  const label = String(fact.text ?? fact.summary ?? fact.title ?? '');
  const text = [label, ...(fact.tags || [])].join(' ');
  const rel = overlap(queryTokens, tokens(text));
  const ageDays = Math.max(0, (now - (fact.ts || now)) / DAY);
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  const hitBoost = 1 + Math.min(0.6, 0.15 * (fact.hits || 0));
  const salience = 0.6 + 0.1 * (fact.salience || 3);
  const kindBoost = fact.kind === 'relationship' ? 1.15 : fact.kind === 'promise' ? 1.1 : 1;
  // 短查询（中文一两个字）用子串直配，避免 bigram 落空
  const sub = query && label.includes(query) ? 2 : 0;
  // 字符级重合兜底：中文分词不完美时（"他喝什么" vs "他喜欢喝冰美式"）还能捞到
  const qChars = [...new Set([...String(query || '')].filter((c) => /[\u4e00-\u9fa5a-z0-9]/.test(c)))];
  const hitChars = qChars.filter((c) => text.includes(c)).length;
  const charOverlap = qChars.length ? hitChars / qChars.length : 0;
  return rel * 6 + sub + charOverlap * 2 + decay * 0.8 + (salience - 1) + (rel > 0 ? hitBoost * kindBoost - 1 : 0);
}

/**
 * 检索事实。
 * @returns {Array<object>} 带 id 的事实对象数组（调用方按 id 做命中反馈，不要用文本匹配）
 */
export function recall(store, query, { limit = 5, minScore = 0.9 } = {}) {
  const qt = tokens(query);
  const now = Date.now();
  const scored = store.facts()
    .map((f) => ({ f, s: scoreFact(f, qt, now, { query }) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(({ f, s }) => ({ ...f, score: Number(s.toFixed(3)) }));
}

/** 检索历史场景（L2）。没有命中返回空数组。 */
export function recallScenes(store, query, { limit = 2 } = {}) {
  const scenes = typeof store.scenes === 'function' ? store.scenes() : [];
  if (!scenes.length) return [];
  const qt = tokens(query);
  const now = Date.now();
  return scenes
    .map((s) => ({ s, score: scoreFact({ ...s, kind: 'scene' }, qt, now, { query }) }))
    .filter((x) => x.score >= 2.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ s, score }) => ({ ...s, score: Number(score.toFixed(3)) }));
}

export function standingBlock(store, { maxItems = 5, query = '', includeScenes = false } = {}) {
  const persona = neutralize(store.persona().trim());
  const picked = recall(store, query || '关系 喜欢 习惯 约定', { limit: maxItems });
  const scenes = includeScenes ? recallScenes(store, query || '关系 喜欢 习惯 约定', { limit: 2 }) : [];
  if (!persona && !picked.length && !scenes.length) return '';
  const lines = [];
  if (persona) lines.push('## 关于我（长期记忆）', persona.slice(0, 1200), '');
  if (picked.length) {
    lines.push('## 你现在记得的事（自然使用，不要复述成清单）');
    for (const f of picked) lines.push(`- [${f.kind}] ${neutralize(f.text)}`);
  }
  if (scenes.length) {
    if (picked.length) lines.push('');
    lines.push('## 你们之前一起经历过的事（可自然提起，别当清单念）');
    for (const s of scenes) lines.push(`- ${neutralize(s.title)}：${neutralize(s.summary).slice(0, 160)}`);
  }
  return lines.join('\n');
}

export function recallBlock(store, query, { limit = 4 } = {}) {
  const hits = recall(store, query, { limit });
  if (!hits.length) return '';
  return ['## 和当前话题相关的旧记忆', ...hits.map((f) => `- ${neutralize(f.text)}`)].join('\n');
}
