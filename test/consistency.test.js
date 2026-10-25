/**
 * Host 与浏览器半各存了一份调参常量，必须保持一致。
 *
 * 两边没法互相 import（Host 在 Node，client 在页面里），所以这里直接读
 * client.js 的字面量做对照——「改了一边忘了另一边」是真实发生过的风险。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_SEGMENT_DEFAULT,
  MAX_SEGMENT_MAX,
  MAX_SEGMENT_OPTIONS,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SILENCE_DEFAULT,
  SILENCE_MAX,
  SILENCE_MIN,
  SILENCE_OPTIONS,
} from '../lib/config.js'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 读 client.js 里的数值常量。 */
function numberConst(name) {
  const match = CLIENT_SOURCE.match(new RegExp(`const ${name} = ([0-9.]+)`))
  assert.ok(match, `client.js 里找不到常量 ${name}`)
  return Number(match[1])
}

/** 读 client.js 里的数字数组常量。 */
function arrayConst(name) {
  const match = CLIENT_SOURCE.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  assert.ok(match, `client.js 里找不到常量 ${name}`)
  return match[1]
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item))
}

test('静音档位与 Host 配置一致', () => {
  assert.deepEqual(arrayConst('SILENCE_OPTIONS'), SILENCE_OPTIONS)
  assert.equal(numberConst('SILENCE_DEFAULT'), SILENCE_DEFAULT)
  assert.equal(numberConst('SILENCE_MIN'), SILENCE_MIN)
  assert.equal(numberConst('SILENCE_MAX'), SILENCE_MAX)
})

test('灵敏度档位与 Host 配置一致', () => {
  assert.equal(numberConst('SENSITIVITY_DEFAULT'), SENSITIVITY_DEFAULT)
  assert.equal(numberConst('SENSITIVITY_MIN'), SENSITIVITY_MIN)
  assert.equal(numberConst('SENSITIVITY_MAX'), SENSITIVITY_MAX)
})

test('单句最长档位与 Host 配置一致', () => {
  assert.deepEqual(arrayConst('MAX_SEGMENT_OPTIONS'), MAX_SEGMENT_OPTIONS)
  assert.equal(numberConst('MAX_SEGMENT_DEFAULT'), MAX_SEGMENT_DEFAULT)
  assert.equal(numberConst('MAX_SEGMENT_MAX'), MAX_SEGMENT_MAX)
})
