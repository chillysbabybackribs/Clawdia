import type { DocumentMeta } from '../../shared/types';
import { elements } from './state';
import { scrollToBottom } from './stream';

export function initDocuments(): void {
  window.api.onDocumentCreated((data) => {
    renderDownloadCard(data);
    scrollToBottom();
  });
}

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getDocIcon(filename: string): string {
  const ext = getFileExtension(filename);
  switch (ext) {
    case 'pdf':
      return '📄';
    case 'docx':
    case 'doc':
      return '🗒️';
    case 'xlsx':
    case 'xls':
    case 'csv':
      return '📊';
    case 'json':
    case 'xml':
    case 'yaml':
    case 'yml':
    case 'toml':
      return '📋';
    case 'html':
    case 'htm':
    case 'css':
    case 'scss':
      return '🌐';
    case 'md':
    case 'txt':
    case 'log':
      return '📝';
    default:
      return '📁';
  }
}

export function renderMessageDocuments(documents: DocumentMeta[], container: HTMLElement): void {
  const docsDiv = document.createElement('div');
  docsDiv.className = 'message-documents';

  for (const doc of documents) {
    const card = document.createElement('div');
    card.className = 'document-card';

    const icon = document.createElement('span');
    icon.className = 'document-card-icon';
    icon.textContent = getDocIcon(doc.filename);
    card.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'document-card-info';

    const name = document.createElement('div');
    name.className = 'document-card-name';
    name.textContent = doc.originalName;
    name.title = doc.originalName;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'document-card-meta';
    const parts = [formatFileSize(doc.sizeBytes)];
    if (doc.pageCount) parts.push(`${doc.pageCount} pages`);
    if (doc.sheetNames?.length) parts.push(`${doc.sheetNames.length} sheets`);
    if (doc.truncated) parts.push('truncated');
    meta.textContent = parts.join(' · ');
    info.appendChild(meta);

    card.appendChild(info);
    docsDiv.appendChild(card);
  }

  container.appendChild(docsDiv);
}

export function renderDownloadCard(data: {
  filePath: string;
  filename: string;
  sizeBytes: number;
  format: string;
}): void {
  const card = document.createElement('div');
  card.className = 'download-card';

  const icon = document.createElement('span');
  icon.className = 'download-card-icon';
  icon.textContent = getDocIcon(data.filename);
  card.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'download-card-info';

  const name = document.createElement('div');
  name.className = 'download-card-name';
  name.textContent = data.filename;
  name.title = data.filePath;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'download-card-meta';
  meta.textContent = `${formatFileSize(data.sizeBytes)} · ${data.format.toUpperCase()}`;
  info.appendChild(meta);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'download-card-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'download-card-btn';
  saveBtn.textContent = 'Save As';
  saveBtn.addEventListener('click', () => {
    void window.api.saveDocument(data.filePath, data.filename);
  });
  actions.appendChild(saveBtn);

  const folderBtn = document.createElement('button');
  folderBtn.className = 'download-card-btn';
  folderBtn.textContent = 'Open Folder';
  folderBtn.addEventListener('click', () => {
    void window.api.openDocumentFolder(data.filePath);
  });
  actions.appendChild(folderBtn);

  card.appendChild(actions);
  elements.outputEl.appendChild(card);
}
