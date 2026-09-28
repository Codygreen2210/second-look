// Tests for page-check: the planted bugs in fixtures/bad.html must be caught, and fixtures/good.html
// (which has a swipeable carousel, an off-screen fixed menu and screen-reader-only text, all fine)
// must come back clean. Run with: node --test tests/*.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { serve } from './serve.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'checks', 'page-check.mjs')
let server, base

before(async () => { server = await serve(0); base = `http://127.0.0.1:${server.address().port}` })
after(() => server.close())

async function check(page, extra = []) {
  try {
    const { stdout } = await run('node', [script, `${base}/${page}`, '--json', '--widths', '390,1280', '--links', ...extra], { timeout: 120000 })
    return { code: 0, findings: JSON.parse(stdout)[0].findings }
  } catch (e) {
    if (e.code === 1) return { code: 1, findings: JSON.parse(e.stdout)[0].findings }
    throw e
  }
}
const has = (findings, level, re) => findings.some(f => f.level === level && re.test(f.msg))

test('catches every planted problem on the bad page', { timeout: 120000 }, async () => {
  const { code, findings } = await check('bad.html')
  assert.equal(code, 1, 'exit code should be 1 when something fails')
  assert.ok(has(findings, 'FAIL', /scrolls sideways/), 'sideways scroll')
  assert.ok(has(findings, 'FAIL', /div\.card/), 'names the card as the cause')
  assert.ok(findings.some(f => /text 130%/.test(f.where)), 'large-text pass ran')
  assert.ok(has(findings, 'FAIL', /undefinedFunction/), 'JS error')
  assert.ok(has(findings, 'FAIL', /no <title>/), 'missing title')
  assert.ok(has(findings, 'FAIL', /404 .*missing-page/), 'broken link')
  assert.ok(has(findings, 'WARN', /cut off with no/), 'chopped text')
  assert.ok(has(findings, 'WARN', /tap target/), 'tiny tap target')
  assert.ok(has(findings, 'WARN', /under 12px/), 'tiny text')
  assert.ok(has(findings, 'WARN', /alt text/), 'missing alt')
})

test('leaves the good page alone', { timeout: 120000 }, async () => {
  const { code, findings } = await check('good.html')
  assert.equal(code, 0)
  assert.deepEqual(findings, [])
})

test('catches content cut off by overflow:hidden only at large text', { timeout: 120000 }, async () => {
  const { code, findings } = await check('bigtext.html')
  assert.equal(code, 1)
  assert.ok(!findings.some(f => f.where === '390px' && f.level === 'FAIL'), 'fine at normal text size')
  assert.ok(findings.some(f => f.where === '390px, text 130%' && /cut off at the screen edge/.test(f.msg)), 'caught at 130%')
})

test('catches a long word spilling out of its box inside a clipped banner', { timeout: 120000 }, async () => {
  const { findings } = await check('longword.html', ['--widths', '360'])
  const big = findings.filter(f => f.where === '360px, text 130%' && f.level === 'FAIL')
  assert.ok(big.some(f => /h1 "WILDERNESS/.test(f.msg)), 'names the heading at 130% text')
})

test('warns when a web font fails to load', { timeout: 120000 }, async () => {
  const { findings } = await check('fonts.html', ['--widths', '390', '--ignore', 'no-such-font'])
  assert.ok(findings.some(f => f.where === 'fonts' && f.level === 'WARN' && /Gone Sans/.test(f.msg)))
})
