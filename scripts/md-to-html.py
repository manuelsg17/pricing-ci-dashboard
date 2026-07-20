#!/usr/bin/env python3
"""Conversor markdown→HTML acotado al subset usado en los informes del repo
(h1-h3, hr, blockquote, tablas GFM, listas, **negrita**, _cursiva_, `code`).
Uso: python3 scripts/md-to-html.py entrada.md salida.html "Título del doc"
"""
import sys, re, html

def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\w)_(.+?)_(?!\w)', r'<em>\1</em>', t)
    t = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'`([^`]+?)`', r'<code>\1</code>', t)
    return t

def main():
    src, out, title = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else 'Documento')
    lines = open(src, encoding='utf-8').read().split('\n')
    body, i = [], 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        # Tablas GFM
        if s.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|?\s*$', lines[i+1].strip()):
            header = [c.strip() for c in s.strip('|').split('|')]
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            t = ['<table>', '<thead><tr>'] + [f'<th>{inline(h)}</th>' for h in header] + ['</tr></thead>', '<tbody>']
            for r in rows:
                t.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
            t += ['</tbody>', '</table>']
            body.append('\n'.join(t))
            continue
        if s == '---':
            body.append('<hr>'); i += 1; continue
        if s.startswith('### '):
            body.append(f'<h3>{inline(s[4:])}</h3>'); i += 1; continue
        if s.startswith('## '):
            body.append(f'<h2>{inline(s[3:])}</h2>'); i += 1; continue
        if s.startswith('# '):
            body.append(f'<h1>{inline(s[2:])}</h1>'); i += 1; continue
        if s.startswith('> '):
            body.append(f'<blockquote>{inline(s[2:])}</blockquote>'); i += 1; continue
        # Listas (con o sin negrita)
        if re.match(r'^([-*]|\d+\.)\s+', s):
            ordered = bool(re.match(r'^\d+\.', s))
            tag = 'ol' if ordered else 'ul'
            items = []
            while i < len(lines) and re.match(r'^([-*]|\d+\.)\s+', lines[i].strip()):
                item = re.sub(r'^([-*]|\d+\.)\s+', '', lines[i].strip())
                items.append(f'<li>{inline(item)}</li>')
                i += 1
            body.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
            continue
        if s == '':
            i += 1; continue
        body.append(f'<p>{inline(s)}</p>'); i += 1

    css = """
    body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;line-height:1.5;font-size:11pt;margin:0;}
    h1{font-size:20pt;color:#c8102e;border-bottom:2px solid #c8102e;padding-bottom:6px;margin:0 0 4px;}
    h2{font-size:15pt;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:3px;margin:20px 0 8px;}
    h3{font-size:12pt;color:#c8102e;margin:14px 0 4px;}
    p{margin:6px 0;}
    ul,ol{margin:6px 0 6px 22px;}
    li{margin:3px 0;}
    blockquote{background:#f1f5f9;border-left:4px solid #94a3b8;margin:8px 0;padding:8px 12px;color:#334155;font-size:10pt;}
    code{background:#f1f5f9;padding:1px 4px;border-radius:3px;font-family:'SF Mono',Menlo,monospace;font-size:9.5pt;color:#0f172a;}
    hr{border:none;border-top:1px solid #e2e8f0;margin:16px 0;}
    table{border-collapse:collapse;width:100%;margin:10px 0;font-size:9.5pt;}
    th{background:#c8102e;color:#fff;text-align:left;padding:6px 8px;border:1px solid #b00d27;}
    td{padding:5px 8px;border:1px solid #cbd5e1;vertical-align:top;}
    tr:nth-child(even) td{background:#f8fafc;}
    strong{color:#0f172a;}
    """
    doc = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>{css}</style></head><body>{''.join(body)}</body></html>"""
    open(out, 'w', encoding='utf-8').write(doc)
    print(f"OK → {out} ({len(body)} bloques)")

if __name__ == '__main__':
    main()
