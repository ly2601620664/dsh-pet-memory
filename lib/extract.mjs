// 规则抽取 v3：不调模型、不花钱。
//
// v1 的问题：直接对整段 user 消息跑正则，而 DSH 的 user 消息里混着运行时上下文、
// system-reminder、IM 源信息、模型切换提示、粘贴的日志/转写稿，于是抽出一堆
// 「约定：下次重启又 disconnected：给 id: openviking-memor」「他最近谁」」这种残句。
//
// v2 修了清洗顺序，但 LINE_NOISE 用 ^ 行首锚定、且上层用空格拼接 block，
// 导致运行时上下文照样漏进来（实测 156 条场景里 83% 被污染），同时误杀
// 「You are the best helper」这类正常句子。
//
// v3 的变化：
//  - LINE_NOISE 不再是行首锚定，改成"片段级"匹配，行内残留也能剔
//  - 只对已知注入片段做删除，不吞掉整行正常正文
//  - 新增 isPromptInjection：指令性/祈使性内容不入库（防持久化注入）
//  - summarizeScene 返回 null 表示"这段对话没有值得记的场景"

/* ---------------- 清洗 ---------------- */

// 需要整块删除的注入标签：闭合的删整段，未闭合的删到结尾
const TAGS_SINGLE_LINE = ['dsh_im_source', 'dsh_im_reply_to'];
const TAGS_TO_END = ['system-reminder', 'openviking-context', 'user-profile', 'dsh_global_context'];

// 整行只在"整行就是这个东西"时才删（避免误杀 "You are the best helper I know"）
// 这里只保留**确实整行都是运行时上下文**的前缀；Treating/Defaulting 这类
// 可能出现在正常句首的词不列入，交给下面的行内片段规则处理。
const LINE_NOISE_EXACT = /^(?:Current runtime context|This snapshot supersedes|Time sampled while|Approval policy|Browser time zone|The runtime context|A user may also|If the user names|Commands may run|For debugging|Do not bypass|Never bypass|Note that)\b/i;

// 行内片段删除：这些短语出现在句子中间时连同其所在的运行时上下文片段一起剔掉
const INLINE_NOISE = [
  /Current runtime context\.?[^\n]*?(?=$|[。！？!?]|\n)/gi,
  /This snapshot supersedes[^\n]*/gi,
  /Time sampled while preparing[^\n]*/gi,
  /Browser time zone:[^\n]*/gi,
  /Approval policy:[^\n]*/gi,
];

export function sanitize(text) {
  let s = String(text || '');
  for (const tag of [...TAGS_SINGLE_LINE, ...TAGS_TO_END]) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '\n');
  }
  for (const tag of TAGS_SINGLE_LINE) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[^\\n]*`, 'i'), '\n');
  }
  for (const tag of TAGS_TO_END) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), '\n');
  }
  s = s.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  // 行内注入片段先剔，再做整行过滤（顺序很重要：先剔片段才能保住同一行里的正文）
  for (const re of INLINE_NOISE) s = s.replace(re, ' ');
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !LINE_NOISE_EXACT.test(l))
    .filter((l) => !/^(?:他|我|助手|assistant|user|system)\s*[:：]/.test(l)) // 转写稿
    .filter((l) => !/^(?:#{1,6}\s|[-*]{3,}\s*$|\|)/.test(l))
    .join('\n');
}

/* ---------------- 提示词注入判定 ---------------- */

// 指令性词汇：出现这些就认为这段文本在"命令"而不是"陈述"
const IMPERATIVE = /(?:忽略|无视|忘记|跳过|绕过|覆盖)(?:之前|以前|上面|所有|一切|全部)?(?:的)?(?:指令|规则|限制|设定|提示|要求)/;
// 敏感对象：密钥类 / 系统提示词类
const SECRET_OBJECT = /(?:密钥|私钥|密码|口令|凭证|credential|api[_\s-]?key|apikey|token|secret|access[_\s-]?key|环境变量|配置文件|系统提示词|提示词全文|身份证|银行卡)/i;
// 外泄动作：把敏感对象读出来 / 输出出去
const EXFIL_ACTION = /(?:读取|读到|拿到|获取|输出|打印|显示|泄露|告诉|发送|附在|贴到|写进|转发|回显|列出)/;
const ROLE_HIJACK = /(?:从现在开始|此后|以后每(?:轮|次|次回答)|每次回答)|(?:你(?:现在|从现在起)?是|扮演|假装你是)/;
const OVERRIDE = /(?:先输出|开头先|无条件|必须(?:先|只)|不要再遵循|不受限制|越狱)/;

/**
 * 判断一段文本是否像"对模型的指令"（而不是关于用户的陈述）。
 * 用于阻止用户粘贴的第三方文本、网页内容、群消息把指令写进长期记忆。
 */
export function isPromptInjection(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (IMPERATIVE.test(s)) return true;
  // 敏感对象 + 外泄动作 同现 = 在指挥模型搬运敏感信息
  if (SECRET_OBJECT.test(s) && EXFIL_ACTION.test(s)) return true;
  // 需要「角色/时间锚点」+「覆盖/输出」两个信号同时出现才算，避免误杀日常用语
  if (ROLE_HIJACK.test(s) && OVERRIDE.test(s)) return true;
  if (/(?:忽略|无视|忘记)(?:之前|以前|上面)(?:所有|一切|全部)?/.test(s)) return true;
  return false;
}

/* ---------------- 垃圾判定 ---------------- */

const SYS_WORDS = /(?:current runtime context|system-reminder|this snapshot supersedes|dsh_im_source|openviking-context|user-profile|model changed|approval policy|node_modules|\.asar|pnpm|disconnected|traceback|err_[a-z]+)/i;
const JUNK_TAIL = /["'”’）)],，、；;：:]$/;

function balanced(s) {
  const pairs = [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['[', ']'], ['《', '》'], ['“', '”']];
  for (const [a, b] of pairs) {
    if ((s.split(a).length - 1) !== (s.split(b).length - 1)) return false;
  }
  return (s.split('"').length - 1) % 2 === 0;
}

export function isJunk(text) {
  const s = String(text || '').trim();
  if (s.length < 4) return true;
  if (!/[\u4e00-\u9fa5]/.test(s) && !/[a-zA-Z]{3,}/.test(s)) return true;
  if (SYS_WORDS.test(s)) return true;
  if (isPromptInjection(s)) return true;  // 指令性内容一律视为垃圾
  if (!balanced(s)) return true;          // 引号/括号没配对 = 被切断了
  if (JUNK_TAIL.test(s)) return true;     // 以引号/右括号/逗号收尾 = 残句
  if (/\s\/\s/.test(s)) return true;      // 拼接列表
  if (/[\\`]/.test(s)) return true;       // 路径/代码
  if ((s.match(/[，,]/g) || []).length > 2) return true;
  if (/(?:等等|这个|那个|什么|怎么|为什么|是不是)$/.test(s)) return true;
  return false;
}

/* ---------------- 近似去重 ---------------- */

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n); // Jaccard
}

export function isNearDuplicate(text, existingTexts = [], threshold = 0.75) {
  for (const t of existingTexts) if (similarity(text, t) >= threshold) return true;
  return false;
}

/* ---------------- 标签 ---------------- */

const TAG_HINTS = [
  ['吃', ['吃', '饭', '零食', '外卖', '奶茶', '辣', '甜']],
  ['游戏', ['游戏', '英雄联盟', 'lol', 'steam', '排位']],
  ['作息', ['睡', '熬夜', '凌晨', '早睡', '起床']],
  ['工作', ['上班', '加班', '工作', '项目', 'deadline']],
  ['关系', ['喜欢', '爱', '女朋友', '男朋友', '亲亲', '抱']],
  ['钱', ['钱', '贵', '便宜', '工资', 'token']],
];

export function tagsFor(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  for (const [tag, words] of TAG_HINTS) if (words.some((w) => t.includes(w))) out.push(tag);
  return out;
}

/* ---------------- 规则 ---------------- */

const NAME_SUFFIX = /(?:就行|就好|可以了|吧|啊|呀|啦|哦|呗|了|嘛|呢|哈)+$/;
const NAME_STOP = /^(?:什么|啥|谁|哪|干嘛|名字)/;

function cleanName(s) {
  return String(s || '')
    .replace(/^[「『“"']+|[」』”"']+$/g, '')
    .replace(NAME_SUFFIX, '')
    .trim();
}

const CLAUSE_SPLIT = /[。！？!?；;\n]+/;

// 同类重要度下，长期属性 > 临时事件；每轮名额有限时按这个值排序
const KIND_VALUE = { profile: 3, relationship: 3, preference: 2, promise: 2, lesson: 1, event: 0 };
const valueOf = (f) => f.salience * 10 + (KIND_VALUE[f.kind] ?? 0);

const RULES = [
  { kind: 'preference', salience: 4, re: /我(?:很|超|最|特别|挺|蛮)?(?:喜欢|爱)([^。！？!?\n，,；;]{1,20})/g,
    tpl: (m) => `他喜欢${m[1]}` },
  { kind: 'preference', salience: 4, re: /我(?:不喜欢|讨厌|受不了)([^。！？!?\n，,；;]{1,20})/g,
    tpl: (m) => `他讨厌${m[1]}` },
  { kind: 'preference', salience: 4, re: /我(不吃|不能吃|吃不了|不喝|喝不了)([^。！？!?\n，,；;]{1,12})/g,
    tpl: (m) => `他${m[1]}${m[2]}` },
  { kind: 'profile', salience: 5, re: /(?<![你别再])喊?叫我([^\s，。！？!?、,；;：:]{1,10})/g,
    tpl: (m) => `他让我叫他「${cleanName(m[1])}」`,
    guard: (m, clause) => {
      const n = cleanName(m[1]);
      return n.length >= 1 && !NAME_STOP.test(n) && !/[？?]/.test(clause);
    } },
  { kind: 'profile', salience: 4, re: /我(?:最近)?(?:是|在做|在忙|在搞)([^。！？!?\n，,；;]{2,30})/g,
    tpl: (m) => `他最近${m[1]}` },
  { kind: 'promise', salience: 5, re: /(?:我答应|答应你|说好|明天|下次|周末)([^。！？!?\n，,；;]{1,40})/g,
    tpl: (m) => `约定：${m[0]}` },
  { kind: 'event', salience: 4, re: /(?:今天|刚刚|昨天)([^。！？!?\n]{2,40})/g,
    tpl: (m) => `事件：${m[0]}` },
  { kind: 'profile', salience: 5, re: /我(?:今年)?(\d{1,2})岁/g, tpl: (m) => `他 ${m[1]} 岁` },
  { kind: 'profile', salience: 3, re: /(?:我在|我住)([^。！？!?\n]{2,20})/g, tpl: (m) => `他在${m[1]}` },
  { kind: 'relationship', salience: 5, re: /(?:喜欢你|爱你|在一起|男女朋友)/g,
    tpl: (m) => `关系进展：他说「${m[0]}」` },
  { kind: 'event', salience: 4, re: /我(?:有点|好|很|特别)?(?:生气|难过|不开心|委屈)/g,
    tpl: (m) => `情绪：他说「${m[0]}」` },
];

/* ---------------- 主流程 ---------------- */

export function extractFacts(turnText, { max = 3 } = {}) {
  const clean = sanitize(turnText);
  if (!clean.trim()) return [];
  // 整段先过一遍注入判定：如果这一轮明显是在给指令，整轮不抽
  if (isPromptInjection(clean)) return [];
  const all = [];
  for (const raw of clean.split(CLAUSE_SPLIT)) {
    const clause = raw.trim();
    if (clause.length < 3) continue;
    if (isPromptInjection(clause)) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(clause)) !== null) {
        if (rule.guard && !rule.guard(m, clause)) continue;
        const factText = rule.tpl(m).replace(/\s+/g, ' ').trim();
        if (factText.length > 120) continue;
        if (isJunk(factText)) continue;
        if (all.some((f) => f.text === factText || similarity(f.text, factText) >= 0.75)) continue;
        all.push({ kind: rule.kind, salience: rule.salience, text: factText, tags: tagsFor(clause) });
      }
    }
  }
  // 每轮最多记 max 条，优先留下长期属性（profile/关系/喜好），临时事件排最后
  return all.sort((a, b) => valueOf(b) - valueOf(a)).slice(0, max);
}

/**
 * 把一段对话压成场景摘要。
 * @returns {{title:string, summary:string, tags:string[]}|null} 没有可记内容时返回 null
 */
export function summarizeScene(messages) {
  const lines = [];
  for (const m of messages) {
    const t = sanitize(m.content).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (isJunk(t) && t.length < 12) continue;   // 纯噪音不进场景
    lines.push(`${m.role === 'user' ? '他' : '我'}：${t.slice(0, 80)}`);
  }
  if (!lines.length) return null;                // 全是运行时上下文 → 不写场景
  const text = lines.join(' / ').slice(0, 400);
  if (!text.trim()) return null;
  return { title: (lines[0] || '一段对话').replace(/^他：/, '').slice(0, 40), summary: text, tags: tagsFor(text) };
}
