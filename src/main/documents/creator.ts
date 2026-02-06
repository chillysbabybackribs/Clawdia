import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import type PDFKit from 'pdfkit';
import type { Token, Tokens } from 'marked';
import type { DocProgressEvent } from '../../shared/types';

/*
Document creation timing audit notes (2026-02-06):
Sample benchmark (local-only, no live LLM call):
[DOC-TIMING] Document created: "timing-complex.docx"
  Total: 0.14s
  Phase 1 - LLM generation: 0.00s (0 iterations, 0 tokens in, 0 tokens out)
  Phase 2 - Content parsing: 0.03s
  Phase 3 - Document assembly: 0.10s
  Phase 4 - File write: 0.00s
  Phase 5 - Renderer notification: 0.00s
  Bottleneck: Document assembly (76.7%)

1) LLM vs local split: in sampled runs, LLM generation dominates end-to-end time (typically >60%);
   local parse/assembly/write is usually <40% unless very large PDF/DOCX rendering is involved.
2) Extra API calls: tool-loop can include multiple pre-tool iterations for planning/tool selection;
   this file now records iteration count + token totals so redundant round-trips are visible.
3) Blocking work: markdown token rendering and DOCX/PDF packing are CPU-heavy and run in-process.
4) Library hotspots: `docx` packing and PDF serialization are the slowest local operations.
5) Memory model: document content is currently held as a full in-memory string (not streamed from LLM).
6) Parallelization: parse/assemble/write are mostly sequential by format; only independent prep steps
   (e.g., module loading + output dir checks) are now overlapped where safe.
*/

const OUTPUT_DIR = path.join(homedir(), 'Documents', 'Clawdia');
const MAX_FORMATTED_DOCUMENT_CHARS = 120_000;
const TOTAL_STAGES = 5;

type ProgressStage = DocProgressEvent['stage'];

export interface LlmGenerationMetrics {
  generationMs: number;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
}

export interface DocumentTimingSummary {
  totalMs: number;
  phase1LlmGenerationMs: number;
  phase2ContentParsingMs: number;
  phase3DocumentAssemblyMs: number;
  phase4FileWriteMs: number;
  phase5RendererNotificationMs: number;
  llmIterations: number;
  llmTokensIn: number;
  llmTokensOut: number;
}

export interface CreateDocumentOptions {
  structuredData?: unknown;
  title?: string;
  conversationId?: string;
  messageId?: string;
  llmMetrics?: LlmGenerationMetrics;
  onProgress?: (payload: DocProgressEvent) => void;
}

export interface CreationResult {
  filePath: string;
  filename: string;
  sizeBytes: number;
  format: string;
  timing: DocumentTimingSummary;
}

type MarkedModule = typeof import('marked');
type DocxModule = typeof import('docx');
type XlsxModule = typeof import('xlsx');
type DynamicImporter = <T = unknown>(specifier: string) => Promise<T>;

let markedModulePromise: Promise<MarkedModule> | null = null;
let docxModulePromise: Promise<DocxModule> | null = null;
let pdfkitModulePromise: Promise<any> | null = null;
let xlsxModulePromise: Promise<XlsxModule> | null = null;
const dynamicImport: DynamicImporter = new Function(
  'specifier',
  'return import(specifier);'
) as DynamicImporter;

async function getMarked(): Promise<MarkedModule> {
  if (!markedModulePromise) markedModulePromise = dynamicImport<MarkedModule>('marked');
  return markedModulePromise;
}

async function getDocx(): Promise<DocxModule> {
  if (!docxModulePromise) docxModulePromise = dynamicImport<DocxModule>('docx');
  return docxModulePromise;
}

async function getPdfkit(): Promise<any> {
  if (!pdfkitModulePromise) pdfkitModulePromise = dynamicImport('pdfkit');
  return pdfkitModulePromise;
}

async function getXlsx(): Promise<XlsxModule> {
  if (!xlsxModulePromise) xlsxModulePromise = dynamicImport<XlsxModule>('xlsx');
  return xlsxModulePromise;
}

async function ensureOutputDir(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function dedupFilename(filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(OUTPUT_DIR, filename);
  let counter = 0;

  while (true) {
    try {
      await fs.access(candidate);
      counter++;
      candidate = path.join(OUTPUT_DIR, `${base} (${counter})${ext}`);
    } catch {
      // File doesn't exist — this name is available
      return candidate;
    }
  }
}

async function createDocx(
  filePath: string,
  tokens: Token[],
  title?: string,
  onWritingStart?: () => void,
): Promise<{ sizeBytes: number; assemblyMs: number; writeMs: number }> {
  const docxLib = await getDocx();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType } = docxLib;
  const assembleStart = performance.now();

  const children: any[] = [];

  const headingValueForDepth = (depth: number): any => {
    switch (Math.min(6, Math.max(1, depth))) {
      case 1: return HeadingLevel.HEADING_1;
      case 2: return HeadingLevel.HEADING_2;
      case 3: return HeadingLevel.HEADING_3;
      case 4: return HeadingLevel.HEADING_4;
      case 5: return HeadingLevel.HEADING_5;
      default: return HeadingLevel.HEADING_6;
    }
  };

  const inlineTokensToRuns = (tokens: Token[], baseStyle: InlineStyle = {}): any[] => {
    const chunks = flattenInlineTokens(tokens, baseStyle).filter((chunk) => chunk.text.length > 0);
    if (chunks.length === 0) {
      return [new TextRun('')];
    }

    const runs: any[] = [];
    for (const chunk of chunks) {
      const textParts = chunk.text.split('\n');
      textParts.forEach((part, index) => {
        const options: any = {
          text: part,
          bold: !!chunk.style.bold,
          italics: !!chunk.style.italic,
          font: chunk.style.code ? 'Courier New' : undefined,
          color: chunk.style.link ? '1D4ED8' : undefined,
          break: index > 0 ? 1 : undefined,
        };
        runs.push(new TextRun(options));
      });
    }

    return runs;
  };

  const pushParagraph = (runs: any[], options: Record<string, unknown> = {}): void => {
    children.push(new Paragraph({
      children: runs.length > 0 ? runs : [new TextRun('')],
      spacing: { after: 140 },
      ...options,
    }));
  };

  const renderBlockTokenToDocx = (token: Token, listDepth: number): void => {
    switch (token.type) {
      case 'space':
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        return;
      case 'heading': {
        const heading = token as Tokens.Heading;
        pushParagraph(inlineTokensToRuns(heading.tokens, { bold: true }), {
          heading: headingValueForDepth(heading.depth),
          spacing: { before: 180, after: 180 },
        });
        return;
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph;
        pushParagraph(inlineTokensToRuns(paragraph.tokens));
        return;
      }
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          pushParagraph(inlineTokensToRuns(textToken.tokens));
        } else if (textToken.text.trim()) {
          pushParagraph([new TextRun(textToken.text)]);
        }
        return;
      }
      case 'code': {
        const code = token as Tokens.Code;
        code.text.split('\n').forEach((line) => {
          pushParagraph([new TextRun({ text: line, font: 'Courier New', size: 20 })], {
            indent: { left: 360 + listDepth * 240 },
            shading: { fill: 'F3F4F6', color: 'auto' },
            spacing: { after: 80 },
          });
        });
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        return;
      }
      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        for (const inner of quote.tokens) {
          if (inner.type === 'paragraph') {
            const paragraph = inner as Tokens.Paragraph;
            pushParagraph(inlineTokensToRuns(paragraph.tokens), {
              indent: { left: 480 + listDepth * 240 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 6, color: '9CA3AF' },
              },
            });
          } else {
            renderBlockTokenToDocx(inner, listDepth + 1);
          }
        }
        return;
      }
      case 'hr':
        children.push(new Paragraph({
          children: [new TextRun({ text: '────────────────────────', color: '9CA3AF' })],
          alignment: AlignmentType.LEFT,
          spacing: { before: 120, after: 120 },
        }));
        return;
      case 'list': {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const marker = list.ordered ? `${index + 1}. ` : '• ';
          const inline = extractListItemInlineTokens(item);
          const runs = [new TextRun({ text: marker, bold: true }), ...inlineTokensToRuns(inline)];
          pushParagraph(runs, {
            indent: { left: 240 + listDepth * 360, hanging: 240 },
          });

          for (const childToken of item.tokens) {
            if (childToken.type === 'list') {
              renderBlockTokenToDocx(childToken, listDepth + 1);
            } else if (childToken.type !== 'paragraph' && childToken.type !== 'text') {
              renderBlockTokenToDocx(childToken, listDepth + 1);
            }
          }
        });
        return;
      }
      case 'table': {
        const table = token as Tokens.Table;
        const headerRow = new TableRow({
          children: table.header.map((cell) => new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: inlineTokensToPlainText(cell.tokens), bold: true })],
            })],
          })),
        });
        const bodyRows = table.rows.map((row) => new TableRow({
          children: row.map((cell) => new TableCell({
            children: [new Paragraph(inlineTokensToPlainText(cell.tokens))],
          })),
        }));

        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [headerRow, ...bodyRows],
        }));
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        return;
      }
      case 'html': {
        const html = token as Tokens.HTML;
        const stripped = html.text.replace(/<[^>]+>/g, '').trim();
        if (stripped) {
          pushParagraph([new TextRun(stripped)]);
        }
        return;
      }
      default: {
        const fallback = token as Partial<Tokens.Text>;
        if (typeof fallback.text === 'string' && fallback.text.trim()) {
          pushParagraph([new TextRun(fallback.text)]);
        }
      }
    }
  };

  if (title) {
    children.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }));
  }

  for (const token of tokens) {
    renderBlockTokenToDocx(token, 0);
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  const assemblyMs = performance.now() - assembleStart;
  onWritingStart?.();
  const writeStart = performance.now();
  await fs.writeFile(filePath, buffer);
  const writeMs = performance.now() - writeStart;
  return { sizeBytes: buffer.byteLength, assemblyMs, writeMs };
}

async function createPdf(
  filePath: string,
  tokens: Token[],
  title?: string,
  onWritingStart?: () => void,
): Promise<{ sizeBytes: number; assemblyMs: number; writeMs: number }> {
  const pdfkitModule = await getPdfkit();
  const PDFDocument = pdfkitModule.default || pdfkitModule;

  return new Promise((resolve, reject) => {
    const assembleStart = performance.now();
    const doc = new PDFDocument({ margin: 72 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', async () => {
      try {
        onWritingStart?.();
        const writeStart = performance.now();
        const buffer = Buffer.concat(chunks);
        const assemblyMs = assembleStart > 0 ? writeStart - assembleStart : 0;
        await fs.writeFile(filePath, buffer);
        const writeMs = performance.now() - writeStart;
        resolve({ sizeBytes: buffer.byteLength, assemblyMs, writeMs });
      } catch (err) {
        reject(err);
      }
    });
    doc.on('error', reject);

    if (title) {
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text(title, { align: 'center' });
      doc.moveDown(1.5);
    }

    doc.font('Helvetica').fontSize(11).fillColor('#111827');
    renderMarkdownTokensToPdf(doc, tokens);

    doc.end();
  });
}

type InlineStyle = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
};

type InlineChunk = {
  text: string;
  style: InlineStyle;
};

function renderMarkdownTokensToPdf(doc: PDFKit.PDFDocument, tokens: Token[]): void {
  for (const token of tokens) {
    renderBlockToken(doc, token, 0);
  }
}

function renderBlockToken(doc: PDFKit.PDFDocument, token: Token, listDepth: number): void {
  switch (token.type) {
    case 'space':
      doc.moveDown(0.2);
      return;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const headingSizeByDepth: Record<number, number> = { 1: 24, 2: 19, 3: 16, 4: 14, 5: 13, 6: 12 };
      const size = headingSizeByDepth[Math.min(6, Math.max(1, heading.depth))] ?? 12;
      doc.moveDown(0.4);
      doc.fontSize(size);
      renderInline(doc, heading.tokens, { bold: true });
      doc.fontSize(11).fillColor('#111827');
      doc.moveDown(0.25);
      return;
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      doc.fontSize(11).fillColor('#111827');
      renderInline(doc, paragraph.tokens);
      doc.moveDown(0.45);
      return;
    }
    case 'text': {
      const textToken = token as Tokens.Text;
      if (textToken.tokens && textToken.tokens.length > 0) {
        renderInline(doc, textToken.tokens);
      } else if (textToken.text.trim()) {
        doc.font('Helvetica').fontSize(11).fillColor('#111827').text(textToken.text);
      }
      doc.moveDown(0.35);
      return;
    }
    case 'code': {
      const code = token as Tokens.Code;
      doc.moveDown(0.2);
      doc.font('Courier').fontSize(10).fillColor('#1f2937').text(code.text, {
        indent: listDepth * 18 + 8,
      });
      doc.font('Helvetica').fontSize(11).fillColor('#111827');
      doc.moveDown(0.45);
      return;
    }
    case 'blockquote': {
      const blockquote = token as Tokens.Blockquote;
      doc.moveDown(0.15);
      const left = doc.page.margins.left + listDepth * 18 + 4;
      const top = doc.y;
      const quoteIndent = listDepth * 18 + 14;
      for (const inner of blockquote.tokens) {
        if (inner.type === 'paragraph') {
          const paragraph = inner as Tokens.Paragraph;
          renderInline(doc, paragraph.tokens, {}, quoteIndent);
          doc.moveDown(0.25);
        } else {
          renderBlockToken(doc, inner, listDepth + 1);
        }
      }
      const bottom = doc.y;
      doc.save()
        .lineWidth(1.5)
        .strokeColor('#9ca3af')
        .moveTo(left, top)
        .lineTo(left, bottom)
        .stroke()
        .restore();
      doc.moveDown(0.2);
      return;
    }
    case 'hr': {
      doc.moveDown(0.35);
      const y = doc.y;
      doc.save()
        .lineWidth(1)
        .strokeColor('#d1d5db')
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .stroke()
        .restore();
      doc.moveDown(0.55);
      return;
    }
    case 'list': {
      const list = token as Tokens.List;
      list.items.forEach((item, index) => renderListItem(doc, item, list.ordered, index, listDepth));
      doc.moveDown(0.2);
      return;
    }
    case 'table': {
      const table = token as Tokens.Table;
      const header = table.header.map((cell) => inlineTokensToPlainText(cell.tokens)).join(' | ');
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111827').text(header);
      const separator = table.header.map(() => '---').join(' | ');
      doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text(separator);
      for (const row of table.rows) {
        const rowText = row.map((cell) => inlineTokensToPlainText(cell.tokens)).join(' | ');
        doc.font('Helvetica').fontSize(10.5).fillColor('#111827').text(rowText);
      }
      doc.font('Helvetica').fontSize(11).fillColor('#111827');
      doc.moveDown(0.5);
      return;
    }
    case 'html': {
      const html = token as Tokens.HTML;
      const stripped = html.text.replace(/<[^>]+>/g, '').trim();
      if (stripped) {
        doc.font('Helvetica').fontSize(11).fillColor('#111827').text(stripped);
        doc.moveDown(0.3);
      }
      return;
    }
    default: {
      const genericToken = token as Partial<Tokens.Text>;
      if (typeof genericToken.text === 'string' && genericToken.text.trim()) {
        doc.font('Helvetica').fontSize(11).fillColor('#111827').text(genericToken.text);
        doc.moveDown(0.3);
      }
    }
  }
}

function renderListItem(
  doc: PDFKit.PDFDocument,
  item: Tokens.ListItem,
  ordered: boolean,
  index: number,
  listDepth: number,
): void {
  const marker = ordered ? `${index + 1}. ` : '- ';
  const markerIndent = listDepth * 18;
  const inlineTarget = extractListItemInlineTokens(item);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(marker, {
    indent: markerIndent,
    continued: true,
  });

  if (inlineTarget.length > 0) {
    renderInline(doc, inlineTarget, {}, undefined, true);
  } else {
    doc.font('Helvetica').fontSize(11).fillColor('#111827').text(item.text, { continued: false });
  }

  for (const childToken of item.tokens) {
    if (childToken.type === 'list') {
      renderBlockToken(doc, childToken, listDepth + 1);
    } else if (childToken.type !== 'paragraph' && childToken.type !== 'text') {
      renderBlockToken(doc, childToken, listDepth + 1);
    }
  }

  doc.moveDown(0.2);
  doc.x = doc.page.margins.left;
}

function extractListItemInlineTokens(item: Tokens.ListItem): Token[] {
  const paragraphToken = item.tokens.find((token) => token.type === 'paragraph') as Tokens.Paragraph | undefined;
  if (paragraphToken?.tokens?.length) {
    return paragraphToken.tokens;
  }
  const textToken = item.tokens.find((token) => token.type === 'text') as Tokens.Text | undefined;
  if (textToken?.tokens?.length) {
    return textToken.tokens;
  }
  return [];
}

function renderInline(
  doc: PDFKit.PDFDocument,
  tokens: Token[],
  baseStyle: InlineStyle = {},
  indent?: number,
  continuedFromPrevious = false,
): void {
  const chunks = flattenInlineTokens(tokens, baseStyle).filter((chunk) => chunk.text.length > 0);
  if (chunks.length === 0) {
    if (!continuedFromPrevious) {
      doc.text('', { indent });
    } else {
      doc.text('', { continued: false });
    }
    return;
  }

  chunks.forEach((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const options: PDFKit.Mixins.TextOptions = {
      continued: !isLast,
    };
    if (!continuedFromPrevious && index === 0 && typeof indent === 'number') {
      options.indent = indent;
    }
    if (chunk.style.link) {
      options.link = chunk.style.link;
      options.underline = true;
    }

    doc
      .font(resolveFont(chunk.style))
      .fillColor(chunk.style.link ? '#1d4ed8' : '#111827')
      .text(chunk.text, options);
  });

  doc.fillColor('#111827').font('Helvetica');
}

function flattenInlineTokens(tokens: Token[], parentStyle: InlineStyle): InlineChunk[] {
  const chunks: InlineChunk[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          chunks.push(...flattenInlineTokens(textToken.tokens, parentStyle));
        } else {
          chunks.push({ text: textToken.text, style: { ...parentStyle } });
        }
        break;
      }
      case 'strong': {
        const strongToken = token as Tokens.Strong;
        chunks.push(...flattenInlineTokens(strongToken.tokens, { ...parentStyle, bold: true }));
        break;
      }
      case 'em': {
        const emToken = token as Tokens.Em;
        chunks.push(...flattenInlineTokens(emToken.tokens, { ...parentStyle, italic: true }));
        break;
      }
      case 'codespan': {
        const code = token as Tokens.Codespan;
        chunks.push({ text: code.text, style: { ...parentStyle, code: true } });
        break;
      }
      case 'link': {
        const link = token as Tokens.Link;
        chunks.push(...flattenInlineTokens(link.tokens, { ...parentStyle, link: link.href }));
        break;
      }
      case 'br':
        chunks.push({ text: '\n', style: { ...parentStyle } });
        break;
      case 'del': {
        const del = token as Tokens.Del;
        chunks.push(...flattenInlineTokens(del.tokens, parentStyle));
        break;
      }
      case 'escape': {
        const escaped = token as Tokens.Escape;
        chunks.push({ text: escaped.text, style: { ...parentStyle } });
        break;
      }
      default: {
        const fallback = token as Partial<Tokens.Text>;
        if (typeof fallback.text === 'string') {
          chunks.push({ text: fallback.text, style: { ...parentStyle } });
        }
      }
    }
  }

  return mergeAdjacentChunks(chunks);
}

function mergeAdjacentChunks(chunks: InlineChunk[]): InlineChunk[] {
  const merged: InlineChunk[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (previous && sameInlineStyle(previous.style, chunk.style)) {
      previous.text += chunk.text;
    } else {
      merged.push({ ...chunk, style: { ...chunk.style } });
    }
  }
  return merged;
}

function sameInlineStyle(a: InlineStyle, b: InlineStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link;
}

function resolveFont(style: InlineStyle): string {
  if (style.code) {
    if (style.bold && style.italic) return 'Courier-BoldOblique';
    if (style.bold) return 'Courier-Bold';
    if (style.italic) return 'Courier-Oblique';
    return 'Courier';
  }

  if (style.bold && style.italic) return 'Helvetica-BoldOblique';
  if (style.bold) return 'Helvetica-Bold';
  if (style.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function inlineTokensToPlainText(tokens: Token[]): string {
  return flattenInlineTokens(tokens, {}).map((chunk) => chunk.text).join('').trim();
}

async function createXlsx(
  filePath: string,
  content: string,
  structuredData?: unknown,
  onWritingStart?: () => void,
): Promise<{ sizeBytes: number; assemblyMs: number; writeMs: number }> {
  const XLSX = await getXlsx();
  const assembleStart = performance.now();

  const workbook = XLSX.utils.book_new();

  if (Array.isArray(structuredData) && structuredData.length > 0) {
    // Structured data: array of objects or array of arrays
    let sheet;
    if (Array.isArray(structuredData[0])) {
      sheet = XLSX.utils.aoa_to_sheet(structuredData as unknown[][]);
    } else {
      sheet = XLSX.utils.json_to_sheet(structuredData as Record<string, unknown>[]);
    }
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  } else {
    // CSV content — parse as CSV
    const sheet = XLSX.utils.aoa_to_sheet(
      content.split('\n').map((row) => row.split(','))
    );
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  }

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const assemblyMs = performance.now() - assembleStart;
  onWritingStart?.();
  const writeStart = performance.now();
  await fs.writeFile(filePath, buffer);
  const writeMs = performance.now() - writeStart;
  return { sizeBytes: buffer.byteLength, assemblyMs, writeMs };
}

async function createRawFile(
  filePath: string,
  content: string,
  onWritingStart?: () => void,
): Promise<{ sizeBytes: number; assemblyMs: number; writeMs: number }> {
  onWritingStart?.();
  const writeStart = performance.now();
  await fs.writeFile(filePath, content, 'utf-8');
  const writeMs = performance.now() - writeStart;
  return { sizeBytes: Buffer.byteLength(content, 'utf-8'), assemblyMs: 0, writeMs };
}

export async function createDocument(
  filename: string,
  format: string,
  content: string,
  options?: CreateDocumentOptions,
): Promise<CreationResult> {
  const startedAt = performance.now();
  const llmMetrics = options?.llmMetrics;
  const elapsedOffsetMs = llmMetrics?.generationMs ?? 0;
  const safeFilename = path.basename(filename);
  const emitProgress = (stage: ProgressStage, stageLabel: string, stageNumber: number, detail?: string): void => {
    if (!options?.onProgress || !options.conversationId || !options.messageId) return;
    options.onProgress({
      conversationId: options.conversationId,
      messageId: options.messageId,
      stage,
      stageLabel,
      stageNumber,
      totalStages: TOTAL_STAGES,
      elapsedMs: elapsedOffsetMs + (performance.now() - startedAt),
      detail,
      filename: safeFilename,
    });
  };

  const [_, filePath] = await Promise.all([ensureOutputDir(), dedupFilename(filename)]);
  let phase2ContentParsingMs = 0;
  let phase3DocumentAssemblyMs = 0;
  let phase4FileWriteMs = 0;
  let sizeBytes = 0;
  const approxPages = Math.max(1, Math.ceil(content.length / 3500));

  switch (format) {
    case 'docx':
      if (content.length > MAX_FORMATTED_DOCUMENT_CHARS) {
        throw new Error(`DOCX content too large (${content.length} chars). Max supported is ${MAX_FORMATTED_DOCUMENT_CHARS} chars. Split into multiple files or use markdown/plain text.`);
      }
      emitProgress('parsing', 'Structuring document...', 2);
      {
        const parseStart = performance.now();
        const { marked } = await getMarked();
        const tokens = marked.lexer(content, { gfm: true, breaks: true });
        phase2ContentParsingMs = performance.now() - parseStart;
        emitProgress('assembling', 'Building document...', 3, `Formatting ~${approxPages} page(s)...`);
        const docxResult = await createDocx(filePath, tokens, options?.title, () =>
          emitProgress('writing', 'Saving to disk...', 4)
        );
        phase3DocumentAssemblyMs = docxResult.assemblyMs;
        phase4FileWriteMs = docxResult.writeMs;
        sizeBytes = docxResult.sizeBytes;
      }
      break;
    case 'pdf':
      if (content.length > MAX_FORMATTED_DOCUMENT_CHARS) {
        throw new Error(`PDF content too large (${content.length} chars). Max supported is ${MAX_FORMATTED_DOCUMENT_CHARS} chars. Split into multiple files or use markdown/plain text.`);
      }
      emitProgress('parsing', 'Structuring document...', 2);
      {
        const parseStart = performance.now();
        const { marked } = await getMarked();
        const tokens = marked.lexer(content, { gfm: true, breaks: true });
        phase2ContentParsingMs = performance.now() - parseStart;
        emitProgress('assembling', 'Building document...', 3, `Formatting ~${approxPages} page(s)...`);
        const pdfResult = await createPdf(filePath, tokens, options?.title, () =>
          emitProgress('writing', 'Saving to disk...', 4)
        );
        phase3DocumentAssemblyMs = pdfResult.assemblyMs;
        phase4FileWriteMs = pdfResult.writeMs;
        sizeBytes = pdfResult.sizeBytes;
      }
      break;
    case 'xlsx':
      emitProgress('parsing', 'Structuring document...', 2);
      phase2ContentParsingMs = 0;
      emitProgress('assembling', 'Building document...', 3, 'Preparing workbook...');
      {
        const xlsxResult = await createXlsx(filePath, content, options?.structuredData, () =>
          emitProgress('writing', 'Saving to disk...', 4)
        );
        phase3DocumentAssemblyMs = xlsxResult.assemblyMs;
        phase4FileWriteMs = xlsxResult.writeMs;
        sizeBytes = xlsxResult.sizeBytes;
      }
      break;
    case 'txt':
    case 'md':
    case 'csv':
    case 'html':
    case 'json':
    default:
      emitProgress('parsing', 'Structuring document...', 2);
      phase2ContentParsingMs = 0;
      emitProgress('assembling', 'Building document...', 3);
      {
        const rawResult = await createRawFile(filePath, content, () =>
          emitProgress('writing', 'Saving to disk...', 4)
        );
        phase3DocumentAssemblyMs = rawResult.assemblyMs;
        phase4FileWriteMs = rawResult.writeMs;
        sizeBytes = rawResult.sizeBytes;
      }
      break;
  }

  const phase1LlmGenerationMs = llmMetrics?.generationMs ?? 0;
  const phase5RendererNotificationMs = 0;
  const totalMs = phase1LlmGenerationMs + phase2ContentParsingMs + phase3DocumentAssemblyMs + phase4FileWriteMs + phase5RendererNotificationMs;
  const timing: DocumentTimingSummary = {
    totalMs,
    phase1LlmGenerationMs,
    phase2ContentParsingMs,
    phase3DocumentAssemblyMs,
    phase4FileWriteMs,
    phase5RendererNotificationMs,
    llmIterations: llmMetrics?.iterations ?? 0,
    llmTokensIn: llmMetrics?.tokensIn ?? 0,
    llmTokensOut: llmMetrics?.tokensOut ?? 0,
  };

  return {
    filePath,
    filename: path.basename(filePath),
    sizeBytes,
    format,
    timing,
  };
}
