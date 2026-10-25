/**
 * 语音高风险提醒：纯函数，方便单测，不依赖 DSH / DOM。
 *
 * 设计原则：
 *  - 只在“明显不可逆 + 明显外部副作用”的词上触发，宁可漏报也不扩大误报；
 *  - 只追加提醒，不拦截发送；
 *  - 用户自定义词用 includes 匹配，不拼正则，避免 `.*` / `|` 把匹配搞坏。
 */

/** 默认敏感词：保守列表，只覆盖明显不可逆/外部副作用。 */
export const DEFAULT_RISK_WORDS =
  '删除,删掉,清空,格式化,覆盖,卸载,发布,部署,付款,转账,改权限,rm -rf,drop table,git reset --hard'

/** 命中敏感词时追加在消息末尾的固定文案。 */
export const RISK_NOTICE = '（语音转写提示：可能有识别误差，执行前请先确认）'

/** 每个会话第一条语音消息前加的固定提示。 */
export const FIRST_NOTICE =
  '（语音输入提示：本会话可能收到语音转写，可能有识别误差；删除、覆盖、发布、付款等不可逆操作请先确认。）'

/**
 * 把逗号分隔的敏感词拆成数组。
 * @param {unknown} value 配置值
 * @returns {string[]} 去空、去重后的词
 */
export function parseRiskWords(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  const out = []
  for (const raw of value.split(',')) {
    const word = raw.trim()
    if (word === '') continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/**
 * 文本是否命中任一敏感词（英文忽略大小写）。
 * @param {string} text 识别文本
 * @param {string[]} words 敏感词
 * @returns {string} 命中的词；没命中返回空串
 */
export function findRiskWord(text, words) {
  if (typeof text !== 'string' || text === '') return ''
  const lower = text.toLowerCase()
  for (const word of words) {
    if (lower.includes(word.toLowerCase())) return word
  }
  return ''
}

/**
 * 命中时在末尾追加提醒；已带提醒的不重复追加。
 * @param {string} text 原始文本
 * @param {boolean} enabled 是否开启
 * @param {string[]} words 敏感词
 * @returns {{ text: string, hit: string }}
 */
export function withRiskNotice(text, enabled, words) {
  if (enabled !== true) return { text, hit: '' }
  if (text.includes(RISK_NOTICE)) return { text, hit: '' }
  const hit = findRiskWord(text, words)
  if (hit === '') return { text, hit: '' }
  return { text: `${text}\n\n${RISK_NOTICE}`, hit }
}

/**
 * 第一次在该会话发语音时，在消息前加提示。
 * @param {string} text 原始文本
 * @param {Set<string>} seen 已提示过的会话 id
 * @param {string} sessionId 会话 id
 * @returns {{ text: string, first: boolean }}
 */
export function withFirstNotice(text, seen, sessionId) {
  if (seen.has(sessionId)) return { text, first: false }
  seen.add(sessionId)
  return { text: `${FIRST_NOTICE}\n\n${text}`, first: true }
}
