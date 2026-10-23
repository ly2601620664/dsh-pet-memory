# dsh-pet-memory

**陪伴型长期记忆插件：分层记忆（对话 → 事实 → 场景 → 人格）、规则抽取、时间衰减检索。**
全本地文件、不调额外模型、不产生额外费用；append-only 存储，多进程写入不丢数据。

```bash
dsh plugin --profile <name> add github:ly2601620664/dsh-pet-memory
```

`Compatible with: dsh 0.2.x`（`engines.dsh: >=0.2.1-rc.2 <0.3.0-0`）

## 它做什么

| 层 | 内容 | 存储 |
|---|---|---|
| L3 人格/关系档案 | "我叫他笨蛋"、"关系阶段 3" | `persona.md` |
| L2 场景 | 一段对话的摘要 | `scenes.jsonl`（只追加） |
| L1 事实 | "他喜欢喝冰美式"、"约定：周末去爬山" | `facts.jsonl`（只追加） |
| 命中统计 | 每条事实被检索到几次 | `hits.jsonl`（只追加） |

三个注入点：

1. **`systemPrompt.section`** — 每轮把「人格 + 高价值记忆 + 相关场景」放进系统提示词
2. **工具** — `memory_search` / `memory_add` / `memory_profile`
3. **`session/event`** — 回合结束时用规则抽取新事实

## 数据目录

默认 `$DSH_HOME/dsh-pet-memory`（通常 `~/.dsh/dsh-pet-memory`），可用 `config.dir` 或
`DSH_PET_MEMORY_DIR` 覆盖。

## 存储设计（为什么全是 append-only）

`facts.jsonl`、`hits.jsonl`、`scenes.jsonl` **只追加，永不整文件重写**。

原因：桌面端和 web 端是两个 DSH 进程，共用同一个数据目录。任何"读全量 → 改内存 →
整文件替换"的写入，都会用自己那份旧快照抹掉另一个进程刚追加的行。早期版本用
`tmp + rename` 做命中统计，实测会让另一个进程写入的 40 条记忆**全部消失**。

现在的做法：
- 每条事实/命中/场景都追加一行
- 读取时**折叠**：同 `kind+text` 合并为一条，`salience` 取最大、`ts` 取最早、`hits` 累加
- 命中统计单独文件，`touch()` 完全不碰 `facts.jsonl` 正文

## 修复过的严重问题

| 问题 | 后果 | 修法 |
|---|---|---|
| `touch()` 用 tmp+rename 全量重写 | 多进程并发时丢数据（实测 40 条全灭） | 拆出 `hits.jsonl`，append-only |
| section 未设 `interpolate: false` | 记忆里出现 `{{` 会让整轮 prompt 渲染抛错 | 设 `interpolate: false` + 渲染前 `neutralize()` |
| `textOf` 用空格拼接 block | 行首锚定的清洗规则全部失效（实测 83% 场景被污染） | 改用 `\n` 拼接 |
| `textOf` 不区分 block 类型 | 助手**内心推理**被当成"他说的话"写进记忆 | 只取 `type === 'text'` |
| `hits.includes(f.text)` 字符串子串匹配 | `limit=1` 误伤多条 | 改用对象数组按 `id` 匹配 |
| `addScene` 无去重 | fork/compaction 重放导致重复场景 | 按 summary 去重 |
| `catch {}` 静默 | 落盘失败零日志，"以为在记其实没记" | 统一 `warn` 日志 |
| 无注入防护 | 粘贴的第三方文本可把指令写进长期记忆 | `isPromptInjection()` 拦截 |

## 开发

```bash
node test/selftest.mjs        # 抽取/存储/检索基础行为
node test/plugin.test.mjs     # 用假 ctx 跑一遍插件生命周期
node test/regression.test.mjs # 上面每个已修缺陷的回归用例
```

## 配置

```yaml
dir: null            # 数据目录，默认 $DSH_HOME/dsh-pet-memory
maxItems: 6          # 系统提示词里放几条事实
includeScenes: true  # 是否把相关场景也放进提示词
verbose: false       # 打印每轮抽取条数
migrateFrom: null    # 一次性导入旧 memory.md 的路径
```

## License

MIT
