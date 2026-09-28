#!/usr/bin/env node
// page-check: load pages the way people actually see them and report what's broken.
//
//   node checks/page-check.mjs <url> [more urls] [--widths 360,412,1280] [--out dir] [--links] [--json]
//                              [--big-text 1.3 | --no-big-text] [--font "Family Name=path/to/font.woff2"]
//                              [--ignore <regex>]  drop errors/requests matching it (e.g. hosts a sandbox can't reach)
//
// Every phone width is checked twice: normal text, then with text scaled up 30% the way it is on
// phones with larger text turned on in settings (lots of people do this; it's where layouts break).
//
// What it looks for, at every width:
//   FAIL  page scrolls sideways, or content is cut off at the screen edge (and which element causes it)
//   FAIL  JavaScript errors, pages or files that return 4xx/5xx, broken links (with --links)
//   FAIL  missing <title>
//   WARN  text cut off with no "..." , tap targets smaller than 24px on phones, text under 12px on phones,
//         missing meta description, missing alt text, no <h1> or several
//   INFO  page is set to noindex, title length, console warnings
//   WARN  web fonts that failed to load. A fallback font has different widths, so layout results for
//         that page can't be trusted until the real font is supplied with --font (repeatable).
// Exit code is 1 when anything FAILs, so it can gate a pull request.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
function loadPlaywright() {
  const tries = ['playwright']
  if (process.env.PLAYWRIGHT_PATH) tries.unshift(process.env.PLAYWRIGHT_PATH)
  for (const t of tries) { try { return require(t) } catch {} }
  console.error('second-look: Playwright not found. Run `npm install second-look` (or `npm install` in this repo), then `npx playwright install chromium`.')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { urls: [], widths: [360, 412, 1280], out: null, links: false, json: false, wait: 800, bigText: 1.3, fonts: [], ignore: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--widths') opts.widths = argv[++i].split(',').map(Number).filter(Boolean)
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--links') opts.links = true
    else if (a === '--big-text') opts.bigText = Number(argv[++i])
    else if (a === '--no-big-text') opts.bigText = 0
    else if (a === '--ignore') opts.ignore.push(new RegExp(argv[++i]))
    else if (a === '--font') { const [family, file] = argv[++i].split('='); opts.fonts.push({ family, file }) }
    else if (a === '--json') opts.json = true
    else if (a === '--wait') opts.wait = Number(argv[++i])
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0) }
    else opts.urls.push(a)
  }
  if (!opts.urls.length) { console.error('usage: page-check.mjs <url> [--widths 360,412,1280] [--out dir] [--links] [--json]'); process.exit(2) }
  return opts
}

// Runs inside the page. Returns layout problems at the current viewport.
function inspectLayout(screenWidth) {
  // Use the real device width. When a page is too wide, phone browsers zoom out and
  // window.innerWidth grows to match it, which would hide the very bug we're looking for.
  const W = screenWidth || window.innerWidth
  const isPhone = W < 800
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)

  const describe = el => {
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
    if (cls.length) s += '.' + cls.join('.')
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
    return text ? `${s} "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"` : s
  }
  const visible = (el, r, cs) => r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01
  const inFixed = el => { for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed') return true } return false }
  // An ancestor that scrolls sideways (overflow auto/scroll) and sits on screen means the overflow is on
  // purpose, like a carousel: people can swipe to it. An ancestor that HIDES overflow is different: the part
  // past the edge is simply gone. That's fine for decoration, not for words or buttons.
  const scrollable = el => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (/(auto|scroll)/.test(cs.overflowX)) {
        const r = p.getBoundingClientRect()
        if (r.right <= W + 1 && r.left >= -1) return true
      }
    }
    return false
  }
  // Text cut short with "…" on purpose (text-overflow: ellipsis on a clipping box) is a design choice, not a bug.
  const ellipsized = el => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.textOverflow === 'ellipsis' && /(hidden|clip)/.test(cs.overflowX)) return true
    }
    return false
  }
  const hasContent = el => (el.innerText || '').trim().length > 0 || !!el.querySelector('a[href], button, input, select, textarea, img, video') || /^(A|BUTTON|INPUT|SELECT|TEXTAREA|IMG|VIDEO)$/.test(el.tagName)
  const srOnly = (r, cs) => (cs.position === 'absolute' && (r.width <= 2 || r.height <= 2)) || cs.clip.startsWith('rect(0') || cs.clipPath === 'inset(50%)'

  const offenders = new Set()
  const els = document.body ? [...document.body.querySelectorAll('*')] : []
  for (const el of els) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (!visible(el, r, cs) || srOnly(r, cs)) continue
    if (r.right > W + 1 || r.left < -1) {
      if (inFixed(el) || scrollable(el) || !hasContent(el) || el.closest('[aria-hidden=true]')) continue
      offenders.add(el)
    }
  }
  // Words can spill out of a box that itself fits (a long word in a big heading). Check where the
  // text actually ends, not just where its box ends.
  const walker0 = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  while (walker0.nextNode()) {
    const n = walker0.currentNode
    const el = n.parentElement
    if (!el || !n.textContent.trim() || offenders.has(el)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (!visible(el, r, cs) || srOnly(r, cs) || el.closest('[aria-hidden=true]')) continue
    range.selectNodeContents(n)
    const spill = [...range.getClientRects()].some(q => q.width > 0.5 && (q.right > W + 1 || q.left < -1))
    if (spill && !inFixed(el) && !scrollable(el) && !ellipsized(el)) offenders.add(el)
  }

  // Keep only the outermost offenders so the report names the cause, not every child of it.
  const top = [...offenders].filter(el => !offenders.has(el.parentElement))
  const overflow = top.slice(0, 8).map(el => {
    const r = el.getBoundingClientRect()
    return { el: describe(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
  })

  // Text that is cut off without an ellipsis (an ellipsis means someone meant it).
  const cutText = []
  for (const el of els) {
    const cs = getComputedStyle(el)
    if (!/(hidden|clip)/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue
    const r0 = el.getBoundingClientRect()
    if (srOnly(r0, cs)) continue
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    if (!ownText) continue
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) cutText.push(describe(el))
    if (cutText.length >= 6) break
  }

  const smallTargets = []
  const tinyText = []
  if (isPhone) {
    for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (!visible(el, r, cs) || srOnly(r, cs) || el.closest('[aria-hidden=true]')) continue
      // WCAG 2.5.8 exempts links inside running text.
      if (el.tagName === 'A' && cs.display === 'inline' && el.parentElement && el.parentElement.innerText.trim().length > el.innerText.trim().length + 20) continue
      if (r.width < 24 || r.height < 24) smallTargets.push(`${describe(el)} (${Math.round(r.width)}×${Math.round(r.height)})`)
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set()
    while (walker.nextNode()) {
      const n = walker.currentNode
      const el = n.parentElement
      if (!el || seen.has(el) || !n.textContent.trim()) continue
      seen.add(el)
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (!visible(el, r, cs) || srOnly(r, cs)) continue
      const size = parseFloat(cs.fontSize)
      if (size < 12) tinyText.push(`${describe(el)} (${size}px)`)
    }
  }

  return { W, docW, sideways: docW > W + 1, overflow, cutText, smallTargets: smallTargets.slice(0, 8), smallTargetCount: smallTargets.length, tinyText: tinyText.slice(0, 6), tinyTextCount: tinyText.length }
}

// Runs inside the page once per URL: things that don't depend on screen width.
function inspectPage() {
  const meta = n => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') || null
  const imgsNoAlt = [...document.images].filter(i => !i.hasAttribute('alt') && i.getBoundingClientRect().width > 2).map(i => (i.getAttribute('src') || '').slice(0, 80))
  const links = [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)))]
  return {
    title: document.title || null,
    description: meta('description'),
    robots: meta('robots'),
    viewport: meta('viewport'),
    lang: document.documentElement.getAttribute('lang'),
    h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim().slice(0, 60)),
    imgsNoAlt: imgsNoAlt.slice(0, 6), imgsNoAltCount: imgsNoAlt.length,
    links,
  }
}

async function checkUrl(browser, url, opts) {
  const findings = []
  const add = (level, where, msg) => findings.push({ level, where, msg })
  let pageInfo = null

  for (const width of opts.widths) {
    const phone = width < 800
    const ctx = await browser.newContext({ viewport: { width, height: phone ? 860 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 })
    const page = await ctx.newPage()
    const errors = [], warnings = [], bad = []
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]))
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text().split('\n')[0])
      else if (m.type() === 'warning') warnings.push(m.text().split('\n')[0])
    })
    page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`) })
    page.on('requestfailed', r => { const f = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(f)) bad.push(`failed (${f}) ${r.url()}`) })

    const where = `${width}px`
    let resp
    try {
      resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
    } catch (e) {
      try { resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 }) } catch (e2) { add('FAIL', where, `page did not load: ${String(e2.message).split('\n')[0]}`); await ctx.close(); continue }
    }
    if (resp && resp.status() >= 400) add('FAIL', where, `page returned ${resp.status()}`)

    // Supply fonts the page couldn't download (e.g. a sandbox with no access to Google Fonts).
    for (const f of opts.fonts) {
      const data = fs.readFileSync(f.file).toString('base64')
      const fmt = f.file.endsWith('.woff2') ? 'woff2' : f.file.endsWith('.woff') ? 'woff' : 'truetype'
      await page.addStyleTag({ content: `@font-face{font-family:"${f.family}";src:url(data:font/${fmt};base64,${data}) format("${fmt}");font-weight:1 1000;font-display:block}` })
      await page.evaluate(fam => document.fonts.load(`40px "${fam}"`), f.family).catch(() => {})
    }
    if (width === opts.widths[0]) {
      const supplied = new Set(opts.fonts.map(f => f.family))
      const broken = await page.evaluate(() => [...new Set([...document.fonts].filter(f => f.status === 'error').map(f => f.family.replace(/^["']|["']$/g, '')))])
      const fontReqs = bad.filter(b => /fonts\.(googleapis|gstatic)\.com|\.(woff2?|ttf|otf)(\?|$)/.test(b))
      const missing = broken.map(f => f.replace(/ Fallback$/, '')).filter(f => !supplied.has(f))
      if (missing.length || (fontReqs.length && !opts.fonts.length)) {
        add('WARN', 'fonts', `fonts failed to load (${[...new Set(missing)].join(', ') || fontReqs[0]}). Layout results below use a fallback font and may not match what visitors see. Supply the real font with --font "Name=file.woff2".`)
      }
    }

    // Scroll to the bottom and back so lazy content renders, then give it a moment.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)) }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(opts.wait)

    const layoutFindings = (L, label) => {
      if (L.sideways) add('FAIL', label, `page scrolls sideways: content is ${L.docW}px wide on a ${L.W}px screen`)
      if (L.overflow.length) {
        const lines = L.overflow.map(o => `${o.el}  spans ${o.left}→${o.right}px`)
        add('FAIL', label, `${L.sideways ? 'caused by' : 'content cut off at the screen edge'}:\n      ` + lines.join('\n      '))
      }
      if (L.cutText.length) add('WARN', label, 'text cut off with no "…":\n      ' + L.cutText.join('\n      '))
    }
    const L = await page.evaluate(inspectLayout, width)
    layoutFindings(L, where)
    if (L.smallTargetCount) add('WARN', where, `${L.smallTargetCount} tap target(s) under 24px, e.g.:\n      ` + L.smallTargets.join('\n      '))
    if (L.tinyTextCount) add('WARN', where, `${L.tinyTextCount} text element(s) under 12px, e.g.:\n      ` + L.tinyText.join('\n      '))

    const uniq = a => [...new Set(a)]
    const keep = x => !opts.ignore.some(re => re.test(x))
    errors.splice(0, errors.length, ...errors.filter(keep)); bad.splice(0, bad.length, ...bad.filter(keep))
    if (errors.length) add('FAIL', where, 'JavaScript errors:\n      ' + uniq(errors).slice(0, 6).join('\n      '))
    if (bad.length) add('FAIL', where, 'requests that failed:\n      ' + uniq(bad).slice(0, 8).join('\n      '))
    if (warnings.length) add('INFO', where, `${uniq(warnings).length} console warning(s), first: ${uniq(warnings)[0].slice(0, 140)}`)

    if (opts.out) {
      fs.mkdirSync(opts.out, { recursive: true })
      const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60)
      await page.screenshot({ path: path.join(opts.out, `${slug}_${width}.png`), fullPage: true })
    }
    if (!pageInfo) pageInfo = await page.evaluate(inspectPage)

    if (phone && opts.bigText > 1) {
      // Scale every piece of text the way a phone's "larger text" setting does (px sizes included).
      await page.evaluate(scale => {
        const els = [...document.querySelectorAll('body, body *')]
        const sizes = els.map(el => parseFloat(getComputedStyle(el).fontSize))
        els.forEach((el, i) => { if (sizes[i]) el.style.setProperty('font-size', (sizes[i] * scale) + 'px', 'important') })
      }, opts.bigText)
      await page.waitForTimeout(300)
      const big = `${width}px, text ${Math.round(opts.bigText * 100)}%`
      layoutFindings(await page.evaluate(inspectLayout, width), big)
      if (opts.out) {
        const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60)
        await page.screenshot({ path: path.join(opts.out, `${slug}_${width}_bigtext.png`), fullPage: true })
      }
    }
    await ctx.close()
  }

  if (pageInfo) {
    const P = pageInfo
    if (!P.title) add('FAIL', 'page', 'no <title>')
    else if (P.title.length > 65) add('INFO', 'page', `title is ${P.title.length} characters; Google cuts off around 60: "${P.title}"`)
    if (!P.description) add('WARN', 'page', 'no meta description')
    if (!P.viewport) add('FAIL', 'page', 'no viewport meta tag, phones will show the desktop layout zoomed out')
    if (!P.lang) add('WARN', 'page', 'no lang attribute on <html>')
    if (P.h1.length === 0) add('WARN', 'page', 'no <h1>')
    if (P.h1.length > 1) add('INFO', 'page', `${P.h1.length} <h1> tags: ${P.h1.map(h => `"${h}"`).join(', ')}`)
    if (P.imgsNoAltCount) add('WARN', 'page', `${P.imgsNoAltCount} image(s) with no alt text, e.g. ${P.imgsNoAlt.join(', ')}`)
    if (P.robots && /noindex/i.test(P.robots)) add('INFO', 'page', `set to "${P.robots}", search engines will not list it`)

    if (opts.links) {
      const origin = new URL(url).origin
      const same = P.links.filter(h => h.startsWith(origin)).map(h => h.split('#')[0])
      const broken = []
      for (const h of [...new Set(same)].slice(0, 60)) {
        try {
          const r = await fetch(h, { redirect: 'follow' })
          if (r.status >= 400) broken.push(`${r.status} ${h}`)
        } catch (e) { broken.push(`unreachable ${h}`) }
      }
      if (broken.length) add('FAIL', 'links', 'broken links:\n      ' + broken.join('\n      '))
    }
  }
  return { url, findings }
}

const opts = parseArgs(process.argv.slice(2))
const { chromium } = loadPlaywright()
const browser = await chromium.launch()
const results = []
for (const url of opts.urls) results.push(await checkUrl(browser, url, opts))
await browser.close()

const fails = results.reduce((n, r) => n + r.findings.filter(f => f.level === 'FAIL').length, 0)
if (opts.json) console.log(JSON.stringify(results, null, 2))
else {
  for (const r of results) {
    console.log(`\n${r.url}`)
    if (!r.findings.length) { console.log('  nothing found'); continue }
    const order = { FAIL: 0, WARN: 1, INFO: 2 }
    for (const f of [...r.findings].sort((a, b) => order[a.level] - order[b.level])) console.log(`  ${f.level.padEnd(4)} [${f.where}] ${f.msg}`)
  }
  console.log(`\n${fails ? fails + ' FAIL finding(s)' : 'no FAIL findings'}`)
}
process.exit(fails ? 1 : 0)
