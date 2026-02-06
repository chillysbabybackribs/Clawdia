import * as path from 'path';

const MAX_TEXT_LENGTH = 100_000;

export interface ExtractionResult {
  text: string;
  pageCount?: number;
  sheetNames?: string[];
  truncated: boolean;
}

function getExtension(filename: string): string {
  return path.extname(filename).toLowerCase().replace('.', '');
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_LENGTH) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_TEXT_LENGTH) + '\n\n[Document truncated — showing first 100,000 characters]',
    truncated: true,
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse(new Uint8Array(buffer));
  const result = await parser.getText();
  const { text, truncated } = truncate(result.text);
  return { text, pageCount: result.total, truncated };
}

async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const { text, truncated } = truncate(result.value);
  return { text, truncated };
}

async function extractXlsx(buffer: Buffer): Promise<ExtractionResult> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames = workbook.SheetNames;

  const parts: string[] = [];
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`--- Sheet: ${name} ---\n${csv}`);
  }

  const raw = parts.join('\n\n');
  const { text, truncated } = truncate(raw);
  return { text, sheetNames, truncated };
}

function extractPlainText(buffer: Buffer): ExtractionResult {
  const raw = buffer.toString('utf-8');
  const { text, truncated } = truncate(raw);
  return { text, truncated };
}

export async function extractDocument(
  buffer: Buffer,
  filename: string,
  _mimeType: string,
): Promise<ExtractionResult> {
  const ext = getExtension(filename);

  switch (ext) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'xlsx':
    case 'xls':
      return extractXlsx(buffer);
    default:
      // Everything else — treat as plain text (code files, .txt, .md, .csv, .json, .html, etc.)
      return extractPlainText(buffer);
  }
}
