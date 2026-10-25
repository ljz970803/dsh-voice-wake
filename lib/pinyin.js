/**
 * 唤醒词匹配：规范化 -> 音节归一 -> 宽容匹配。
 *
 * 为什么这样做：识别用的是 ASR，不是 KWS，所以唤醒词可以随时改、不用训练。
 * 代价是「鲸鱼」可能被识别成「京鱼 / 经鱼 / 精鱼 / 晶鱼 / 惊鱼」。
 * 老版本只做「逐字相等 或 同音字相等」的精确序列匹配，`jing` 被识别成
 * `jin`（前后鼻音不分）或 `jing`/`zhing`（平翘舌不分）就漏了。
 *
 * 这一版分三层放宽，但每一层都有防误唤醒的约束：
 *  1. 音节归一：忽略声调；`ing→in`、`eng→en`、`ang→an`；`zh/ch/sh → z/c/s`。
 *  2. 编辑距离：完整短语允许「插入/删除/替换」总计 ≤1 个音节。
 *     但**核心词「鲸鱼」必须完整出现** —— 只说「鲸」不算唤醒。
 *  3. 短说：唤醒词以「鲸鱼」开头时，「鲸鱼」「鲸鱼啊」「那个鲸鱼」
 *     都算命中。旧词「小鲸」开头的配置仍走原有短核心规则。
 *
 * 关键取舍：「金鱼」不是「鲸鱼」的容错范围。归一化会把 `jing` 和 `jin`
 * 压成同一个键，只靠音节分不出来；所以对含「鲸」的默认词额外要求
 * 原始音节是 `jing`（鲸/京/经/精/晶 都可以），`jin`（金/今/近…）不命中。
 * 代价是 ASR 真把「鲸鱼」写成「金鱼」时不会唤醒；要兼容这种识别结果，
 * 把「金鱼」显式加进唤醒词即可（用户自己写的词不做这个限制）。
 *
 * 结束词只走第 1、2 层，不做短说匹配：
 * 否则对话中说一句「鲸鱼……」就会被误判成结束词。
 *
 * 表的取舍：只收录确认同音的字；表里没有的字退化为逐字精确比较。
 * 宁可漏容错（多喊一次），也不制造误唤醒。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TABLE_FILE = join(HERE, '..', 'assets', 'pinyin.json')

/** 宽容匹配允许的最大编辑距离（插入/删除/替换各算 1）。 */
const MAX_DISTANCE = 1

/** 旧默认词「小鲸」的核心音节：「鲸」jing -> jin。 */
const WAKE_CORE = 'jin'

/**
 * 可走「短说」的唤醒词头。只认两种：
 *  - 鲸鱼：新默认词。归一化后是 [jin, yu]，但原始音节必须是 jing+yu，
 *    否则「金鱼」也会命中（见文件头注释）。
 *  - 小鲸：0.3.x 的旧默认词。用户升级后如果没让迁移改词，旧配置仍要能喊。
 */
const HEAD_JINGYU = { kind: 'jingyu', core: ['jin', 'yu'], raw: ['jing', 'yu'] }
const HEAD_XIAOJING = { kind: 'xiaojing', core: ['xiao', 'jin'], raw: ['xiao', 'jing'] }

/**
 * 单字「鲸」整句唤醒时允许带的无意义前后缀（语气词、口头语）。
 * 这些音节会被剥掉；剥完必须正好剩一个（或两个重复的）核心音节。
 * 用音节而不是汉字，是为了让「阿金 / 鲸呀」也能命中。
 */
const FILLERS = new Set([
  'a', // 阿 / 啊
  'ai', // 哎 / 唉
  'ei', // 诶
  'en', // 嗯
  'o', // 哦
  'ou', // 欧 / 喔
  'ya', // 呀
  'ne', // 呢
  'ba', // 吧
  'ma', // 吗 / 嘛
  'la', // 啦
  'wei', // 喂
  'na', // 那
  'nei', // 哪
  'ge', // 个
  'zhe', // 这
  'me', // 么
])

/**
 * 「鲸鱼 / 小鲸」核心后面可以安全吞掉的语气词。
 * 只放没有实义、跟在称呼后面也不会改变句意的音节：
 * 「鲸鱼啊 / 鲸鱼呀 / 鲸鱼呢 / 鲸鱼吧」。
 * 不能放「为 / 那 / 个 / 这 / 喂」这类有实义的音节，否则
 * 「鲸鱼为什么」会被吞成「什么」、「鲸鱼那个」会被吞成「个」。
 */
const PARTICLES = new Set(['a', 'ya', 'ne', 'ba', 'ma', 'la', 'o', 'ou', 'en'])

/**
 * 段首允许的「一个语气词」。wakeAtStart=true 时，唤醒词前面最多只能有
 * 其中一个：那个 / 嗯 / 啊 / 呃。
 */
const START_FILLERS = new Set(['en', 'a', 'e'])
/** 「那个」是两个音节，单独当成一个语气词。 */
const START_FILLER_NA = 'na'
const START_FILLER_GE = 'ge'

/**
 * 少数常用字不在同音字表的音节列表里（例如「呃」），这里补上，
 * 否则「呃鲸鱼」会被当成未知字符、无法按段首语气词放行。
 */
const CHAR_SYLLABLE_OVERRIDES = new Map([['呃', 'e']])

/** 汉字 -> 归一化音节。首次使用时构建，之后复用。 */
let charToSyllable = null
/** 汉字 -> 未做前后鼻音/平翘舌归一的原始音节（只去声调）。 */
let charToRawSyllable = null

/**
 * 音节归一化。识别结果和同音字表都过这一遍，再比较：
 *  - 去掉声调数字（jing1）与声调符号（jīng）；
 *  - 平翘舌归一：zh/ch/sh -> z/c/s；
 *  - 前后鼻音归一：ing -> in、eng -> en、ang -> an。
 *
 * 归一化是「单向压平」的，所以「金(jin)」和「鲸(jing)」、「经(jing)」和
 * 「金(jin)」会落到同一个键上。这正是用户要的宽容度；防误唤醒靠下面的
 * 核心音节约束和整句约束。
 * @param {string} syllable 原始音节（或表外的单个字符）
 * @returns {string} 归一化后的比较键
 */
export function normalizeSyllable(syllable) {
  if (typeof syllable !== 'string' || syllable === '') return ''
  let key = syllable.toLowerCase()
  // 去掉组合声调符号（ā -> a）和结尾的声调数字（jing1 -> jing）。
  key = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[0-9]+$/u, '')
  // 平翘舌：只处理音节开头的声母，避免误伤中间字母。
  key = key.replace(/^zh/u, 'z').replace(/^ch/u, 'c').replace(/^sh/u, 's')
  // 前后鼻音：只处理韵尾。
  key = key.replace(/ing$/u, 'in').replace(/eng$/u, 'en').replace(/ang$/u, 'an')
  return key
}

function ensureTable() {
  if (charToSyllable !== null) return charToSyllable
  const map = new Map()
  const rawMap = new Map()
  try {
    const raw = JSON.parse(readFileSync(TABLE_FILE, 'utf8'))
    const syllables = raw?.syllables ?? {}
    for (const [syllable, chars] of Object.entries(syllables)) {
      if (typeof chars !== 'string') continue
      const key = normalizeSyllable(syllable)
      if (key === '') continue
      // 原始键只去声调；保留 jing/jin 的区别，供「金鱼 vs 鲸鱼」的判别使用。
      const rawKey = String(syllable).toLowerCase().replace(/[0-9]+$/u, '')
      for (const char of chars) {
        if (!map.has(char)) map.set(char, key)
        if (!rawMap.has(char)) rawMap.set(char, rawKey)
      }
    }
  } catch {
    // 表缺失或损坏时不影响主流程：所有字退化为逐字精确比较。
  }
  charToSyllable = map
  charToRawSyllable = rawMap
  return map
}

/**
 * 原文里「规范化后第 compactIndex 个字符」对应原文的偏移。
 *
 * 用途：唤醒匹配是在去掉标点的紧凑文本上做的（`normalize`），但发给模型的正文
 * 要用**原文**（保留标点）。拿这个函数把紧凑下标映射回原文下标，就能切出带标点的后半句。
 *
 * @param {string} text 原始识别文本
 * @param {number} compactIndex 规范化文本里的下标（0 表示开头）
 * @returns {number} 原文下标：返回的是「第 compactIndex 个保留字符之后」的位置；越界返回原文长度
 */
export function originalIndexAt(text, compactIndex) {
  if (typeof text !== 'string' || compactIndex <= 0) return 0
  let seen = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const code = char.codePointAt(0)
    const half = code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : char
    if (half === '\u3000' || half === '\u00a0') continue
    if (!/[\p{L}\p{N}]/u.test(half)) continue
    seen += 1
    if (seen === compactIndex) return index + 1
  }
  return text.length
}

/**
 * 规范化：全角转半角，只保留字母、数字与汉字，并转小写。
 * 目的：让「小鲸，你在吗」「小 鲸 你 在 吗」「小鲸你在吗?」等价。
 * @param {string} text 原始识别文本
 * @returns {string} 规范化后的紧凑字符串
 */
export function normalize(text) {
  if (typeof text !== 'string') return ''
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    // 全角 ASCII 先转半角；转完再统一过一遍过滤，否则「，」「？」会被误留。
    const half = code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : char
    if (half === '\u3000' || half === '\u00a0') continue
    if (/[\p{L}\p{N}]/u.test(half)) out += half.toLowerCase()
  }
  return out
}

/**
 * 把规范化文本压成「音节/字符」序列：认识的字变成归一化音节，其余保持原样。
 * 一个字符对应一个键，所以键的下标可以直接当作紧凑字符串的下标使用。
 * @param {string} text 规范化后的文本
 * @returns {string[]} 每个位置的比较键
 */
export function skeleton(text) {
  const map = ensureTable()
  const keys = []
  for (const char of text) keys.push(CHAR_SYLLABLE_OVERRIDES.get(char) ?? map.get(char) ?? normalizeSyllable(char))
  return keys
}

/**
 * 与 skeleton() 逐位对应，但不做 ing→in / zh→z 的归一化。
 * 只用于区分「鲸(jing)」和「金(jin)」——归一化后它们完全相同，
 * 单靠 skeleton 无法让「金鱼」不误唤醒。
 * @param {string} text 规范化后的文本
 * @returns {string[]} 每个位置的原始音节（未知字符保持原样）
 */
export function rawSkeleton(text) {
  ensureTable()
  const keys = []
  for (const char of text) keys.push(CHAR_SYLLABLE_OVERRIDES.get(char) ?? charToRawSyllable.get(char) ?? normalizeSyllable(char))
  return keys
}

/**
 * Levenshtein 编辑距离。序列都很短（一句最多几十个音节），直接 DP。
 * @param {string[]} a 序列 A
 * @param {string[]} b 序列 B
 * @returns {number} 编辑距离
 */
function editDistance(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  let previous = new Array(m + 1)
  let current = new Array(m + 1)
  for (let column = 0; column <= m; column += 1) previous[column] = column
  for (let row = 1; row <= n; row += 1) {
    current[0] = row
    for (let column = 1; column <= m; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1
      current[column] = Math.min(
        previous[column] + 1, // 删除 a 的一个音节
        current[column - 1] + 1, // 插入 b 的一个音节
        previous[column - 1] + cost, // 替换
      )
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[m]
}

/**
 * 相似度分数，用于日志。1.00 = 完全相同；越小越不像。
 * @param {number} distance 编辑距离
 * @param {number} targetLength 目标音节数
 * @param {number} spanLength 文本片段音节数
 * @returns {number} 0..1
 */
function scoreOf(distance, targetLength, spanLength) {
  const denominator = Math.max(1, targetLength, spanLength)
  return Math.max(0, Math.min(1, 1 - distance / denominator))
}

/**
 * 在 span 里找唤醒词头（鲸鱼 / 小鲸）。
 * 「鲸鱼」头要求原始音节是 jing+yu：归一化后「金鱼」也是 jin+yu，
 * 只能回原始音节才能把它们分开（见文件头注释）。
 * @param {string[]} keys 归一化音节
 * @param {string[]} rawKeys 原始音节
 * @param {number} start 起点
 * @param {number} end 终点（不含）
 * @param {{kind:string,core:string[],raw:string[]}} head 词头
 * @returns {number} 词头起点；找不到返回 -1
 */
function findHead(keys, rawKeys, start, end, head) {
  for (let index = start; index + 1 < end; index += 1) {
    if (keys[index] !== head.core[0] || keys[index + 1] !== head.core[1]) continue
    if (head.kind === 'jingyu') {
      if (rawKeys[index] !== 'jing' || rawKeys[index + 1] !== 'yu') continue
    }
    return index
  }
  return -1
}

/**
 * 段首判定：唤醒词前面最多只能有「那个 / 嗯 / 啊 / 呃」中的一个。
 * @param {string[]} keys 文本归一化音节
 * @param {number} wakeStart 词头起点
 * @returns {boolean} 是否满足 wakeAtStart
 */
function isWakeAtStart(keys, wakeStart) {
  if (wakeStart === 0) return true
  if (keys[0] === START_FILLER_NA && keys[1] === START_FILLER_GE) return wakeStart === 2
  return START_FILLERS.has(keys[0]) && wakeStart === 1
}

/**
 * 在文本里找和 target 编辑距离 ≤ maxDistance 的所有窗口（长度 target±maxDistance）。
 * 含「鲸」的词还要求窗口里真的出现原始音节 jing+yu 的「鲸鱼」头，
 * 避免「金鱼」被归一化成同一个序列。
 * @param {string[]} keys 文本归一化音节序列
 * @param {string[]} rawKeys 文本原始音节序列
 * @param {string[]} target 目标音节序列
 * @param {{kind:string,core:string[],raw:string[]}|null} head 目标词头
 * @param {number} maxDistance 允许的最大编辑距离
 * @returns {Array<{start:number,end:number,span:string[],distance:number,headIndex:number}>} 候选
 */
function collectFuzzy(keys, rawKeys, target, head, maxDistance) {
  const out = []
  const length = target.length
  for (let start = 0; start < keys.length; start += 1) {
    const maxLength = Math.min(length + maxDistance, keys.length - start)
    for (let size = Math.max(1, length - maxDistance); size <= maxLength; size += 1) {
      const span = keys.slice(start, start + size)
      const distance = editDistance(span, target)
      if (distance > maxDistance) continue
      const headIndex = head === null ? -1 : findHead(keys, rawKeys, start, start + size, head)
      if (head !== null && headIndex < 0) continue
      out.push({ start, end: start + size, span, distance, headIndex })
    }
  }
  return out
}

/**
 * 找「鲸鱼 / 小鲸」这个两音节词头：必须精确是词头音节（同音字/前后鼻音
 * 已在归一化里吸收），后面最多再带一个语气词。
 * 精确而非编辑距离 1，是因为「北京 / 南京 / 已经 / 安静」这类词
 * 离「小鲸」正好一个替换的距离，宽松成 ≤1 会大量误唤醒。
 *
 * 注意：这里**不再**把「鲸鱼 / 鲸落 / 鲸吞 / 鲸鲨 / 鲸群」当负向词。
 * 「鲸鱼」现在是唤醒词本身，旧版的防误触已被移除。
 * @param {string[]} keys 文本归一化音节序列
 * @param {string[]} rawKeys 文本原始音节序列
 * @param {{kind:string,core:string[],raw:string[]}} head 词头
 * @returns {Array<{start:number,end:number,span:string[],distance:number,headIndex:number}>} 候选
 */
function collectCore(keys, rawKeys, head) {
  const out = []
  for (let start = 0; start + 1 < keys.length; start += 1) {
    if (findHead(keys, rawKeys, start, start + 2, head) !== start) continue
    let end = start + 2
    // 只吞语气词，最多连续几个；有实义的音节留给 rest。
    while (end < keys.length && PARTICLES.has(keys[end])) end += 1
    out.push({ start, end, span: keys.slice(start, end), distance: 0, headIndex: start })
  }
  return out
}

/**
 * 整句只有「鲸 / 鲸鲸 / 阿鲸（以及语气词）」时，允许省掉「小」。
 * 只对旧词「小鲸」生效；新词「鲸鱼」的短说由 collectCore() 处理。
 *
 * 只认整句：如果放开成「句中任意一个 jin 都算」，那「今天天气」
 * 「京剧」「经济」都会唤醒 —— 归一化后它们和「鲸」同音节。
 * @param {string[]} keys 文本归一化音节序列
 * @param {{kind:string,core:string[],raw:string[]}} head 词头
 * @returns {Array<{start:number,end:number,span:string[],distance:number,headIndex:number}>} 候选
 */
function collectShort(keys, head) {
  if (head.kind !== 'xiaojing') return []
  let start = 0
  let end = keys.length
  while (start < end && FILLERS.has(keys[start])) start += 1
  while (end > start && FILLERS.has(keys[end - 1])) end -= 1
  const middle = keys.slice(start, end)
  const hit =
    (middle.length === 1 && middle[0] === WAKE_CORE) ||
    (middle.length === 2 && middle[0] === WAKE_CORE && middle[1] === WAKE_CORE)
  if (!hit) return []
  // 尾部的「啊/呀」也算这次唤醒的一部分，不要让它变成 rest 再发出去。
  let consumedEnd = end
  while (consumedEnd < keys.length && FILLERS.has(keys[consumedEnd])) consumedEnd += 1
  return [{ start, end: consumedEnd, span: middle, distance: 0, headIndex: -1 }]
}

/**
 * 计算「最接近的一次没命中」，只用于 wake.miss 日志。
 * 允许任意长度窗口，这样能看出「差几个音节」。
 * 含「鲸」的词同样要过原始音节守卫；否则「金鱼」会显示 distance=0，
 * 让人误以为规则坏了。
 * @param {string[]} keys 文本归一化音节序列
 * @param {string[]} rawKeys 文本原始音节序列
 * @param {string[]} target 目标音节序列
 * @param {{kind:string,core:string[],raw:string[]}|null} head 目标词头
 * @returns {{start:number,end:number,span:string[],distance:number,headIndex:number}|null} 最佳窗口
 */
function nearestWindow(keys, rawKeys, target, head) {
  if (keys.length === 0 || target.length === 0) return null
  let best = null
  for (let start = 0; start < keys.length; start += 1) {
    const maxLength = Math.min(keys.length - start, target.length + 1)
    for (let size = 1; size <= maxLength; size += 1) {
      const span = keys.slice(start, start + size)
      const distance = editDistance(span, target)
      const headIndex = head === null ? -1 : findHead(keys, rawKeys, start, start + size, head)
      if (head !== null && headIndex < 0) continue
      if (
        best === null ||
        distance < best.distance ||
        (distance === best.distance && span.length > best.span.length)
      ) {
        best = { start, end: start + size, span, distance, headIndex }
      }
    }
  }
  return best
}

/**
 * 给一段文本和一组短语打分。
 * @param {string} text 原始识别文本
 * @param {string[]} phrases 短语列表
 * @param {{ wake?: boolean, requireTail?: boolean, maxDistance?: number, atStart?: boolean }} [options]
 *   wake=true 才启用短说规则；
 *   requireTail=true 时，编辑距离 1 的命中必须还包含目标的最后一个音节
 *   （结束词用：避免「鲸鱼结果」被当成「鲸鱼结束」）；
 *   maxDistance=0 表示严格模式（不接受插入/删除/替换），默认 1；
 *   atStart=true 时唤醒词必须出现在段首（最多放行 1 个语气词）。
 * @returns {{ compact:string, keys:string[], candidates:object[], best:object|null }}
 */
function evaluate(text, phrases, options) {
  const wake = options?.wake === true
  const requireTail = options?.requireTail === true
  const maxDistance = options?.maxDistance === 0 ? 0 : MAX_DISTANCE
  const strict = maxDistance === 0
  const atStart = options?.atStart === true
  const compact = normalize(text)
  const empty = { compact, keys: [], candidates: [], best: null }
  if (compact === '' || !Array.isArray(phrases) || phrases.length === 0) return empty
  const keys = skeleton(compact)
  const rawKeys = rawSkeleton(compact)
  const candidates = []
  let best = null

  for (const phrase of phrases) {
    if (typeof phrase !== 'string') continue
    const phraseCompact = normalize(phrase)
    const target = skeleton(phraseCompact)
    if (target.length === 0) continue
    /**
     * 只对「鲸鱼…」「小鲸…」这类以词头开头的短语启用短说/词头守卫。
     * 用户显式写「金鱼」时不套「鲸鱼」的守卫（那是他自己要的词）。
     */
    let head = null
    if (phraseCompact.startsWith('鲸鱼') && target.length >= 2) head = HEAD_JINGYU
    else if (phraseCompact.startsWith('小鲸') && target.length >= 2) head = HEAD_XIAOJING
    /** 短语里带「鲸」时，匹配片段里必须还留着这个核心音节。 */
    const requireCore = target.includes(WAKE_CORE)

    for (const window of collectFuzzy(keys, rawKeys, target, head, maxDistance)) {
      if (requireCore && !window.span.includes(WAKE_CORE)) continue
      // 结束词的防误判：允许插入/删除，但不允许把「结束(su)」替换成「结果(guo)」。
      if (requireTail && window.distance > 0 && !window.span.includes(target[target.length - 1])) continue
      const wakeStart = window.headIndex >= 0 ? window.headIndex : window.start
      if (atStart && !isWakeAtStart(keys, wakeStart)) continue
      candidates.push({
        phrase,
        alias: 'full',
        priority: 0,
        start: window.start,
        end: window.end,
        wakeStart,
        distance: window.distance,
        // matched 只显示词头（鲸鱼/小鲸），日志里一眼能看出「匹配到哪个词」；
        // 完整命中范围仍由 start/end 与 rest 表示。
        matched:
          window.headIndex >= 0
            ? compact.slice(window.headIndex, window.headIndex + 2)
            : compact.slice(window.start, window.end),
        score: scoreOf(window.distance, target.length, window.span.length),
      })
    }

    if (wake && head !== null) {
      for (const window of collectCore(keys, rawKeys, head)) {
        // 严格模式只允许「整段只有词头（可带语气词）」的短说；
        // 这样「鲸鱼」能唤醒，「鲸鱼啊你在吗」不会靠短核心绕过“不许插字”。
        if (strict && window.end !== keys.length) continue
        if (atStart && !isWakeAtStart(keys, window.start)) continue
        candidates.push({
          phrase,
          alias: 'core',
          priority: 1,
          start: window.start,
          end: window.end,
          wakeStart: window.start,
          distance: window.distance,
          matched: compact.slice(window.start, window.end),
          score: scoreOf(window.distance, 2, window.span.length),
        })
      }
      // 严格模式不再启用旧词「小鲸」的单字整句短形态，避免把「今天」等
      // 同音节词当成唤醒；旧配置仍可通过完整短语命中。
      if (!strict) {
        for (const window of collectShort(keys, head)) {
          if (atStart && !isWakeAtStart(keys, window.start)) continue
          candidates.push({
            phrase,
            alias: 'short',
            priority: 2,
            start: window.start,
            end: window.end,
            wakeStart: window.start,
            distance: window.distance,
            matched: compact.slice(window.start, window.end),
            score: scoreOf(window.distance, 1, window.span.length),
          })
        }
      }
    }

    // wake.miss 的 best：完整短语 + 两字词头（不算单字短形态，避免
    // 「今天」因为含一个 jin 就显示 distance=0 的误导性结果）。
    if (wake) {
      for (const template of [target, head === null ? null : head.core]) {
        if (template === null) continue
        const window = nearestWindow(keys, rawKeys, template, head)
        if (window === null) continue
        if (
          best === null ||
          window.distance < best.distance ||
          (window.distance === best.distance && window.span.length > best.matched.length)
        ) {
          best = {
            phrase,
            matched: compact.slice(window.start, window.end),
            distance: window.distance,
          }
        }
      }
    }
  }

  // 排序：先最早出现。同一起点先看是哪种形态（完整短语 > 两字词头 > 单字），
  // 再比编辑距离，最后才比长度。距离优先于长度很关键：否则
  // 「鲸鱼你在吗今天天气」会在完整短语后多吞一个「今」（插入距离 1），
  // 把正文截成「天天气」。
  candidates.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    if (left.priority !== right.priority) return left.priority - right.priority
    if (left.distance !== right.distance) return left.distance - right.distance
    return right.end - left.end
  })
  return { compact, keys, candidates, best }
}

/**
 * 在文本里找唤醒词。返回最早、最完整的一次命中。
 * @param {string} text 原始识别文本
 * @param {string[]} phrases 唤醒词列表（可含同义说法）
 * @param {{ mode?: 'strict'|'inline', atStart?: boolean }} [options]
 *   mode=strict 时完整短语只接受距离 0（同音/平翘舌容错仍然生效），
 *   短说只允许整段就是词头；mode=inline 沿用 1 音节编辑距离。
 *   atStart=true 时段首最多放行 1 个语气词（那个/嗯/啊/呃）。
 * @returns {{ phrase:string, matched:string, rest:string, text:string,
 *   start:number, end:number, wakeStart:number, distance:number, score:number, alias:string } | null}
 *   `matched` 是命中的词头（默认「鲸鱼」）；`rest` 是唤醒词之后剩下的内容
 *   （用户一口气说的话），没有则为空串。
 */
export function findWakePhrase(text, phrases, options) {
  const mode = options?.mode === 'strict' ? 'strict' : 'inline'
  const { compact, candidates } = evaluate(text, phrases, {
    wake: true,
    maxDistance: mode === 'strict' ? 0 : MAX_DISTANCE,
    atStart: options?.atStart === true,
  })
  const chosen = candidates[0]
  if (chosen === undefined) return null
  return {
    phrase: chosen.phrase,
    matched: chosen.matched,
    rest: compact.slice(chosen.end),
    text: compact,
    start: chosen.start,
    end: chosen.end,
    wakeStart: chosen.wakeStart,
    distance: chosen.distance,
    score: chosen.score,
    alias: chosen.alias,
  }
}

/**
 * 严格唤醒判定：识别文本去掉标点后，必须**整段只有唤醒词**。
 *
 * 这是「叫醒 → 请讲」流程的入口判断：
 *  - 命中且后面没有内容 → `wakeOnly: true`；
 *  - 命中但后面还有字（哪怕只有一个语气词）→ `wakeOnly: false`，不算唤醒；
 *  - 完全没命中 → `hit: null`。
 *
 * @param {string} text 识别文本（可含标点）
 * @param {string[]} phrases 唤醒词列表
 * @param {boolean} [atStart] 是否要求唤醒词在段首（默认 true）
 * @returns {{ hit: object|null, rest: string, wakeOnly: boolean }}
 */
export function matchWakeOnly(text, phrases, atStart = true) {
  const hit = findWakePhrase(text, phrases, { mode: 'inline', atStart })
  if (hit === null) return { hit: null, rest: '', wakeOnly: false }
  const rest = text
    .slice(originalIndexAt(text, hit.end))
    .replace(/^[\s，。、！？；：,.!?;:]+/u, '')
    .trim()
  return { hit, rest, wakeOnly: rest === '' }
}

/**
 * 判断某个唤醒词起点是否满足「段首」规则。
 * @param {string} text 原始识别文本
 * @param {number} wakeStart 词头在紧凑文本里的起点
 * @returns {boolean} 是否在段首（允许最多 1 个语气词）
 */
export function wakeAtStartOk(text, wakeStart) {
  return isWakeAtStart(skeleton(normalize(text)), wakeStart)
}

/**
 * 没命中时给出可写进日志的拒绝原因。
 * 优先用宽松匹配探一下：如果宽松能命中但段首不对，就是 not-at-start；
 * 其余情况都归为 distance-too-far（包括严格模式不接受插入、金鱼同音被守卫拦下）。
 * @param {string} text 原始识别文本
 * @param {string[]} phrases 唤醒词列表
 * @param {{ mode?: 'strict'|'inline', atStart?: boolean }} [options]
 * @returns {'not-at-start'|'distance-too-far'} 拒绝原因
 */
export function wakeRejectReason(text, phrases, options) {
  const loose = findWakePhrase(text, phrases, { mode: 'inline', atStart: false })
  if (loose === null) return 'distance-too-far'
  if (options?.atStart === true && !wakeAtStartOk(text, loose.wakeStart)) return 'not-at-start'
  return 'distance-too-far'
}

/**
 * 在文本里找结束词。只做音节归一 + 编辑距离 ≤1，不做短说，
 * 避免对话中说「鲸鱼……」被当成结束。
 * @param {string} text 原始识别文本
 * @param {string[]} phrases 结束词列表
 * @returns {object|null} 与 findWakePhrase 同形
 */
export function findEndPhrase(text, phrases) {
  const { compact, candidates } = evaluate(text, phrases, { wake: false, requireTail: true })
  const chosen = candidates[0]
  if (chosen === undefined) return null
  return {
    phrase: chosen.phrase,
    matched: chosen.matched,
    rest: compact.slice(chosen.end),
    text: compact,
    start: chosen.start,
    end: chosen.end,
    distance: chosen.distance,
    score: chosen.score,
    alias: chosen.alias,
  }
}

/**
 * 没命中时最接近的候选，用于 `wake.miss` 日志。
 * @param {string} text 原始识别文本
 * @param {string[]} phrases 唤醒词列表
 * @returns {{ phrase:string, matched:string, distance:number } | null} 最佳候选
 */
export function bestWakeMatch(text, phrases) {
  const { best } = evaluate(text, phrases, { wake: true })
  return best
}

/**
 * 把设置页里「分隔的多个说法」拆成数组。
 *
 * 分隔符只认英文逗号 `,`、分号（中英文）、竖线和换行；中文逗号「，」保留在
 * 词组内部 —— 默认唤醒词「鲸鱼，你在吗」本身就带一个中文逗号，
 * 如果把它当分隔符，默认值会被拆成两个短词（「鲸鱼」和「你在吗」），
 * 于是任何一句含「鲸鱼」的话都会误唤醒。
 * @param {string} value 用户输入
 * @returns {string[]} 唤醒词列表
 */
export function splitPhrases(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/[,;；|\n\r]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 同音字表的规模，仅用于诊断。 */
export function tableSize() {
  return ensureTable().size
}
