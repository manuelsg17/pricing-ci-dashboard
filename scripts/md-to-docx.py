#!/usr/bin/env python3
"""Conversor markdown→DOCX (WordprocessingML real, con tablas nativas).
Subset: h1-h3, hr, blockquote, tablas GFM, listas, **negrita**, _cursiva_, `code`.
Uso: python3 scripts/md-to-docx.py entrada.md salida.docx
Sin dependencias: arma el .docx (zip de XML) a mano.
"""
import sys, re, zipfile
from xml.sax.saxutils import escape

RED = "C8102E"; DARK = "0F172A"; GREY = "475569"; LGREY = "CBD5E1"; SOFT = "F1F5F9"

def runs(text):
    """Convierte inline **b** _i_ `code` en runs WordprocessingML."""
    out, i = [], 0
    # tokenizamos por marcas
    pattern = re.compile(r'(\*\*.+?\*\*|`[^`]+?`|(?<!\w)_.+?_(?!\w))')
    pos = 0
    for m in pattern.finditer(text):
        if m.start() > pos:
            out.append(('n', text[pos:m.start()]))
        tok = m.group(0)
        if tok.startswith('**'):
            out.append(('b', tok[2:-2]))
        elif tok.startswith('`'):
            out.append(('c', tok[1:-1]))
        else:
            out.append(('i', tok[1:-1]))
        pos = m.end()
    if pos < len(text):
        out.append(('n', text[pos:]))
    xml = []
    for kind, t in out:
        rpr = ''
        if kind == 'b': rpr = '<w:b/>'
        elif kind == 'i': rpr = '<w:i/>'
        elif kind == 'c': rpr = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="0F172A"/>'
        xml.append(f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{escape(t)}</w:t></w:r>')
    return ''.join(xml) or '<w:r><w:t/></w:r>'

def para(text, *, size=None, color=None, bold=False, before=120, after=60, bottom_border=False, shade=None, ind=None, bullet=False):
    ppr = ['<w:spacing w:before="%d" w:after="%d"/>' % (before, after)]
    if bottom_border:
        ppr.append('<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="2" w:color="%s"/></w:pBdr>' % (color or LGREY))
    if shade:
        ppr.append('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % shade)
        ppr.append('<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="94A3B8"/></w:pBdr>')
    if ind:
        ppr.append('<w:ind w:left="%d"/>' % ind)
    if bullet:
        ppr.append('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
    # construir runs con overrides de formato global (size/color/bold)
    if size or color or bold:
        rpr = ''
        if bold: rpr += '<w:b/>'
        if color: rpr += '<w:color w:val="%s"/>' % color
        if size: rpr += '<w:sz w:val="%d"/>' % size
        # aplicar a cada run interno respetando negritas inline
        inner = runs(text)
        inner = re.sub(r'<w:rPr>', '<w:rPr>' + rpr, inner)
        body = inner
    else:
        body = runs(text)
    return f'<w:p><w:pPr>{"".join(ppr)}</w:pPr>{body}</w:p>'

def table(header, rows):
    gridcols = ''.join('<w:gridCol/>' for _ in header)
    def cell(txt, *, head=False, first=False):
        shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{RED}"/>' if head else ''
        r = runs(txt)
        if head:
            r = re.sub(r'<w:rPr>', '<w:rPr><w:b/><w:color w:val="FFFFFF"/>', r)
        elif first:
            r = re.sub(r'<w:rPr>', '<w:rPr><w:b/>', r)
        return (f'<w:tc><w:tcPr><w:tcBorders>'
                f'<w:top w:val="single" w:sz="4" w:color="{LGREY}"/><w:bottom w:val="single" w:sz="4" w:color="{LGREY}"/>'
                f'<w:left w:val="single" w:sz="4" w:color="{LGREY}"/><w:right w:val="single" w:sz="4" w:color="{LGREY}"/>'
                f'</w:tcBorders>{shd}</w:tcPr>'
                f'<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>{r}</w:p></w:tc>')
    trs = ['<w:tr>' + ''.join(cell(h, head=True) for h in header) + '</w:tr>']
    for row in rows:
        trs.append('<w:tr>' + ''.join(cell(c, first=(j == 0)) for j, c in enumerate(row)) + '</w:tr>')
    return (f'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>'
            f'<w:tblLayout w:type="fixed"/></w:tblPr>'
            f'<w:tblGrid>{gridcols}</w:tblGrid>{"".join(trs)}</w:tbl>')

def convert(md):
    lines = md.split('\n'); out = []; i = 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|?\s*$', lines[i+1].strip()):
            header = [c.strip() for c in s.strip('|').split('|')]
            i += 2; rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')]); i += 1
            out.append(table(header, rows)); continue
        if s == '---':
            out.append(para('', bottom_border=True, before=60, after=60)); i += 1; continue
        if s.startswith('### '):
            out.append(para(s[4:], size=26, color=RED, bold=True, before=220, after=60)); i += 1; continue
        if s.startswith('## '):
            out.append(para(s[3:], size=32, color=DARK, bold=True, before=280, after=80, bottom_border=True)); i += 1; continue
        if s.startswith('# '):
            out.append(para(s[2:], size=44, color=RED, bold=True, before=40, after=120, bottom_border=True)); i += 1; continue
        if s.startswith('> '):
            out.append(para(s[2:], size=20, color=GREY, shade=SOFT, before=120, after=120)); i += 1; continue
        if re.match(r'^([-*]|\d+\.)\s+', s):
            while i < len(lines) and re.match(r'^([-*]|\d+\.)\s+', lines[i].strip()):
                item = re.sub(r'^([-*]|\d+\.)\s+', '', lines[i].strip())
                out.append(para(item, bullet=True, before=20, after=20)); i += 1
            continue
        if s == '':
            i += 1; continue
        out.append(para(s, before=80, after=80)); i += 1
    return '\n'.join(out)

def build(md_path, out_path):
    md = open(md_path, encoding='utf-8').read()
    body = convert(md)
    document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>'''
    numbering = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'''
    styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:color w:val="1E293B"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'''
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>'''
    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
    doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>'''
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', document)
        z.writestr('word/styles.xml', styles)
        z.writestr('word/numbering.xml', numbering)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
    print(f'OK → {out_path}')

if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
