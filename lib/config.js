/**
 * 配置读写与「字段字典」。
 *
 * 这个文件负责：用一个 CONFIG_SCHEMA 表描述每个配置字段（名称/类型/默认值/范围/说明），
 * 并基于这张表生成默认值、迁移旧配置、校验设置页提交的改动；最后把配置落到
 * <dataRoot>/config.json（临时文件 + rename，避免半截文件）。
 * 这个文件不负责：路径解析（见 paths.js）、状态机与 HTTP（见 index.js）、界面文案（见 client.js）。
 *
 * 加新字段只需要在 CONFIG_SCHEMA 里加一行，defaults / migrate / 设置页校验都会自动跟上，
 * 不用再在三个地方各写一段 if。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 当前配置结构版本。加字段时 +1；migrate() 会按 schema 自动补默认值。
 * v4 → v5：默认唤醒词/结束词从「小鲸」改成「鲸鱼」。
 * v5 → v6：新增 wakeMode / confirmMs / wakeAtStart（唤醒模式与防误触）。
 * v6 → v7：新增 HUD 相关字段（hudEnabled / hudPosition / hudCollapsed / hudOpacity）。
 * v7 → v8：新增 sessionPreset（语音会话用哪个 agent preset，默认 standard＝现有行为）。
 * v8 → v9：只保留「单次指令」一种工作方式，删掉 endWords / wakeMode / confirmMs / idleMinutes。
 * v9 → v10：删掉 minVoicedMs（每句话都带唤醒词，不再需要「最短语音」过滤）。
 * v10 → v11：新增 chimeVolume（提示音音量，0–100）。
 * v11 → v12：新增 probeEnabled（快速唤醒探测开关，默认开；这个功能吃 CPU）。
 * v12 → v13：新增 followActive（语音发到哪个会话：跟随当前打开的会话 / 固定专用会话，默认固定）。
 * v13 → v14：新增 hudZIndex（HUD 层叠高度可配，默认 2147483000）。
 * v14 → v15：新增 maxSegmentMs（单句最长录音，默认 60 秒，0=不限）。
 * v15 → v16：把连续灵敏度 vadThreshold 换成 1–10 档的 wakeSensitivity。
 */
export const CONFIG_VERSION = 16

/** 默认唤醒词。写成连贯、无标点的样子：匹配时会忽略标点，但“一口气念完”更稳。 */
export const DEFAULT_WAKE_WORDS = '鲸鱼'

/**
 * 0.3.x 及更早版本的默认词。只用于 v5 迁移的「原值判断」：
 * 只有仍然是老默认值的配置才会被改名，用户自己改过的词一律保留。
 */
export const LEGACY_DEFAULT_WAKE_WORDS = '小鲸，你在吗'

/** 是否要求唤醒词出现在识别文本开头（允许最多 1 个语气词）。 */
export const WAKE_AT_START_DEFAULT = true

/** 识别语言提示。SenseVoice 支持 auto/zh/en/ja/ko/yue。 */
export const LANGUAGE_OPTIONS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
export const LANGUAGE_DEFAULT = 'zh'

/**
 * 唤醒灵敏度：1–10 档（1 最灵敏，10 最保守）。
 * 实际阈值由浏览器半按「环境底噪 × 倍数，且不低于该档的绝对下限」计算；
 * 设置页提供 10 档滑杆 + 一键校准，校准会按测到的底噪自动选一档。
 */
export const SENSITIVITY_DEFAULT = 5
export const SENSITIVITY_MIN = 1
export const SENSITIVITY_MAX = 10

/**
 * 「静音多久算一句话说完」：默认 2000ms（2 秒）。
 * 600ms 太短，正常说话换气就会被切断；2 秒是「不容易断句」和「等待可接受」的折中。
 * 范围 400–4000ms 是安全值，避免手改配置写出 0 或几十秒。
 */
export const SILENCE_DEFAULT = 2000
export const SILENCE_MIN = 400
export const SILENCE_MAX = 8000
/** 设置页下拉的可选档位（与 client.js 保持一致）。 */
export const SILENCE_OPTIONS = [500, 800, 1200, 1600, 2000, 3000, 4000, 5000, 6000, 8000]

/**
 * 「一句话最长能说多久」：默认 60 秒，连续说话超过这个时长就强制切段并发送。
 * 档位 1 / 2 / 5 分钟；0 表示不设上限，只受浏览器内存与单次上传大小限制。
 */
export const MAX_SEGMENT_DEFAULT = 60000
export const MAX_SEGMENT_OPTIONS = [60000, 120000, 300000, 0]
/** 手改配置时的安全上限（1 小时），防止写出离谱的值。 */
export const MAX_SEGMENT_MAX = 3600000

/** HUD 默认值：默认显示、位置自动（右下角）、展开、不透明。 */
export const HUD_ENABLED_DEFAULT = true
export const HUD_COLLAPSED_DEFAULT = false
export const HUD_OPACITY_DEFAULT = 1
export const HUD_OPACITY_MIN = 0.2
/**
 * HUD 默认层叠高度：压过主界面与绝大多数插件浮层。
 * 被别的插件盖住时调大，想让它沉到别人下面时调小（配置项 hudZIndex）。
 */
export const HUD_Z_INDEX_DEFAULT = 2147483000
/** 浏览器能接受的最大 z-index。 */
export const HUD_Z_INDEX_MAX = 2147483647

/**
 * 语音会话默认使用哪个 agent preset。
 *
 * `standard` 是 0.6.0 及以前写死在 lib/index.js 里的值，所以默认值必须保持它：
 * 老配置升级后行为完全不变。改成 `computer-use` 之类是留给使用者的扩展点，
 * 插件自己不内置任何「操作电脑」的实现。
 */
export const SESSION_PRESET_DEFAULT = 'standard'

/**
 * 配置字段字典。**加字段只改这里。**
 *
 * 每个字段：
 *  - type：boolean / string / integer / number / enum / position / const
 *  - default：缺字段时的值
 *  - public：是否通过 GET /config 发给界面（内部路径类字段不发）
 *  - desc：一句话说明，诊断与 README 都用它
 *  - min / max：数字型字段的取值范围（越界夹到边界）
 *  - values：枚举型字段的合法取值（不合法回默认值）
 *  - step：数字型字段的精度（例如阈值保留 4 位小数）
 *  - integer：数字型字段是否取整
 *  - maxLength：字符串型字段的最大长度（防止手改出超长值）
 */
export const CONFIG_SCHEMA = {
  configVersion: {
    type: 'integer',
    default: CONFIG_VERSION,
    desc: '配置结构版本，迁移用，不建议手改',
  },
  enabled: {
    type: 'boolean',
    default: false,
    public: true,
    desc: '总开关。关闭时不会常听麦克风（默认关：不在用户没同意时打开麦克风）',
  },
  deviceId: {
    type: 'string',
    default: '',
    maxLength: 512,
    public: true,
    desc: '麦克风设备 id；空串表示系统默认输入设备',
  },
  wakeWords: {
    type: 'string',
    default: DEFAULT_WAKE_WORDS,
    maxLength: 512,
    public: true,
    desc: '唤醒词，英文逗号分隔可填多个说法',
  },
  wakeAtStart: {
    type: 'boolean',
    default: WAKE_AT_START_DEFAULT,
    public: true,
    desc: '是否要求唤醒词在识别文本开头（前面最多允许一个语气词）',
  },
  language: {
    type: 'enum',
    values: LANGUAGE_OPTIONS,
    default: LANGUAGE_DEFAULT,
    public: true,
    desc: '识别语言提示（auto/zh/en/ja/ko/yue）',
  },
  wakeSensitivity: {
    type: 'integer',
    default: SENSITIVITY_DEFAULT,
    min: SENSITIVITY_MIN,
    max: SENSITIVITY_MAX,
    public: true,
    desc: '唤醒灵敏度档位 1–10：1 最灵敏（小声也能唤醒），10 最保守（最不易误唤醒）；设置页可用「校准」按环境底噪自动选档',
  },
  silenceMs: {
    type: 'number',
    default: SILENCE_DEFAULT,
    min: SILENCE_MIN,
    max: SILENCE_MAX,
    integer: true,
    public: true,
    desc: '说完后静音多久算一句话结束（毫秒）',
  },
  maxSegmentMs: {
    type: 'number',
    default: MAX_SEGMENT_DEFAULT,
    min: 0,
    max: MAX_SEGMENT_MAX,
    integer: true,
    public: true,
    desc: '单句最长录音（毫秒）：连续说话超过就强制切段并发送；0 表示不设上限，只受内存与上传大小限制',
  },
  chimeVolume: {
    type: 'integer',
    default: 32,
    min: 0,
    max: 100,
    public: true,
    desc: '提示音音量（0–100）：唤醒/失败提示音的响度，0 表示静音',
  },
  probeEnabled: {
    type: 'boolean',
    default: true,
    public: true,
    // 这就是「快速唤醒探测」：每段话开头按唤醒词长度在 0.6–1.4 秒左右
    // 跑最多 3 次「只找唤醒词」的短识别，命中就立刻响提示音，不打断正常识别。
    // 代价是 CPU：每段大约多 0.2–0.5 秒单核计算（说话越多越费）。
    // 机器慢/笔记本省电场景可以关掉；关掉后提示音要等整段说完、正常识别完才响。
    desc: '快速唤醒探测：每段开头多跑最多 3 次短识别（吃 CPU，约 0.2–0.5 秒/段），换来叫醒提示音更快；关掉后提示音等整段识别完才响',
  },
  followActive: {
    type: 'boolean',
    default: false,
    public: true,
    // 默认 false：固定投递到专用会话，语音消息始终落在同一个可见的会话里；
    // 想跟着当前打开的会话走，把开关打开即可。
    desc: '发到当前会话：开启＝语音消息跟着你当前打开的会话走；关闭＝固定发到「语音唤醒会话」，切到别的会话也不变',
  },
  hudEnabled: {
    type: 'boolean',
    default: HUD_ENABLED_DEFAULT,
    public: true,
    desc: '是否显示右下角的 HUD 悬浮卡片',
  },
  hudPosition: {
    type: 'position',
    default: null,
    public: true,
    desc: 'HUD 初值：左上角坐标 {x,y}；null 表示自动放在右下角（主窗口实际位置存在 localStorage）',
  },
  hudCollapsed: {
    type: 'boolean',
    default: HUD_COLLAPSED_DEFAULT,
    public: true,
    desc: 'HUD 初值：是否折叠成 28px 小圆点（主窗口实际状态存在 localStorage）',
  },
  hudOpacity: {
    type: 'number',
    default: HUD_OPACITY_DEFAULT,
    min: HUD_OPACITY_MIN,
    max: 1,
    step: 0.05,
    public: true,
    desc: 'HUD 不透明度，0.2–1（太透明会看不见，所以 0.2 是下限）',
  },
  hudZIndex: {
    type: 'integer',
    default: HUD_Z_INDEX_DEFAULT,
    min: 0,
    max: HUD_Z_INDEX_MAX,
    public: true,
    // 这是给「被别的插件浮层盖住」留的接口：调大压过别人，调小沉到别人下面。
    // 设置页不出现这一项（普通用户用不到），改配置或 POST /config 即可。
    desc: 'HUD 层叠高度：默认 2147483000（压过主界面与多数插件）；被别的浮层盖住时调大，想让它沉到别人下面时调小',
  },
  sessionId: {
    type: 'string',
    default: '',
    maxLength: 200,
    public: true,
    desc: '专用语音会话 id；存在则复用，不存在则重新创建',
  },
  sessionPreset: {
    type: 'string',
    default: SESSION_PRESET_DEFAULT,
    maxLength: 64,
    public: true,
    desc:
      '创建语音会话时用哪个 agent preset（默认 standard）。' +
      '改成 computer-use 可以让语音指令直接驱动机器操作；这是留给使用者的扩展点，' +
      '插件本身不内置任何操作电脑的实现。',
  },
  modelRoot: {
    type: 'string',
    default: '',
    maxLength: 1024,
    desc: '模型目录；缺省时按 paths.js 的候选顺序探测',
  },
  dataRoot: {
    type: 'string',
    default: '',
    maxLength: 1024,
    desc: '插件数据目录；缺省时用 <DSH home>/dsh-voice-wake',
  },
}

/** schema 里的全部字段名（不含 configVersion）。 */
const FIELD_NAMES = Object.keys(CONFIG_SCHEMA).filter((key) => key !== 'configVersion')

/**
 * 判断一个值是否是数字（拒绝 NaN / Infinity / 字符串数字）。
 * @param {unknown} value 任意值
 * @returns {boolean} 是否有限数字
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 把一个值收敛到字段的合法范围（假设类型已经对了）。
 * @param {object} field schema 字段
 * @param {number} value 原始数字
 * @returns {number} 夹到范围内、按精度取整后的值
 */
function clampNumber(field, value) {
  let next = value
  if (isNumber(field.min)) next = Math.max(field.min, next)
  if (isNumber(field.max)) next = Math.min(field.max, next)
  if (field.integer === true) next = Math.round(next)
  if (isNumber(field.step) && field.step > 0) next = Math.round(next / field.step) * field.step
  // 浮点乘法会留下 0.0032000000000000002 这种尾巴，这里收一下。
  return Math.round(next * 1e6) / 1e6
}

/**
 * 把任意输入收敛成字段的合法值。类型不对 / 越界一律回退（范围类夹边，类型类回默认）。
 * 这是「迁移」与「默认值」共用的唯一入口。
 * @param {string} name 字段名
 * @param {unknown} value 原始值
 * @returns {unknown} 合法值
 */
export function sanitizeField(name, value) {
  const field = CONFIG_SCHEMA[name]
  if (field === undefined) return undefined
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : field.default
    case 'string': {
      if (typeof value !== 'string') return field.default
      const limit = isNumber(field.maxLength) ? field.maxLength : 0
      return limit > 0 && value.length > limit ? value.slice(0, limit) : value
    }
    case 'integer': {
      if (!isNumber(value) || !Number.isSafeInteger(value)) return field.default
      return clampNumber(field, value)
    }
    case 'number': {
      if (!isNumber(value)) return field.default
      return clampNumber(field, value)
    }
    case 'enum':
      return Array.isArray(field.values) && field.values.includes(value) ? value : field.default
    case 'position': {
      // 只接受 null 或 {x,y}；手改出半截坐标时宁可回到「自动右下角」。
      if (value === null) return null
      if (typeof value !== 'object' || Array.isArray(value)) return field.default
      const x = value.x
      const y = value.y
      if (!isNumber(x) || !isNumber(y)) return field.default
      return { x: Math.round(x), y: Math.round(y) }
    }
    default:
      return field.default
  }
}

/**
 * 判断两个配置值是否相同（position 是对象，需要按内容比较）。
 * @param {unknown} a 值 a
 * @param {unknown} b 值 b
 * @returns {boolean} 是否相同
 */
function sameValue(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return a.x === b.x && a.y === b.y
}

/**
 * 生成一份全新的默认配置。
 * @returns {object} 默认配置
 */
export function defaults() {
  const config = {}
  for (const [name, field] of Object.entries(CONFIG_SCHEMA)) {
    const value = field.default
    config[name] = value !== null && typeof value === 'object' ? { ...value } : value
  }
  return config
}

/**
 * 迁移判断用的紧凑形式：去掉空白和常见中英文标点。
 * 这样「小鲸，你在吗」「小鲸 你在吗」「小鲸你在吗?」会被视为同一个老默认值，
 * 但「小鲸，你在吗, 小鲸醒醒」这种用户加过说法的值不会命中。
 * @param {unknown} value 原始配置值
 * @returns {string} 只保留文字/字母/数字的紧凑字符串
 */
function compactWordValue(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\s，,。.、；;：:！!？?"'“”‘’]+/gu, '')
}

/**
 * 是否仍是老默认唤醒词。接受「小鲸，你在吗」的标点/空白变体，
 * 以及只写了「小鲸」两个字的老配置。
 * @param {unknown} value 配置里的 wakeWords
 * @returns {boolean} 需要迁移到「鲸鱼，你在吗」时为 true
 */
export function isLegacyWakeWords(value) {
  const compact = compactWordValue(value)
  return compact === '小鲸你在吗' || compact === '小鲸'
}

/**
 * 迁移老配置。按 CONFIG_SCHEMA 逐个字段收敛：缺字段补默认值，类型/范围不对收敛到默认值。
 *
 * 只有 v4 → v5 的「小鲸 → 鲸鱼」是特例：仅当 wakeWords 仍是老默认值的
 * 标点/空白变体（或只写了「小鲸」）时才替换，用户加过说法的值一律原样保留。
 *
 * @param {Record<string, unknown>} raw 磁盘上的原始对象
 * @returns {{ config: object, migratedFrom: number, wakeWordsMigrated: boolean }} 迁移结果
 */
export function migrate(raw) {
  const from = Number.isSafeInteger(raw?.configVersion) ? raw.configVersion : 0
  const config = defaults()
  // 只接收 schema 里的字段，多余字段直接丢弃，避免脏数据扩散。
  for (const name of FIELD_NAMES) {
    if (raw === null || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, name)) continue
    config[name] = sanitizeField(name, raw[name])
  }
  // v4 → v5：只在仍是老默认值时改名。configVersion 已经是 5 及以上的配置不动，
  // 即使用户手动把词改回「小鲸」也尊重用户。
  let wakeWordsMigrated = false
  if (from < 5) {
    if (isLegacyWakeWords(config.wakeWords)) {
      config.wakeWords = DEFAULT_WAKE_WORDS
      wakeWordsMigrated = true
    }
  }
  config.configVersion = CONFIG_VERSION
  return { config, migratedFrom: from, wakeWordsMigrated }
}

/**
 * 校验一个「只提交了部分字段」的改动，并就地写进 config。
 *
 * 与 migrate() 的区别：migrate 遇到非法值要回默认值，而设置页提交的非法值
 * 应该被**忽略**（保持原值），否则一次误传就会把用户配置重置掉。
 *
 * @param {object} config 要修改的配置（就地修改）
 * @param {Record<string, unknown>} patch 提交内容
 * @returns {{ changed: string[], ignored: string[] }} changed 为实际变化的字段名
 */
export function applyPatch(config, patch) {
  const changed = []
  const ignored = []
  if (patch === null || typeof patch !== 'object') return { changed, ignored }
  // resetSession 不是持久化字段，但它是一个显式动作，单独处理。
  if (patch.resetSession === true) {
    config.sessionId = ''
    changed.push('resetSession')
  }
  for (const name of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(patch, name)) continue
    const value = patch[name]
    const field = CONFIG_SCHEMA[name]
    // 类型不符就当没传：抛给调用方会更糟（设置页会整块保存失败）。
    const typeOk =
      field.type === 'position'
        ? value === null || (typeof value === 'object' && !Array.isArray(value))
        : typeof value === typeof field.default
    if (!typeOk) {
      ignored.push(name)
      continue
    }
    const next = sanitizeField(name, value)
    if (sameValue(config[name], next)) continue
    config[name] = next
    changed.push(name)
  }
  return { changed, ignored }
}

/**
 * 读取配置。文件不存在返回默认值（不落盘，等第一次保存时再写）。
 * @param {string} dataRoot 插件数据目录
 * @returns {{ config: object, migratedFrom: number, error: string }} 配置与读取结果
 */
export function loadConfig(dataRoot) {
  const file = join(dataRoot, 'config.json')
  if (!existsSync(file)) return { config: defaults(), migratedFrom: 0, error: '' }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...migrate(raw), error: '' }
  } catch (error) {
    return {
      config: defaults(),
      migratedFrom: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 原子写入配置：先写临时文件再 rename，断电也不会留下半截 JSON。
 * @param {string} dataRoot 插件数据目录
 * @param {object} config 要保存的配置
 * @returns {void}
 */
export function saveConfig(dataRoot, config) {
  const file = join(dataRoot, 'config.json')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, undefined, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
