import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

const OUTPUT_DIR = path.join(homedir(), 'Documents', 'Clawdia');

export interface CreationResult {
  filePath: string;
  filename: string;
  sizeBytes: number;
  format: string;
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

async function createDocx(filePath: string, content: string, title?: string): Promise<void> {
  const docxLib = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxLib;

  const paragraphs: InstanceType<typeof Paragraph>[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Detect markdown-style headings
    const h1Match = line.match(/^# (.+)/);
    const h2Match = line.match(/^## (.+)/);
    const h3Match = line.match(/^### (.+)/);
    const bulletMatch = line.match(/^[-*] (.+)/);

    if (h1Match) {
      paragraphs.push(new Paragraph({ text: h1Match[1], heading: HeadingLevel.HEADING_1 }));
    } else if (h2Match) {
      paragraphs.push(new Paragraph({ text: h2Match[1], heading: HeadingLevel.HEADING_2 }));
    } else if (h3Match) {
      paragraphs.push(new Paragraph({ text: h3Match[1], heading: HeadingLevel.HEADING_3 }));
    } else if (bulletMatch) {
      paragraphs.push(new Paragraph({
        children: [new TextRun(bulletMatch[1])],
        bullet: { level: 0 },
      }));
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ text: '' }));
    } else {
      // Handle **bold** and *italic* inline
      const runs: InstanceType<typeof TextRun>[] = [];
      const remaining = line;
      const inlineRegex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
      let match: RegExpExecArray | null;
      let lastIndex = 0;

      while ((match = inlineRegex.exec(remaining)) !== null) {
        if (match.index > lastIndex) {
          runs.push(new TextRun(remaining.slice(lastIndex, match.index)));
        }
        if (match[2]) {
          runs.push(new TextRun({ text: match[2], bold: true }));
        } else if (match[3]) {
          runs.push(new TextRun({ text: match[3], italics: true }));
        }
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < remaining.length) {
        runs.push(new TextRun(remaining.slice(lastIndex)));
      }

      paragraphs.push(new Paragraph({ children: runs.length > 0 ? runs : [new TextRun(line)] }));
    }
  }

  if (title) {
    paragraphs.unshift(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }

  const doc = new Document({
    sections: [{ children: paragraphs }],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(filePath, buffer);
}

async function createPdf(filePath: string, content: string, title?: string): Promise<void> {
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', async () => {
      try {
        await fs.writeFile(filePath, Buffer.concat(chunks));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    doc.on('error', reject);

    if (title) {
      doc.fontSize(20).text(title, { align: 'center' });
      doc.moveDown(1.5);
    }

    doc.fontSize(11);

    const lines = content.split('\n');
    for (const line of lines) {
      const h1Match = line.match(/^# (.+)/);
      const h2Match = line.match(/^## (.+)/);
      const h3Match = line.match(/^### (.+)/);

      if (h1Match) {
        doc.moveDown(0.5).fontSize(18).text(h1Match[1]).fontSize(11).moveDown(0.3);
      } else if (h2Match) {
        doc.moveDown(0.5).fontSize(15).text(h2Match[1]).fontSize(11).moveDown(0.3);
      } else if (h3Match) {
        doc.moveDown(0.3).fontSize(13).text(h3Match[1]).fontSize(11).moveDown(0.2);
      } else if (line.trim() === '') {
        doc.moveDown(0.5);
      } else {
        doc.text(line);
      }
    }

    doc.end();
  });
}

async function createXlsx(filePath: string, content: string, structuredData?: unknown): Promise<void> {
  const XLSX = await import('xlsx');

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
  await fs.writeFile(filePath, buffer);
}

async function createRawFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function createDocument(
  filename: string,
  format: string,
  content: string,
  options?: { structuredData?: unknown; title?: string },
): Promise<CreationResult> {
  await ensureOutputDir();
  const filePath = await dedupFilename(filename);

  switch (format) {
    case 'docx':
      await createDocx(filePath, content, options?.title);
      break;
    case 'pdf':
      await createPdf(filePath, content, options?.title);
      break;
    case 'xlsx':
      await createXlsx(filePath, content, options?.structuredData);
      break;
    case 'txt':
    case 'md':
    case 'csv':
    case 'html':
    case 'json':
    default:
      await createRawFile(filePath, content);
      break;
  }

  const stat = await fs.stat(filePath);
  return {
    filePath,
    filename: path.basename(filePath),
    sizeBytes: stat.size,
    format,
  };
}
