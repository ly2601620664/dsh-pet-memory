// 记忆存储：纯文件、append-only。
//
// 设计要点（v2）：
//  - facts.jsonl 只追加，永不重写 → 多进程（桌面端 + web 端）并发写不会互相覆盖
//  - hits.jsonl 只追加命中快照（后写赢）→ touch 不再触碰 facts.jsonl 正文
//  - 读取时折叠：同 kind+text 合并、salience 取最大、hits 累加
//  - scenes.jsonl 只追加（兼容旧的 scenes.json 数组格式）
//
// 为什么不用 tmp+rename：rename 是"整文件替换"，任何基于旧快照的替换都会
// 抹掉别的进程刚追加的行。append-only + 读取时折叠把这个窗口彻底消掉了。
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function defaultDir() {
  return process.env.DSH_PET_MEMORY_DIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-pet-memory');
}

const KINDS = new Set(['profile', 'preference', 'event', 'promise', 'relationship', 'scene', 'lesson']);
const MAX_SCENES = 200;
const dedupeKey = (kind, text) => `${kind}\u0000${text}`;

// 历史场景里混进过运行时上下文（旧版 textOf 用空格拼 block 导致清洗失效）。
// 读取时把这类片段剔掉，剔干净后没内容的整条丢弃——不让旧垃圾继续进提示词。
const SCENE_NOISE = [
  /Current runtime context\.?[^/]*/gi,
  /This snapshot supersedes[^/]*/gi,
  /Time sampled while preparing[^/]*/gi,
  /Browser time zone:[^/]*/gi,
  /Approval policy:[^/]*/gi,
  /<dsh_im_source>[\s\S]*?(?=\/|$)/gi,
  /<dsh_im_reply_to>[\s\S]*?(?=\/|$)/gi,
  /<system-reminder>[\s\S]*?(?=\/|$)/gi,
];

function cleanSceneText(text) {
  let s = String(text || '');
  for (const re of SCENE_NOISE) s = s.replace(re, '');
  return s.replace(/\s*\/\s*(?=\/|$)/g, '').replace(/\s{2,}/g, ' ').trim();
}

export class MemoryStore {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.factsPath = join(dir, 'facts.jsonl');
    this.hitsPath = join(dir, 'hits.jsonl');
    this.statePath = join(dir, 'state.json');
    this.personaPath = join(dir, 'persona.md');
    this.scenesPath = join(dir, 'scenes.json');       // 旧格式（只读兼容）
    this.scenesLogPath = join(dir, 'scenes.jsonl');   // 新格式（append-only）
    this._facts = null;
    this._hits = null;
    this._scenes = null;
  }

  /* ---------------- 低层：安全读行 / 追加 ---------------- */

  _readLines(path) {
    if (!existsSync(path)) return [];
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* 跳过坏行，不拖垮整库 */ }
    }
    return out;
  }

  // append-only 落盘。单行写入远小于一个块，O_APPEND 下多进程是安全的。
  _append(path, obj) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
  }

  /* ---------------- 命中统计（独立文件，只追加） ---------------- */

  _hitMap() {
    if (this._hits) return this._hits;
    const m = new Map();
    for (const rec of this._readLines(this.hitsPath)) {
      if (!rec || typeof rec.id !== 'string') continue;
      const prev = m.get(rec.id);
      // 后写赢：取最大的 hits（避免并发下的回退），lastHit 取最新
      m.set(rec.id, {
        hits: Math.max(prev?.hits ?? 0, Number(rec.hits) || 0),
        lastHit: Math.max(prev?.lastHit ?? 0, Number(rec.lastHit) || 0),
      });
    }
    this._hits = m;
    return m;
  }

  /* ---------------- facts（append-only + 折叠） ---------------- */

  facts() {
    if (this._facts) return this._facts;
    const rows = this._readLines(this.factsPath);
    const hits = this._hitMap();
    const byKey = new Map();
    for (const row of rows) {
      if (!row || typeof row.text !== 'string' || !row.text) continue;
      const kind = KINDS.has(row.kind) ? row.kind : 'fact';
      const text = String(row.text).trim().slice(0, 500);
      if (!text) continue;
      const key = dedupeKey(kind, text);
      const ts = Number(row.ts) || Date.now();
      const salience = Math.max(1, Math.min(5, Number(row.salience) || 3));
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          id: typeof row.id === 'string' && row.id ? row.id : randomUUID().slice(0, 12),
          ts, kind, text,
          tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : [],
          salience,
          source: typeof row.source === 'string' ? row.source.slice(0, 200) : '',
          hits: Math.max(0, Number(row.hits) || 0),
          lastHit: Math.max(0, Number(row.lastHit) || 0),
          _ids: [row.id].filter(Boolean),
        });
      } else {
        // 同一条事实被追加过多次：salience 取最大，ts 取最早，hits 取最大
        prev.salience = Math.max(prev.salience, salience);
        prev.ts = Math.min(prev.ts, ts);
        prev.hits = Math.max(prev.hits, Math.max(0, Number(row.hits) || 0));
        prev.lastHit = Math.max(prev.lastHit, Math.max(0, Number(row.lastHit) || 0));
        if (!prev.tags.length && Array.isArray(row.tags)) prev.tags = row.tags.slice(0, 12);
        if (row.id) prev._ids.push(row.id);
      }
    }
    // 叠加独立命中文件里的统计（任一别名 id 命中都算）
    for (const f of byKey.values()) {
      for (const id of f._ids) {
        const h = hits.get(id);
        if (!h) continue;
        f.hits += h.hits;
        f.lastHit = Math.max(f.lastHit, h.lastHit);
      }
      delete f._ids;
    }
    this._facts = [...byKey.values()].sort((a, b) => a.ts - b.ts);
    return this._facts;
  }

  /** 丢弃内存快照，让下一次读取重新折叠磁盘内容（跨进程协作时用）。 */
  reload() {
    this._facts = null;
    this._hits = null;
    this._scenes = null;
    return this;
  }

  addFact({ kind = 'fact', text, tags = [], salience = 3, source = '', ts = Date.now() }) {
    const cleanText = String(text || '').trim().slice(0, 500);
    if (!cleanText) return null;
    const cleanKind = KINDS.has(kind) ? kind : 'fact';
    const nextSalience = Math.max(1, Math.min(5, Number(salience) || 3));
    const cleanTags = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);

    // 先看磁盘（别的进程可能刚写过），再判重
    this.reload();
    const dup = this.facts().find((f) => f.text === cleanText && f.kind === cleanKind);
    if (dup) {
      // 只有重要度真的更高时才追加一条升级记录（append-only，不重写正文）
      if (nextSalience > dup.salience) {
        this._append(this.factsPath, {
          id: dup.id, ts: Date.now(), kind: cleanKind, text: cleanText,
          tags: cleanTags.length ? cleanTags : dup.tags, salience: nextSalience, source,
        });
        this.reload();
      }
      return this.facts().find((f) => f.text === cleanText && f.kind === cleanKind) ?? dup;
    }

    const fact = {
      id: randomUUID().slice(0, 12),
      ts,
      kind: cleanKind,
      text: cleanText,
      tags: cleanTags,
      salience: nextSalience,
      source: String(source || '').slice(0, 200),
    };
    this._append(this.factsPath, fact);
    this._facts = null;   // 让下次读取重新折叠，保证拿到的是磁盘真值
    return this.facts().find((f) => f.text === cleanText && f.kind === cleanKind)
      ?? { ...fact, hits: 0, lastHit: 0 };
  }

  /** 命中反馈：只写独立文件，永不重写 facts.jsonl。 */
  touch(id, now = Date.now()) {
    if (typeof id !== 'string' || !id) return;
    const facts = this.facts();
    const target = facts.find((f) => f.id === id);
    if (!target) return;
    const hits = (target.hits || 0) + 1;
    this._append(this.hitsPath, { id, hits, lastHit: now });
    target.hits = hits;
    target.lastHit = now;
    if (this._hits) this._hits.set(id, { hits, lastHit: now });
    // 注意：不碰 factsPath。正文保持 append-only。
  }

  /* ---------------- persona (L3) ---------------- */

  persona() {
    return existsSync(this.personaPath) ? readFileSync(this.personaPath, 'utf8') : '';
  }

  setPersona(text) {
    writeFileSync(this.personaPath, String(text || ''), 'utf8');
  }

  /* ---------------- scenes (L2)：只追加 + 去重 ---------------- */

  scenes() {
    if (this._scenes) return this._scenes;
    const out = [];
    const seen = new Set();
    const push = (rec) => {
      if (!rec || typeof rec.summary !== 'string') return;
      const summary = cleanSceneText(rec.summary);
      if (summary.length < 4) return;      // 剔完噪音什么都不剩 → 整条丢弃
      const key = summary.slice(0, 200);
      if (seen.has(key)) return;      // 折叠重复（fork/compaction 重放会产生同样的场景）
      seen.add(key);
      out.push({
        id: typeof rec.id === 'string' && rec.id ? rec.id : randomUUID().slice(0, 12),
        ts: Number(rec.ts) || Date.now(),
        title: cleanSceneText(rec.title || '').slice(0, 60),
        summary: summary.slice(0, 600),
        tags: Array.isArray(rec.tags) ? rec.tags : [],
      });
    };

    // 旧格式（JSON 数组）先读，保证历史场景不丢
    if (existsSync(this.scenesPath)) {
      try {
        const legacy = JSON.parse(readFileSync(this.scenesPath, 'utf8'));
        if (Array.isArray(legacy)) for (const rec of legacy) push(rec);
      } catch { /* 坏文件跳过 */ }
    }
    for (const rec of this._readLines(this.scenesLogPath)) push(rec);

    out.sort((a, b) => a.ts - b.ts);
    this._scenes = out.slice(-MAX_SCENES);
    return this._scenes;
  }

  addScene({ title, summary, tags = [], ts = Date.now() }) {
    const clean = String(summary || '').trim();
    if (!clean) return null;
    this.reload();
    if (this.scenes().some((s) => s.summary.slice(0, 200) === clean.slice(0, 200))) return null;
    const scene = {
      id: randomUUID().slice(0, 12),
      ts,
      title: String(title || '').slice(0, 60),
      summary: clean.slice(0, 600),
      tags: Array.isArray(tags) ? tags : [],
    };
    this._append(this.scenesLogPath, scene);
    this._scenes = null;
    return scene;
  }

  /* ---------------- state ---------------- */

  state() {
    if (!existsSync(this.statePath)) return {};
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { return {}; }
  }

  patchState(patch) {
    const next = { ...this.state(), ...patch };
    writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /* ---------------- 迁移：把旧的 memory.md 一次性导入 ---------------- */

  importMarkdown(md) {
    const added = [];
    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/^[-*]\s*/, '').trim();
      if (!line || /^#/.test(line) || /^>/.test(line)) continue;
      if (/^例[：:]/.test(line)) continue;
      const m = line.match(/^阶段[：:]\s*(\d)/);
      if (m) { const f = this.addFact({ kind: 'relationship', text: `关系阶段 ${m[1]}`, tags: ['关系'], salience: 5 }); if (f) added.push(f); continue; }
      if (line.length < 4) continue;
      const f = this.addFact({ kind: 'profile', text: line, tags: ['导入'], salience: 2, source: 'memory.md' });
      if (f) added.push(f);
    }
    return added.length;
  }
}
