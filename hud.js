/**
 * 语音唤醒 HUD：一个「只管显示」的悬浮卡片组件。
 *
 * 这个文件负责：
 *  - 把宿主给的状态快照（state / level / deviceName）画成一张小卡片；
 *  - 卡片自己的交互：拖动、折叠、关闭、单击音量区静音。
 * 这个文件不负责：发 HTTP 请求、读写插件配置、判断唤醒词、import DSH 的任何模块。
 * 对外的唯一入口是 createHud()，返回 { update, destroy }（见下面的 JSDoc）。
 *
 * 为什么写成这样：卡片以后可能要整体搬进「独立置顶窗口」（例如一个只加载
 * 本文件的 Electron BrowserWindow）。那边没有 DSH 的 ctx / slots / 私有模块，
 * 只有标准的 document / window / localStorage，所以这里只用浏览器自带 API，
 * 文案全部由宿主通过 strings 注入，颜色和尺寸全部集中在下面的 LOOK / COLOR。
 */

/* ============================================================== 常量区 ====
 * 所有「魔法数字」都在这里，并且写明为什么是这个值。换皮 / 换配色只需要改这一段。
 */

/** localStorage 键前缀。带插件名，避免与宿主或其他插件撞键。 */
const STORAGE_PREFIX = 'dsh-voice-wake.hud.'

/** 记住卡片左上角坐标（展开态与折叠态共用同一个锚点）。 */
const STORAGE_KEY_POSITION = `${STORAGE_PREFIX}position`

/** 记住是否折叠成小圆点。 */
const STORAGE_KEY_COLLAPSED = `${STORAGE_PREFIX}collapsed`

/** 合法的三种状态。宿主传别的一律按 off 处理，组件永远不崩。 */
const STATES = ['off', 'listening', 'conversing']

/**
 * 视觉常量。全部是像素值，集中在这里方便换皮。
 * 卡片宽度取 288：一行里要同时放「状态点 + 状态文字 + 8 段音量 + 数字 + 2 个按钮」，
 * 再窄就会把状态文字挤成两行。
 */
const LOOK = {
  cardWidth: 288,
  radius: 12,
  padding: '8px 10px',
  gap: 6,
  fontSize: 12.5,
  /** 折叠态是 28px 的小圆点（需求给定）：够点、又几乎不挡视线。 */
  dotSize: 28,
  /** 折叠态里那个彩色圆点的直径；比外圈小，留出点击热区。 */
  dotInner: 12,
  /** 音量条段数（需求给定 8 段）。 */
  barCount: 8,
  barWidth: 5,
  /** 最矮的一段：静音时也保留一条浅色底，让人知道这里能点。 */
  barMinHeight: 3,
  /** 音量 100% 时的段高。 */
  barMaxHeight: 18,
  /** 行首状态点直径。 */
  statusDot: 8,
  /** 卡片离窗口边缘的默认留白。 */
  edgeMargin: 12,
  /**
   * 默认位置额外让开的底部高度。主界面右下角本来就有常驻挂件，
   * 卡片往上挪这么多就不会压住它；想贴边就把这里改成 0。
   */
  bottomInset: 96,
  /** 位移超过这么多像素才算「拖动」，否则当点击（避免手抖导致卡片跑偏）。 */
  dragThreshold: 3,
  /** 默认层叠高度：压过主界面，但宿主可以通过 options.zIndex 改。 */
  zIndex: 2147483000,
  /** 设备名最多显示多少字（超出补省略号，只进 tooltip）。 */
  textMaxChars: 40,
  /** 默认不透明度；宿主的配置项 hudOpacity 可以覆盖。 */
  opacity: 1,
  /** 图标按钮左右内边距：收起/展开现在是文字按钮，需要一点横向空间。 */
  buttonPadX: 4,
  /** 图标按钮的边长。 */
  buttonSize: 16,
  /** 图标按钮的圆角。 */
  buttonRadius: 4,
  /** 音量区（整块按钮）的圆角。 */
  muteRadius: 6,
  /** 音量条每一段的圆角。 */
  barRadius: 2,
  /** 音量数字的最小宽度：保证 1 位和 3 位数切换时卡片不抖。 */
  numMinWidth: 24,
  /** 音量数字字号。 */
  numFontSize: 11.5,
  /** 状态文字的最大宽度：再宽会把音量条挤出去。 */
  statusMaxWidth: 76,
  /** 状态点/分段之间的最小空隙，防止窄窗口下重叠。 */
  minGap: 2,
  /** 键盘焦点框的粗细与偏移（无障碍）。 */
  focusRing: 2,
  focusOffset: 1,
  /** 音量条涨落时长；短一点才跟得上说话。 */
  barTransitionMs: 80,
  /** 颜色渐变时长（状态切换时）。 */
  colorTransitionMs: 120,
  /** 状态点外发光半径。 */
  glowRadius: 8,
  /**
   * 展开态高度的估计值（px）。只在「刚挂载、浏览器还没算完布局」时用来算默认位置；
   * 正常浏览器里 offsetHeight 立刻就有值，用不到它。
   */
  estimatedHeight: 64,
}

/**
 * 配色。三种状态各一色（灰 / 青 / 绿），其余是卡片底色与文字色。
 * 想换主题只改这里；CSS 全部由这些值拼出来。
 */
const COLOR = {
  off: '#8a8f98',
  listening: '#12b5c9',
  conversing: '#12b76a',
  background: 'rgba(30, 34, 42, 0.92)',
  text: '#f2f4f7',
  muted: 'rgba(242, 244, 247, 0.62)',
  track: 'rgba(255, 255, 255, 0.18)',
  border: 'rgba(255, 255, 255, 0.12)',
  hover: 'rgba(255, 255, 255, 0.10)',
  shadow: 'rgba(0, 0, 0, 0.32)',
}

/**
 * 缺省文案（英文）。正常使用时宿主一定会注入本地化 strings；
 * 这里只是防御：漏传某个键时界面上出现英文，而不是 "undefined"。
 */
const FALLBACK_STRINGS = {
  label: 'Voice HUD',
  stateOff: 'Off',
  stateListening: 'Listening',
  stateConversing: 'In conversation',
  mute: 'Mute',
  unmute: 'Unmute',
  collapse: 'Collapse',
  expand: 'Expand',
  close: 'Close',
}

/* ============================================================== 样式 ==== */

/**
 * 卡片样式。整段样式只作用在组件自己的根节点 / Shadow DOM 里，
 * 不往宿主页面写任何全局规则，destroy() 时随根节点一起消失。
 * @returns {string} CSS 文本
 */
function buildCss() {
  const iconButton = `
    height: ${LOOK.buttonSize}px; min-width: ${LOOK.buttonSize}px;
    display: inline-grid; place-items: center; padding: 0 ${LOOK.buttonPadX}px;
    border: 0; border-radius: ${LOOK.buttonRadius}px; background: transparent;
    color: ${COLOR.muted}; font: inherit; font-size: 11px; line-height: 1;
    white-space: nowrap; cursor: pointer; flex: none;
  `
  return `
  .hud {
    position: fixed;
    left: 0; top: 0;
    box-sizing: border-box;
    width: ${LOOK.cardWidth}px;
    padding: ${LOOK.padding};
    border-radius: ${LOOK.radius}px;
    border: 1px solid ${COLOR.border};
    background: ${COLOR.background};
    color: ${COLOR.text};
    box-shadow: 0 8px 24px ${COLOR.shadow};
    font: ${LOOK.fontSize}px/1.3 "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; gap: ${LOOK.gap}px;
    user-select: none; -webkit-user-select: none;
    touch-action: none;
    cursor: grab;
  }
  .hud.is-dragging { cursor: grabbing; }
  .hud[data-collapsed="true"] {
    width: ${LOOK.dotSize}px; height: ${LOOK.dotSize}px;
    padding: 0; border-radius: 50%;
    display: grid; place-items: center;
  }
  /* 折叠态只留小圆点，展开态只留正文；用属性选择器切换，避免频繁改 style。 */
  .hud[data-collapsed="true"] .hud-body { display: none; }
  .hud:not([data-collapsed="true"]) .hud-folded { display: none; }
  .hud-folded { width: 100%; height: 100%; display: grid; place-items: center; }
  .hud-folded-dot {
    width: ${LOOK.dotInner}px; height: ${LOOK.dotInner}px; border-radius: 50%;
    background: var(--hud-color);
    box-shadow: 0 0 ${LOOK.glowRadius}px var(--hud-color);
  }
  .hud-body { display: flex; flex-direction: column; gap: ${LOOK.gap}px; }
  .hud-head {
    display: flex; align-items: center; gap: ${LOOK.gap}px; min-width: 0;
    /* 固定行高：音量条最高 barMaxHeight + 上下内边距，避免音量条涨落时
       整行高度变化把状态小圆点顶得上下跳。 */
    min-height: ${LOOK.barMaxHeight + LOOK.minGap * 2}px;
  }
  .hud-status-dot {
    width: ${LOOK.statusDot}px; height: ${LOOK.statusDot}px; border-radius: 50%;
    background: var(--hud-color); box-shadow: 0 0 ${LOOK.glowRadius}px var(--hud-color); flex: none;
  }
  .hud-state {
    font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: ${LOOK.statusMaxWidth}px;
  }
  .hud-spacer { flex: 1 1 auto; min-width: ${LOOK.minGap * 2}px; }
  /* 音量区本身是按钮：点击 = 静音/恢复。 */
  .hud-mute {
    display: flex; align-items: center; gap: ${LOOK.minGap}px;
    padding: ${LOOK.minGap}px 3px; border: 0; border-radius: ${LOOK.muteRadius}px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .hud-mute:hover { background: ${COLOR.hover}; }
  .hud-mute:focus-visible {
    outline: ${LOOK.focusRing}px solid var(--hud-color);
    outline-offset: ${LOOK.focusOffset}px;
  }
  .hud-bar {
    width: ${LOOK.barWidth}px; height: ${LOOK.barMinHeight}px;
    border-radius: ${LOOK.barRadius}px;
    background: ${COLOR.track};
    transition: height ${LOOK.barTransitionMs}ms linear, background ${LOOK.colorTransitionMs}ms linear;
  }
  .hud-bar.is-on { background: var(--hud-color); }
  .hud-num {
    min-width: ${LOOK.numMinWidth}px; text-align: right; font-size: ${LOOK.numFontSize}px;
    font-variant-numeric: tabular-nums; color: ${COLOR.muted};
  }
  .hud-actions { display: flex; align-items: center; gap: ${LOOK.minGap}px; flex: none; }
  .hud-button { ${iconButton} }
  .hud-button:hover { background: ${COLOR.hover}; color: ${COLOR.text}; }
  .hud-button:focus-visible {
    outline: ${LOOK.focusRing}px solid var(--hud-color);
    outline-offset: ${LOOK.focusOffset}px;
  }
  /* 折叠按钮里的小圆点：示意「卡片会缩成这个圆点」。 */
  .hud-fold-icon {
    display: block; width: 7px; height: 7px; border-radius: 50%;
    background: currentColor; opacity: 0.85;
  }
  .hud-button:hover .hud-fold-icon { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .hud-bar { transition: none; }
  }
  `
}

/* ========================================================== 小工具 ==== */

/**
 * 截断字符串（按「字符」而不是字节，中文不会被切坏）。
 * @param {unknown} value 任意值
 * @param {number} max 最多保留多少字
 * @returns {string} 去空白、超长补省略号的文本
 */
function clip(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * 把状态收敛到三种合法值。
 * @param {unknown} value 宿主传的状态
 * @returns {'off'|'listening'|'conversing'} 合法状态
 */
function normalizeState(value) {
  return STATES.includes(value) ? value : 'off'
}

/**
 * 把音量收敛到 0..1。NaN / 越界都当 0，避免把非法值写进 style。
 * @param {unknown} value 宿主传的音量
 * @returns {number} 0..1 的有限数字
 */
function normalizeLevel(value) {
  const level = Number(value)
  if (!Number.isFinite(level)) return 0
  return Math.min(1, Math.max(0, level))
}

/**
 * 只在数字有限时保留它，否则返回 undefined（用于位置校验）。
 * @param {unknown} value 任意值
 * @returns {number|undefined} 有限数字
 */
function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 造一个可用的 localStorage 适配器。隐私模式 / 沙箱 iframe 里访问会抛异常，
 * 这种情况返回 null，组件退化成「不记忆位置」，但功能照常。
 * @returns {{getItem:Function,setItem:Function}|null} 存储适配器
 */
function createLocalStorageAdapter() {
  try {
    const store = window.localStorage
    if (store === undefined || store === null) return null
    // 真读一次：某些环境下 localStorage 存在但一用就抛。
    store.getItem(STORAGE_KEY_COLLAPSED)
    return store
  } catch {
    return null
  }
}

/* ============================================================ 组件 ==== */

/**
 * 创建 HUD 卡片。
 *
 * 契约（宿主只需要知道这些）：
 *  - 纯展示：不访问网络、不读配置、不依赖 DSH；
 *  - 位置与折叠状态记在 localStorage（键名带 dsh-voice-wake.hud. 前缀）；
 *  - 所有文案来自 strings，所有颜色/尺寸来自本文件顶部的 LOOK / COLOR。
 *
 * @param {object} params 创建参数
 * @param {Element} params.mount 挂载容器（组件会在这个容器里建自己的根节点，destroy 时只删自己建的节点）
 * @param {() => void} [params.onRequestMute] 单击音量区时调用（宿主决定是静音还是恢复）
 * @param {() => void} [params.onRequestClose] 点关闭时调用；不传则只把卡片隐藏起来
 * @param {object} [params.strings] 界面文案（键见 FALLBACK_STRINGS）；缺键用英文兜底
 * @param {object} [params.options] 可选微调，见下面逐项注释
 * @param {number} [params.options.zIndex] 层叠高度，默认 2147483000
 * @param {number} [params.options.opacity] 不透明度 0.2–1，默认 1
 * @param {boolean} [params.options.shadow] 是否用 Shadow DOM 隔离样式，默认 true（环境不支持时自动退回普通节点）
 * @param {object|null} [params.options.storage] 自定义持久化（{get,set}）；传 null 表示不记忆；默认 localStorage
 * @param {object|null} [params.options.initialPosition] 初值 {x,y}，仅在没有任何已保存位置时使用
 * @param {boolean} [params.options.initialCollapsed] 初值：是否折叠，仅在没有任何已保存状态时使用
 * @returns {{update: (snapshot: object) => void, destroy: () => void}} HUD 句柄
 * @throws {TypeError} mount 不是可用的 DOM 容器
 */
export function createHud(params) {
  const {
    mount,
    onRequestMute,
    onRequestClose,
    strings: injectedStrings,
    options = {},
  } = params ?? {}

  if (mount === null || mount === undefined || typeof mount.appendChild !== 'function') {
    throw new TypeError('createHud: `mount` must be a DOM container that supports appendChild')
  }
  const strings = { ...FALLBACK_STRINGS, ...(injectedStrings ?? {}) }

  /* ------------------------------------------------------------ 状态 */

  /** 当前快照。只保留渲染需要的三样东西，其余（deviceName）只进 tooltip。 */
  const view = { state: 'off', level: 0, deviceName: '' }
  /** 折叠状态（会持久化）。 */
  let collapsed = false
  /** 左上角坐标（会持久化）。 */
  let position = { x: 0, y: 0 }
  /** 拖动中的临时状态；null 表示没在拖。 */
  let drag = null
  /** 是否已销毁。销毁后所有回调直接返回，避免拖动中卸载报错。 */
  let destroyed = false

  /* -------------------------------------------------------- 持久化 */

  const storage =
    options.storage === undefined ? createLocalStorageAdapter() : options.storage === null ? null : options.storage

  /**
   * 读一个已保存的值。存储坏了就当没存过。
   * @param {string} key 键名
   * @returns {string|null} 原始字符串
   */
  function readStored(key) {
    if (storage === null || typeof storage.getItem !== 'function') return null
    try {
      return storage.getItem(key)
    } catch {
      return null
    }
  }

  /**
   * 写一个值。写不进去（配额满 / 只读）不影响界面。
   * @param {string} key 键名
   * @param {string} value 要存的值
   */
  function writeStored(key, value) {
    if (storage === null || typeof storage.setItem !== 'function') return
    try {
      storage.setItem(key, value)
    } catch {
      // 存不下就算了，下次打开回到默认位置。
    }
  }

  /** 读出上次的位置；格式不对返回 null。 */
  function loadStoredPosition() {
    const raw = readStored(STORAGE_KEY_POSITION)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw)
      const x = finiteNumber(parsed?.x)
      const y = finiteNumber(parsed?.y)
      return x === undefined || y === undefined ? null : { x, y }
    } catch {
      return null
    }
  }

  /** 把当前位置写进存储。 */
  function persistPosition() {
    writeStored(STORAGE_KEY_POSITION, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }))
  }

  /* ---------------------------------------------------------- 结构 */

  /** 组件自己的根节点（destroy 时删掉它，不碰宿主的 mount）。 */
  const host = document.createElement('div')
  host.setAttribute('data-dsh-voice-wake-hud', '')

  // 优先用 Shadow DOM：样式绝对隔离，塞进任何窗口都不会和宿主 CSS 打架。
  // 老环境 / 测试环境没有 attachShadow 时退回普通节点（样式写成后代选择器即可）。
  let root = host
  if (options.shadow !== false && typeof host.attachShadow === 'function') {
    try {
      root = host.attachShadow({ mode: 'open' })
    } catch {
      root = host
    }
  }

  const styleEl = document.createElement('style')
  styleEl.textContent = buildCss()
  root.append(styleEl)

  const card = document.createElement('div')
  card.className = 'hud'
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', strings.label)
  card.dataset.state = 'off'
  card.dataset.collapsed = 'false'
  card.style.setProperty('--hud-color', COLOR.off)
  card.style.zIndex = String(finiteNumber(options.zIndex) ?? LOOK.zIndex)
  card.style.opacity = String(clampOpacity(options.opacity))
  root.append(card)

  // ---- 折叠态：只有一个彩色小圆点
  const folded = document.createElement('div')
  folded.className = 'hud-folded'
  const foldedDot = document.createElement('span')
  foldedDot.className = 'hud-folded-dot'
  folded.append(foldedDot)
  card.append(folded)

  // ---- 展开态
  const body = document.createElement('div')
  body.className = 'hud-body'
  card.append(body)

  const head = document.createElement('div')
  head.className = 'hud-head'
  body.append(head)

  const statusDot = document.createElement('span')
  statusDot.className = 'hud-status-dot'
  statusDot.setAttribute('aria-hidden', 'true')
  head.append(statusDot)

  // 状态文字。role="status" + aria-live="polite"：状态变化会被读屏软件念出来，
  // 但不会打断用户正在输入的内容。
  const stateText = document.createElement('span')
  stateText.className = 'hud-state'
  stateText.setAttribute('role', 'status')
  stateText.setAttribute('aria-live', 'polite')
  head.append(stateText)

  const spacer = document.createElement('span')
  spacer.className = 'hud-spacer'
  head.append(spacer)

  // 音量区 = 一个按钮（8 段 + 数字）。单击静音。
  const muteButton = document.createElement('button')
  muteButton.type = 'button'
  muteButton.className = 'hud-mute'
  muteButton.setAttribute('data-hud-control', '')
  muteButton.setAttribute('aria-pressed', 'false')
  head.append(muteButton)

  /** 8 段音量条。段数固定，display 只改高度和颜色，不做重排。 */
  const bars = []
  for (let index = 0; index < LOOK.barCount; index += 1) {
    const bar = document.createElement('span')
    bar.className = 'hud-bar'
    bars.push(bar)
    muteButton.append(bar)
  }

  const levelNumber = document.createElement('span')
  levelNumber.className = 'hud-num'
  levelNumber.textContent = '0'
  muteButton.append(levelNumber)

  // 两个图标按钮：折叠 / 关闭。
  const actions = document.createElement('div')
  actions.className = 'hud-actions'
  head.append(actions)

  const foldButton = document.createElement('button')
  foldButton.type = 'button'
  foldButton.className = 'hud-button'
  foldButton.setAttribute('data-hud-control', '')
  // 小圆点图标：直接对应「卡片会缩成一个小圆点」，比三角/文字都直观。
  const foldDot = document.createElement('span')
  foldDot.className = 'hud-fold-icon'
  foldButton.append(foldDot)
  foldButton.setAttribute('aria-label', strings.collapse)
  foldButton.title = strings.collapse
  actions.append(foldButton)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'hud-button'
  closeButton.setAttribute('data-hud-control', '')
  closeButton.textContent = '✕'
  actions.append(closeButton)

  // 卡片只保留状态点 + 音量条 + 按钮；识别文本已经直接出现在聊天窗口里，不再重复显示。

  /* -------------------------------------------------------- 渲染 */

  /**
   * 收敛透明度到 0.2–1。太透明会让卡片彻底看不见，所以 0.2 是下限。
   * @param {unknown} value 原始值
   * @returns {number} 0.2–1
   */
  function clampOpacity(value) {
    const number = finiteNumber(value)
    if (number === undefined) return LOOK.opacity
    return Math.min(1, Math.max(0.2, number))
  }

  /**
   * 卡片当前实际高度。布局还没算出来时用估计值，保证默认位置不会偏出屏幕。
   * @returns {number} 像素高度
   */
  function heightOf() {
    if (card.offsetHeight > 0) return card.offsetHeight
    return collapsed ? LOOK.dotSize : LOOK.estimatedHeight
  }

  /**
   * 应用坐标：先把卡片夹进可视区，再写 left/top。
   * 夹的目的是「换显示器 / 改窗口大小后卡片不会跑到屏幕外」。
   * @param {number} x 期望左上角 x
   * @param {number} y 期望左上角 y
   * @param {boolean} persist 是否顺便写进存储
   */
  function applyPosition(x, y, persist) {
    const width = card.offsetWidth > 0 ? card.offsetWidth : LOOK.cardWidth
    const height = heightOf()
    const maxX = Math.max(LOOK.edgeMargin, window.innerWidth - width - LOOK.edgeMargin)
    const maxY = Math.max(LOOK.edgeMargin, window.innerHeight - height - LOOK.edgeMargin)
    position = {
      x: Math.min(maxX, Math.max(LOOK.edgeMargin, x)),
      y: Math.min(maxY, Math.max(LOOK.edgeMargin, y)),
    }
    card.style.left = `${Math.round(position.x)}px`
    card.style.top = `${Math.round(position.y)}px`
    if (persist) persistPosition()
  }

  /** 默认位置：主窗口右下角，并往上让开底部常驻挂件。 */
  function defaultPosition() {
    const width = card.offsetWidth > 0 ? card.offsetWidth : LOOK.cardWidth
    const height = heightOf()
    return {
      x: window.innerWidth - width - LOOK.edgeMargin,
      y: window.innerHeight - height - LOOK.edgeMargin - LOOK.bottomInset,
    }
  }

  /** 把音量画成 8 段 + 数字。
   * 用 Math.round(level * 8) 决定点亮几段：0.06 已经点亮第一段，
   * 这样只要有一点声音就能看出来，而不是非要到 1/8。
   * @param {number} level 0..1
   */
  function renderLevel(level) {
    const onCount = level <= 0 ? 0 : Math.max(1, Math.round(level * LOOK.barCount))
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index]
      const on = index < onCount
      // 点亮的段越高：从 30% 到 100% 的高度，视觉上有起伏而不是一排等号。
      const ratio = on ? 0.3 + (0.7 * (index + 1)) / LOOK.barCount : 0
      bar.style.height = `${Math.round(LOOK.barMinHeight + (LOOK.barMaxHeight - LOOK.barMinHeight) * ratio)}px`
      bar.classList.toggle('is-on', on)
    }
    levelNumber.textContent = String(Math.round(level * 100))
    // 按钮文案跟着状态走：off 时提示「恢复」，其余提示「静音」。
    const muted = view.state === 'off'
    muteButton.setAttribute('aria-label', muted ? strings.unmute : strings.mute)
    muteButton.setAttribute('aria-pressed', muted ? 'false' : 'true')
    muteButton.title = muted ? strings.unmute : strings.mute
  }

  /**
   * 渲染状态文字与颜色。
   * @param {'off'|'listening'|'conversing'} state 状态
   */
  function renderState(state) {
    const label =
      state === 'listening'
        ? strings.stateListening
        : state === 'conversing'
          ? strings.stateConversing
          : strings.stateOff
    card.dataset.state = state
    card.style.setProperty('--hud-color', COLOR[state])
    stateText.textContent = label
    card.title = view.deviceName === '' ? strings.label : `${strings.label} · ${view.deviceName}`
  }

  /* ------------------------------------------------------- 折叠 */

  /**
   * 切换折叠态。折叠时以卡片中心为锚点，避免小圆点「跳」到左上角。
   * @param {boolean} next 目标折叠状态
   * @param {boolean} persist 是否写进存储
   */
  function setCollapsed(next, persist) {
    if (collapsed === next) return
    const rect = { left: position.x, top: position.y, width: card.offsetWidth, height: card.offsetHeight }
    collapsed = next
    card.dataset.collapsed = next ? 'true' : 'false'
    card.setAttribute('aria-expanded', next ? 'false' : 'true')
    // 图标固定是「—」（收起是最小化语义）；展开靠点小圆点，不显示这个按钮。
    foldButton.setAttribute('aria-label', next ? strings.expand : strings.collapse)
    foldButton.title = next ? strings.expand : strings.collapse
    // 折叠/展开后尺寸变了，用旧中心点回算新左上角。
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    applyPosition(centerX - card.offsetWidth / 2, centerY - card.offsetHeight / 2, persist)
    if (persist) writeStored(STORAGE_KEY_COLLAPSED, next ? '1' : '0')
  }

  /* ------------------------------------------------------- 事件 */

  /**
   * 调宿主的回调。宿主抛异常只吞掉，不能让 HUD 把整页拖垮。
   * @param {Function|undefined} handler 回调
   */
  function invoke(handler) {
    if (typeof handler !== 'function') return
    try {
      handler()
    } catch {
      // 宿主的回调出错与展示无关，忽略。
    }
  }

  /** 收起卡片（有 onRequestClose 就交给宿主，否则只隐藏自己）。 */
  function requestClose() {
    if (typeof onRequestClose === 'function') {
      // 关闭时顺手把折叠状态复位：下次从设置页重新打开应该是一张完整卡片，
      // 而不是用户上次折叠留下的 28px 圆点。
      writeStored(STORAGE_KEY_COLLAPSED, '0')
      invoke(onRequestClose)
      return
    }
    host.style.display = 'none'
  }

  /** 单击音量区：静音 / 恢复。 */
  function handleMuteClick() {
    invoke(onRequestMute)
  }

  /** 按下：记下起点，准备拖动；落在按钮/音量区上的按下不当拖动。 */
  function handlePointerDown(event) {
    if (destroyed || event.button !== 0) return
    const target = event.target
    if (typeof target?.closest === 'function' && target.closest('[data-hud-control]') !== null) return
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    }
    card.classList.add('is-dragging')
    try {
      card.setPointerCapture(event.pointerId)
    } catch {
      // 不支持指针捕获也不影响——我们在 window 上也监听了。
    }
  }

  /** 移动：超过阈值才算拖动，拖的过程不写存储（松手才写）。 */
  function handlePointerMove(event) {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(deltaX, deltaY) < LOOK.dragThreshold) return
    drag.moved = true
    applyPosition(drag.originX + deltaX, drag.originY + deltaY, false)
  }

  /** 松手：拖过就记住位置；没拖过且处于折叠态，就当「点一下展开」。 */
  function handlePointerUp(event) {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const moved = drag.moved
    drag = null
    card.classList.remove('is-dragging')
    try {
      card.releasePointerCapture(event.pointerId)
    } catch {
      // 同上。
    }
    if (moved) {
      persistPosition()
      return
    }
    if (collapsed) setCollapsed(false, true)
  }

  /** 窗口尺寸变化后把卡片夹回可视区。 */
  function handleResize() {
    applyPosition(position.x, position.y, false)
  }

  // 事件全部挂在组件自己的节点上；只有 pointermove/up 和 resize 挂在 window 上，
  // 这样拖到卡片外面也能正常跟手 / 收尾。
  card.addEventListener('pointerdown', handlePointerDown)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
  window.addEventListener('resize', handleResize)
  muteButton.addEventListener('click', handleMuteClick)
  foldButton.addEventListener('click', () => setCollapsed(!collapsed, true))
  closeButton.addEventListener('click', requestClose)

  /* ----------------------------------------------------- 初始化 */

  foldButton.setAttribute('aria-label', strings.collapse)
  foldButton.title = strings.collapse
  closeButton.setAttribute('aria-label', strings.close)
  closeButton.title = strings.close
  card.setAttribute('aria-expanded', 'true')
  renderState('off')
  renderLevel(0)

  mount.append(host)

  // 位置与折叠状态：存储优先，其次用宿主给的初值，最后是右下角默认位。
  const storedPosition = loadStoredPosition()
  if (storedPosition !== null) {
    applyPosition(storedPosition.x, storedPosition.y, false)
  } else {
    const initialX = finiteNumber(options.initialPosition?.x)
    const initialY = finiteNumber(options.initialPosition?.y)
    if (initialX !== undefined && initialY !== undefined) {
      applyPosition(initialX, initialY, false)
    } else {
      const fallback = defaultPosition()
      applyPosition(fallback.x, fallback.y, false)
    }
  }

  const storedCollapsed = readStored(STORAGE_KEY_COLLAPSED)
  const initialCollapsed =
    storedCollapsed === null ? options.initialCollapsed === true : storedCollapsed === '1'
  if (initialCollapsed) setCollapsed(true, false)

  /* --------------------------------------------------------- API */

  /**
   * 更新卡片。允许只传部分字段（缺的保持上一次的值）。
   * @param {object} snapshot 状态快照
   * @param {'off'|'listening'|'conversing'} [snapshot.state] 状态
   * @param {number} [snapshot.level] 音量 0..1（越界夹到边界）
   * @param {string} [snapshot.deviceName] 设备名，只进 tooltip
   */
  function update(snapshot) {
    if (destroyed || snapshot === null || typeof snapshot !== 'object') return

    if (snapshot.state !== undefined) {
      view.state = normalizeState(snapshot.state)
      renderState(view.state)
    }
    if (snapshot.deviceName !== undefined) {
      const next = clip(snapshot.deviceName, LOOK.textMaxChars)
      if (next !== view.deviceName) {
        view.deviceName = next
        renderState(view.state)
      }
    }
    if (snapshot.level !== undefined) {
      // 契约是 0..1；宿主给了 87 这种越界值就夹到 1，绝不把非法值写进 style。
      view.level = normalizeLevel(snapshot.level)
      renderLevel(view.level)
    }
  }

  /**
   * 销毁：移除所有监听器与节点。可以重复调用。
   * 只删组件自己建的那层 host，不动宿主传进来的 mount。
   */
  function destroy() {
    if (destroyed) return
    destroyed = true
    card.removeEventListener('pointerdown', handlePointerDown)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    window.removeEventListener('resize', handleResize)
    muteButton.removeEventListener('click', handleMuteClick)
    host.remove()
  }

  return { update, destroy }
}
