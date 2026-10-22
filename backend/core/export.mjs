import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ExternalHyperlink, BorderStyle, TableLayoutType, VerticalAlign, Footer, PageNumber, AlignmentType } from 'docx';

export function toMarkdown(session, selectedIds) {
  const messages = selectedIds?.length ? session.messages.filter(m => selectedIds.includes(m.id)) : session.messages;
  return `# ${session.topic}\n\n> 知隙学习对话 · ${session.createdAt}\n${session.demo ? '> 示例模式：内容不代表真实模型评估。\n' : ''}\n` + messages.map(m => `## ${m.role === 'user' ? '我' : '知隙'}\n\n${m.content}\n`).join('\n');
}
export function toHtml(markdown, title = '知隙学习记录') {
  const body = sanitizeHtml(marked.parse(markdown), { allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'pre', 'code', 'del']), allowedAttributes: { a: ['href', 'title'], code: ['class'] }, allowedSchemes: ['https', 'http', 'mailto'] });
  const escaped = title.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escaped}</title><style>@page{size:A4;margin:19mm}*{box-sizing:border-box}body{font:11pt/1.8 "Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#172237;max-width:850px;margin:30px auto;padding:0 24px}h1{font-size:25pt;line-height:1.35}h2{font-size:16pt;margin-top:26px}h1,h2,h3{break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f9;padding:12px;font:9pt/1.6 Consolas,monospace}code{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #d9d9d9;padding:8px;overflow-wrap:anywhere}th{background:#edf2fa}tr{break-inside:avoid}blockquote{border-left:3px solid #3477f6;padding-left:14px;color:#53627a}a{color:#2465d4}@media print{body{margin:0;padding:0;max-width:none}a{text-decoration:none}}</style></head><body>${body}</body></html>`;
}
function plain(value) { return value.replace(/<[^>]*>/g, ''); }
function runs(tokens = [], style = {}) {
  return tokens.flatMap(t => {
    if (t.type === 'strong') return runs(t.tokens, { ...style, bold: true });
    if (t.type === 'em') return runs(t.tokens, { ...style, italics: true });
    if (t.type === 'del') return runs(t.tokens, { ...style, strike: true });
    if (t.type === 'link') return /^(https?:|mailto:)/i.test(t.href) ? [new ExternalHyperlink({ link: t.href, children: runs(t.tokens || [{ type: 'text', text: t.text }], { ...style, style: 'Hyperlink' }) })] : runs(t.tokens || [{ type: 'text', text: t.text }], style);
    if (t.type === 'codespan') return [new TextRun({ ...style, text: t.text, font: 'Consolas', size: 19 })];
    if (t.type === 'br') return [new TextRun({ break: 1 })];
    if (t.type === 'html') return [];
    if (t.tokens) return runs(t.tokens, style);
    return [new TextRun({ ...style, text: plain(t.text || t.raw || '') })];
  });
}
export async function toDocx(markdown) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
  const children = [];
  const blocks = (tokens, indent = 0) => {
    for (const token of tokens) {
      if (token.type === 'heading') children.push(new Paragraph({ children: runs(token.tokens), heading: token.depth === 1 ? HeadingLevel.TITLE : token.depth === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 220, after: 180 } }));
      else if (token.type === 'code') for (const line of token.text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })], shading: { fill: 'F4F6F9' }, spacing: { after: 30 }, wordWrap: true, indent: { left: indent } }));
      else if (token.type === 'table') {
        const weights = token.header.map((cell, col) => Math.min(60, Math.max(8, cell.text.length, ...token.rows.map(row => row[col]?.text.length || 0))));
        const total = weights.reduce((a, b) => a + b, 0); const widths = weights.map(w => Math.floor(9746 * w / total));
        children.push(new Table({ width: { size: 9746, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: widths, rows: [token.header, ...token.rows].map((cells, i) => new TableRow({ tableHeader: i === 0, cantSplit: true, children: cells.map((cell, col) => new TableCell({ width: { size: widths[col], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, margins: { top: 110, bottom: 110, left: 120, right: 120 }, borders: { top: border, bottom: border, left: border, right: border }, shading: { fill: i === 0 ? 'EAF0F9' : i % 2 ? 'FFFFFF' : 'F6F8FB' }, children: [new Paragraph({ alignment: ({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT })[token.align[col]] || AlignmentType.LEFT, children: runs(cell.tokens, i === 0 ? { bold: true } : {}), spacing: { after: 0, line: 300 } })] })) })) }));
        children.push(new Paragraph({ spacing: { after: 100 } }));
      } else if (token.type === 'list') {
        token.items.forEach((item, index) => {
          const head = item.tokens.filter(t => t.type !== 'list');
          children.push(new Paragraph({ children: [new TextRun(`${token.ordered ? `${(Number(token.start) || 1) + index}.` : '•'} `), ...head.flatMap(t => runs(t.tokens || marked.Lexer.lexInline(t.text || '')))], indent: { left: indent + 300, hanging: 240 }, spacing: { after: 100 } }));
          blocks(item.tokens.filter(t => t.type === 'list'), indent + 300);
        });
      } else if (token.type === 'blockquote') blocks(token.tokens, indent + 240);
      else if (token.type === 'paragraph' || token.type === 'text') children.push(new Paragraph({ children: token.tokens ? runs(token.tokens) : [new TextRun(plain(token.text || ''))], spacing: { after: 140 }, indent: { left: indent } }));
    }
  };
  blocks(marked.lexer(markdown));
  return Packer.toBuffer(new Document({ styles: { default: { document: { run: { font: { name: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' }, size: 22, color: '000000' }, paragraph: { spacing: { line: 330 } } } }, paragraphStyles: [ { id: 'Title', name: 'Title', basedOn: 'Normal', run: { color: '000000', size: 46, bold: true } }, { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', run: { color: '000000', size: 32, bold: true } }, { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', run: { color: '000000', size: 27, bold: true } } ] }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '667085' })] })] }) }, children }] }));
}
