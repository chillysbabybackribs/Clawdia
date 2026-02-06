import type { ImageAttachment } from '../../shared/types';
import {
  appState,
  DOCUMENT_EXTENSIONS,
  elements,
  MAX_ATTACHMENTS,
  MAX_DOCUMENT_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_SIZE,
  VALID_IMAGE_TYPES,
} from './state';
import { formatFileSize, getDocIcon, getFileExtension } from './documents';

export function initAttachments(): void {
  setupImageEventListeners();
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = URL.createObjectURL(file);
  });
}

function resizeImageIfNeeded(file: File, width: number, height: number): Promise<{ base64: string; width: number; height: number }> {
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    return fileToBase64(file).then((base64) => ({ base64, width, height }));
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(MAX_IMAGE_DIMENSION / img.naturalWidth, MAX_IMAGE_DIMENSION / img.naturalHeight);
      const newW = Math.round(img.naturalWidth * scale);
      const newH = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        void fileToBase64(file).then((base64) => resolve({ base64, width, height }));
        return;
      }
      ctx.drawImage(img, 0, 0, newW, newH);
      const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mediaType, 0.92);
      resolve({ base64: dataUrl.split(',')[1], width: newW, height: newH });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      void fileToBase64(file).then((base64) => resolve({ base64, width, height }));
    };
    img.src = URL.createObjectURL(file);
  });
}

async function handleImageAttachment(file: File): Promise<void> {
  if (file.size > MAX_IMAGE_SIZE) {
    showAttachmentError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.`);
    return;
  }
  if (!VALID_IMAGE_TYPES.includes(file.type)) {
    showAttachmentError('Unsupported format. Use PNG, JPEG, GIF, or WebP.');
    return;
  }
  if (appState.pendingAttachments.length + appState.pendingDocuments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    return;
  }

  const dimensions = await getImageDimensions(file);
  const resized = await resizeImageIfNeeded(file, dimensions.width, dimensions.height);
  const thumbnailUrl = URL.createObjectURL(file);

  appState.pendingAttachments.push({
    id: crypto.randomUUID(),
    base64: resized.base64,
    mediaType: file.type as (typeof appState.pendingAttachments)[number]['mediaType'],
    thumbnailUrl,
    width: resized.width,
    height: resized.height,
    sizeBytes: file.size,
  });
  renderAttachmentBar();
}

export function removePendingAttachment(id: string): void {
  const idx = appState.pendingAttachments.findIndex((a) => a.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(appState.pendingAttachments[idx].thumbnailUrl);
    appState.pendingAttachments.splice(idx, 1);
    renderAttachmentBar();
  }
}

export function clearPendingAttachments(): void {
  for (const a of appState.pendingAttachments) {
    URL.revokeObjectURL(a.thumbnailUrl);
  }
  appState.pendingAttachments = [];
  appState.pendingDocuments = [];
  renderAttachmentBar();
}

export function renderAttachmentBar(): void {
  elements.attachmentBar.innerHTML = '';
  const total = appState.pendingAttachments.length + appState.pendingDocuments.length;
  if (total === 0) {
    elements.attachmentBar.classList.remove('has-attachments');
    return;
  }
  elements.attachmentBar.classList.add('has-attachments');

  for (const attachment of appState.pendingAttachments) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';

    const img = document.createElement('img');
    img.src = attachment.thumbnailUrl;
    img.alt = 'Attached image';
    thumb.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removePendingAttachment(attachment.id));
    thumb.appendChild(removeBtn);

    elements.attachmentBar.appendChild(thumb);
  }

  for (const doc of appState.pendingDocuments) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-doc';

    const icon = document.createElement('span');
    icon.className = 'attachment-doc-icon';
    icon.textContent = getDocIcon(doc.filename);
    thumb.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'attachment-doc-info';

    const name = document.createElement('div');
    name.className = 'attachment-doc-name';
    name.textContent = truncateFilename(doc.filename);
    name.title = doc.filename;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'attachment-doc-meta';
    if (doc.extractionStatus === 'extracting') {
      meta.textContent = 'Extracting...';
    } else if (doc.extractionStatus === 'error') {
      meta.textContent = doc.errorMessage || 'Error';
      meta.style.color = 'var(--error)';
    } else {
      meta.textContent = formatFileSize(doc.sizeBytes);
    }
    info.appendChild(meta);

    thumb.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removePendingDocument(doc.id));
    thumb.appendChild(removeBtn);

    elements.attachmentBar.appendChild(thumb);
  }
}

export function showAttachmentError(msg: string): void {
  const el = document.createElement('div');
  el.style.cssText = 'color: var(--error); font-size: 12px; padding: 4px 12px;';
  el.textContent = msg;
  elements.attachmentBar.classList.add('has-attachments');
  elements.attachmentBar.appendChild(el);
  setTimeout(() => {
    if (el.parentNode === elements.attachmentBar) el.remove();
    if (appState.pendingAttachments.length === 0 && appState.pendingDocuments.length === 0) {
      elements.attachmentBar.classList.remove('has-attachments');
    }
  }, 3000);
}

function hasAttachableFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const item of dt.items) {
    if (item.kind === 'file') return true;
  }
  return false;
}

export function isDocumentFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  if (!ext && !file.type.startsWith('image/')) return true;
  return false;
}

function truncateFilename(name: string, max: number = 20): string {
  if (name.length <= max) return name;
  const ext = getFileExtension(name);
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const keep = max - ext.length - 4;
  if (keep < 3) return name.slice(0, max - 3) + '...';
  return base.slice(0, keep) + '...' + (ext ? '.' + ext : '');
}

async function handleDocumentAttachment(file: File): Promise<void> {
  if (file.size > MAX_DOCUMENT_SIZE) {
    showAttachmentError(`File too large (${formatFileSize(file.size)}). Max 50MB.`);
    return;
  }
  const totalCount = appState.pendingAttachments.length + appState.pendingDocuments.length;
  if (totalCount >= MAX_ATTACHMENTS) {
    showAttachmentError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    return;
  }

  const docId = crypto.randomUUID();
  appState.pendingDocuments.push({
    id: docId,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    extractionStatus: 'extracting',
  });
  renderAttachmentBar();

  try {
    const arrayBuf = await file.arrayBuffer();
    const buffer = Array.from(new Uint8Array(arrayBuf));
    const result = await window.api.extractDocument({
      buffer,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
    });

    const found = appState.pendingDocuments.find((d) => d.id === docId);
    if (!found) return;

    if (result.success) {
      found.extractionStatus = 'done';
      found.extractedText = result.text;
      found.pageCount = result.pageCount;
      found.sheetNames = result.sheetNames;
      found.truncated = result.truncated;
    } else {
      found.extractionStatus = 'error';
      found.errorMessage = result.error || 'Extraction failed';
    }
  } catch (err: unknown) {
    const found = appState.pendingDocuments.find((d) => d.id === docId);
    if (found) {
      found.extractionStatus = 'error';
      found.errorMessage = err instanceof Error ? err.message : 'Extraction failed';
    }
  }

  renderAttachmentBar();
}

export function removePendingDocument(id: string): void {
  const idx = appState.pendingDocuments.findIndex((d) => d.id === id);
  if (idx >= 0) {
    appState.pendingDocuments.splice(idx, 1);
    renderAttachmentBar();
  }
}

export function renderMessageImages(images: ImageAttachment[], container: HTMLElement): void {
  const imagesDiv = document.createElement('div');
  imagesDiv.className = 'message-images' + (images.length === 1 ? ' single' : '');

  for (const img of images) {
    const imgEl = document.createElement('img');
    imgEl.className = 'message-image';
    imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
    imgEl.alt = 'Attached image';
    imgEl.addEventListener('click', () => openImageLightbox(imgEl.src));
    imagesDiv.appendChild(imgEl);
  }

  container.appendChild(imagesDiv);
}

function openImageLightbox(src: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);

  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', handler);
    }
  });

  document.body.appendChild(overlay);
}

function routeFileAttachment(file: File): void {
  if (VALID_IMAGE_TYPES.includes(file.type)) {
    void handleImageAttachment(file);
  } else if (isDocumentFile(file)) {
    void handleDocumentAttachment(file);
  }
}

function setupImageEventListeners(): void {
  const promptWrapper = elements.promptEl.closest('.prompt-wrapper') || elements.promptEl.parentElement;
  if (!promptWrapper) {
    return;
  }

  promptWrapper.addEventListener('paste', (e: Event) => {
    const clipboardEvent = e as ClipboardEvent;
    const items = clipboardEvent.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.kind === 'file') {
        clipboardEvent.preventDefault();
        const file = item.getAsFile();
        if (file) routeFileAttachment(file);
        return;
      }
    }
  });

  let dragCounter = 0;
  elements.chatArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (hasAttachableFiles((e as DragEvent).dataTransfer)) {
      elements.chatArea.classList.add('drag-over');
    }
  });

  elements.chatArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      elements.chatArea.classList.remove('drag-over');
    }
  });

  elements.chatArea.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  elements.chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    elements.chatArea.classList.remove('drag-over');
    const files = (e as DragEvent).dataTransfer?.files;
    if (files) {
      for (const file of files) {
        routeFileAttachment(file);
      }
    }
  });

  elements.attachBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.multiple = true;
    input.onchange = () => {
      if (input.files) {
        for (const file of input.files) {
          routeFileAttachment(file);
        }
      }
    };
    input.click();
  });
}
