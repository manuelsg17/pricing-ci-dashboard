#!/usr/bin/env node
// Conversor markdown→PDF (jsPDF + autotable, sin navegador).
// Subset: h1-h3, hr, blockquote, tablas GFM, listas, **negrita**, `code`.
// Uso: node scripts/md-to-pdf.mjs entrada.md salida.pdf
import { readFileSync } from 'node:fs'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

const [, , SRC, OUT] = process.argv
const RED = [200, 16, 46]
const DARK = [15, 23, 42]
const GREY = [71, 85, 105]
const INK = [30, 41, 59]

// jsPDF (Helvetica) no tiene glyphs de emoji → los quitamos.
const deEmoji = (s) =>
  s
    .replace(/[←-⇿⌀-➿⬀-⯿️]/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

const doc = new jsPDF({ unit: 'pt', format: 'letter' })
const PW = doc.internal.pageSize.getWidth()
const PH = doc.internal.pageSize.getHeight()
const M = 54
const MAXW = PW - M * 2
let y = M

function ensure(h) {
  if (y + h > PH - M) {
    doc.addPage()
    y = M
  }
}

// Segmenta **negrita** / `code` / normal
function segs(text) {
  const out = []
  const re = /(\*\*.+?\*\*|`[^`]+?`)/g
  let pos = 0,
    m
  while ((m = re.exec(text))) {
    if (m.index > pos) out.push({ b: false, t: text.slice(pos, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) out.push({ b: true, t: tok.slice(2, -2) })
    else out.push({ b: false, t: tok.slice(1, -1) })
    pos = re.lastIndex
  }
  if (pos < text.length) out.push({ b: false, t: text.slice(pos) })
  return out
}

// Texto fluido con negritas inline (word-wrap manual)
function flow(text, { size = 10.5, color = INK, indent = 0, gapBefore = 4, gapAfter = 4 } = {}) {
  const left = M + indent
  const words = []
  for (const s of segs(deEmoji(text))) {
    const parts = s.t.split(/(\s+)/).filter((w) => w !== '')
    for (const w of parts) words.push({ b: s.b, t: w })
  }
  y += gapBefore
  doc.setFontSize(size)
  doc.setTextColor(...color)
  let x = left
  const lh = size * 1.38
  ensure(lh)
  for (const w of words) {
    if (/^\s+$/.test(w.t)) {
      doc.setFont('helvetica', w.b ? 'bold' : 'normal')
      x += doc.getTextWidth(' ')
      continue
    }
    doc.setFont('helvetica', w.b ? 'bold' : 'normal')
    const ww = doc.getTextWidth(w.t)
    if (x + ww > M + MAXW) {
      y += lh
      x = left
      ensure(lh)
    }
    doc.text(w.t, x, y)
    x += ww
  }
  y += lh - size * 0.2 + gapAfter
}

function heading(text, { size, color, rule = false, gapBefore = 14 }) {
  y += gapBefore
  ensure(size * 1.5 + 8)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(size)
  doc.setTextColor(...color)
  const lines = doc.splitTextToSize(deEmoji(text), MAXW)
  for (const ln of lines) {
    doc.text(ln, M, y)
    y += size * 1.25
  }
  if (rule) {
    doc.setDrawColor(color[0], color[1], color[2])
    doc.setLineWidth(color === DARK ? 0.6 : 1.2)
    doc.line(M, y - size * 0.5, M + MAXW, y - size * 0.5)
  }
  y += 6
}

function blockquote(text) {
  const size = 9.5
  doc.setFontSize(size)
  doc.setFont('helvetica', 'normal')
  const lines = doc.splitTextToSize(deEmoji(text.replace(/\*\*/g, '')), MAXW - 20)
  const h = lines.length * size * 1.4 + 14
  ensure(h)
  doc.setFillColor(241, 245, 249)
  doc.rect(M, y, MAXW, h, 'F')
  doc.setFillColor(148, 163, 184)
  doc.rect(M, y, 3, h, 'F')
  doc.setTextColor(...GREY)
  let ty = y + 12
  for (const ln of lines) {
    doc.text(ln, M + 12, ty)
    ty += size * 1.4
  }
  y += h + 6
}

function hr() {
  y += 6
  ensure(10)
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.5)
  doc.line(M, y, M + MAXW, y)
  y += 10
}

function renderTable(header, rows) {
  autoTable(doc, {
    head: [header.map(deEmoji)],
    body: rows.map((r) => r.map((c) => deEmoji(c.replace(/\*\*/g, '')))),
    startY: y + 4,
    margin: { left: M, right: M },
    styles: { fontSize: 8.5, cellPadding: 4, overflow: 'linebreak', textColor: INK, lineColor: [203, 213, 225], lineWidth: 0.5 },
    headStyles: { fillColor: RED, textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 0: { fontStyle: 'bold' } },
  })
  y = doc.lastAutoTable.finalY + 10
}

// ── Parser de bloques ──
const md = readFileSync(SRC, 'utf8')
const lines = md.split('\n')
let i = 0
while (i < lines.length) {
  const s = lines[i].trim()
  if (s.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1].trim())) {
    const header = s.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    i += 2
    const rows = []
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      i++
    }
    renderTable(header, rows)
    continue
  }
  if (s === '---') { hr(); i++; continue }
  if (s.startsWith('### ')) { heading(s.slice(4), { size: 12, color: RED, gapBefore: 12 }); i++; continue }
  if (s.startsWith('## ')) { heading(s.slice(3), { size: 15, color: DARK, rule: true, gapBefore: 16 }); i++; continue }
  if (s.startsWith('# ')) { heading(s.slice(2), { size: 21, color: RED, rule: true, gapBefore: 4 }); i++; continue }
  if (s.startsWith('> ')) { blockquote(s.slice(2)); i++; continue }
  if (/^([-*]|\d+\.)\s+/.test(s)) {
    while (i < lines.length && /^([-*]|\d+\.)\s+/.test(lines[i].trim())) {
      const item = lines[i].trim().replace(/^([-*]|\d+\.)\s+/, '')
      const bx = M + 10
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...INK)
      ensure(14)
      doc.text('•', bx, y + 10.5)
      flow(item, { indent: 22, gapBefore: 0, gapAfter: 2 })
      i++
    }
    y += 3
    continue
  }
  if (s === '') { i++; continue }
  flow(s, { gapBefore: 3, gapAfter: 3 })
  i++
}

// Pie de página con numeración
const pages = doc.internal.getNumberOfPages()
for (let p = 1; p <= pages; p++) {
  doc.setPage(p)
  doc.setFontSize(8)
  doc.setTextColor(148, 163, 184)
  doc.setFont('helvetica', 'normal')
  doc.text('Yango LATAM · Pricing CI · confidencial', M, PH - 24)
  doc.text(`${p} / ${pages}`, PW - M, PH - 24, { align: 'right' })
}

doc.save(OUT)
// jsPDF en node no escribe a disco con save(); usar output + fs
import { writeFileSync } from 'node:fs'
writeFileSync(OUT, Buffer.from(doc.output('arraybuffer')))
console.log(`OK → ${OUT} · ${pages} páginas`)
