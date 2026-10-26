import { Fragment, ReactNode } from 'react';

/**
 * Small Markdown for the assistant's replies: paragraphs, headings, lists, tables, code, **bold**,
 * *italic* and `code`. Text only ever becomes React elements — nothing is inserted as HTML.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, '\n'))}</div>;
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cellsOf = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const numeric = (s: string) => /^[−\-+]?[\d\s.,]+%?$/.test(s);

function blocks(src: string): ReactNode[] {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      i++;
      out.push(<pre key={out.length}><code>{code.join('\n')}</code></pre>);
      continue;
    }

    // A table: a header row, the |---|---| rule, then rows.
    if (isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cellsOf(line);
      const body: string[][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) body.push(cellsOf(lines[i]));
      const right = head.map((_, c) => body.length > 0 && body.every((r) => !r[c] || numeric(r[c])));
      out.push(
        <div key={out.length} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{head.map((h, c) => <th key={c} className={right[c] ? 'num' : undefined}>{inline(h)}</th>)}</tr></thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k}>{head.map((_, c) => <td key={c} className={right[c] ? 'num' : undefined}>{inline(r[c] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(<p key={out.length} className={`md-h md-h${h[1].length}`}>{inline(h[2])}</p>);
      i++;
      continue;
    }

    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={out.length}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</List>);
      continue;
    }

    // A paragraph: consecutive plain lines, line breaks kept.
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !isRow(lines[i]) && !/^(#{1,4})\s|^\s*```|^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) para.push(lines[i]);
    if (!para.length) { para.push(lines[i]); i++; }
    out.push(<p key={out.length}>{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return out;
}

/** **bold**, *italic*, `code` inside a line. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
