/**
 * 配置层测试：默认值、迁移、补丁校验。
 *
 * 这些用例保护的是「用户升级后配置不会突然变」以及「手改/写坏的值不会把插件弄崩」，
 * 精简 config.js 时先跑这里，红了就说明行为变了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_VERSION,
  applyPatch,
  defaults,
  migrate,
  sanitizeField,
} from '../lib/config.js'
import { DEFAULT_RISK_WORDS } from '../lib/risk.js'

test('默认值：版本、单句最长、静音、HUD 层级、灵敏度、跟随会话', () => {
  const cfg = defaults()
  assert.equal(cfg.configVersion, CONFIG_VERSION)
  assert.equal(cfg.maxSegmentMs, 60000)
  assert.equal(cfg.silenceMs, 2000)
  assert.equal(cfg.wakeSensitivity, 5)
  assert.equal(cfg.wakeWords, '鲸鱼')
  assert.equal(cfg.hudZIndex, 2147483000)
  assert.equal(cfg.followActive, false)
  assert.equal(cfg.hudEnabled, true)
  assert.equal(cfg.riskNotice, true)
  assert.equal(cfg.riskWords, DEFAULT_RISK_WORDS)
  assert.equal(cfg.logTranscript, false)
})

test('迁移：老配置会补上新字段的默认值', () => {
  const { config } = migrate({ configVersion: 14 })
  assert.equal(config.configVersion, CONFIG_VERSION)
  assert.equal(config.maxSegmentMs, 60000)
  assert.equal(config.wakeSensitivity, 5)
  assert.equal(config.hudZIndex, 2147483000)
  assert.equal(config.riskNotice, true)
  assert.equal(config.riskWords, DEFAULT_RISK_WORDS)
})

test('迁移：旧的连续阈值会被换成灵敏度档位', () => {
  const { config } = migrate({ configVersion: 15, vadThreshold: 0.0032 })
  assert.equal(config.wakeSensitivity, 5)
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'vadThreshold'), false)
})

test('迁移：仍是老默认唤醒词才改名，用户自定义的保持不变', () => {
  assert.equal(migrate({ configVersion: 4, wakeWords: '小鲸，你在吗' }).config.wakeWords, '鲸鱼')
  assert.equal(migrate({ configVersion: 4, wakeWords: '小鲸，你好' }).config.wakeWords, '小鲸，你好')
})

test('补丁：单句最长越界会被夹到安全上限', () => {
  const cfg = defaults()
  applyPatch(cfg, { maxSegmentMs: 9_999_999_999_999 })
  assert.equal(cfg.maxSegmentMs, 3_600_000)
})

test('补丁：0 是合法值，表示不设上限', () => {
  const cfg = defaults()
  const { changed } = applyPatch(cfg, { maxSegmentMs: 0 })
  assert.deepEqual(changed, ['maxSegmentMs'])
  assert.equal(cfg.maxSegmentMs, 0)
})

test('补丁：类型不对的值会被忽略，不会覆盖原值', () => {
  const cfg = defaults()
  const { ignored } = applyPatch(cfg, { maxSegmentMs: '120000' })
  assert.deepEqual(ignored, ['maxSegmentMs'])
  assert.equal(cfg.maxSegmentMs, 60000)
})

test('校验：说完后静音的毫秒数会被夹到 400–8000', () => {
  assert.equal(sanitizeField('silenceMs', 99), 400)
  assert.equal(sanitizeField('silenceMs', 9999), 8000)
})

test('校验：坐标只接受 {x,y}，写坏就回到「自动右下角」', () => {
  assert.deepEqual(sanitizeField('hudPosition', { x: 120, y: 340 }), { x: 120, y: 340 })
  assert.equal(sanitizeField('hudPosition', { x: 'a', y: 1 }), null)
  assert.equal(sanitizeField('hudPosition', null), null)
})

test('补丁：resetSession 会清空专用会话 id', () => {
  const cfg = defaults()
  cfg.sessionId = 'session-123'
  applyPatch(cfg, { resetSession: true })
  assert.equal(cfg.sessionId, '')
})
