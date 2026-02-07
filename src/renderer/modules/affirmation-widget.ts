/**
 * Affirmation Widget Module
 * Makes the browser-hidden-quote element draggable and resizable
 */

export function initAffirmationWidget(): void {
  const quoteElement = document.getElementById('browser-hidden-quote');
  if (!quoteElement) return;

  let isMoving = false;
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let offsetX = 0;
  let offsetY = 0;

  // Create and append resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';
  quoteElement.appendChild(resizeHandle);

  // Enable absolute positioning when first interacted with
  const enableResizable = (): void => {
    if (!quoteElement.classList.contains('resizable')) {
      quoteElement.classList.add('resizable');
      const rect = quoteElement.getBoundingClientRect();
      quoteElement.style.position = 'absolute';
      quoteElement.style.left = rect.left + 'px';
      quoteElement.style.top = rect.top + 'px';
      quoteElement.style.width = rect.width + 'px';
      quoteElement.style.height = 'auto';
      quoteElement.style.minHeight = rect.height + 'px';
    }
  };

  // Dragging functionality
  quoteElement.addEventListener('mousedown', (e: MouseEvent) => {
    // Only drag if not clicking the resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) {
      return;
    }

    enableResizable();
    isMoving = true;
    quoteElement.classList.add('draggable-active');

    const rect = quoteElement.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    startX = e.clientX;
    startY = e.clientY;

    e.preventDefault();
  });

  // Resizing functionality
  resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
    enableResizable();
    isResizing = true;
    quoteElement.classList.add('draggable-active');

    startWidth = quoteElement.offsetWidth;
    startHeight = quoteElement.offsetHeight;
    startX = e.clientX;
    startY = e.clientY;

    e.stopPropagation();
    e.preventDefault();
  });

  // Mouse move handler
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (isMoving) {
      const newLeft = e.clientX - offsetX;
      const newTop = e.clientY - offsetY;

      quoteElement.style.left = newLeft + 'px';
      quoteElement.style.top = newTop + 'px';
    }

    if (isResizing) {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      const newWidth = Math.max(100, startWidth + deltaX);
      const newHeight = Math.max(40, startHeight + deltaY);

      quoteElement.style.width = newWidth + 'px';
      quoteElement.style.minHeight = newHeight + 'px';
      quoteElement.style.height = 'auto';
    }
  });

  // Mouse up handler
  document.addEventListener('mouseup', () => {
    if (isMoving || isResizing) {
      isMoving = false;
      isResizing = false;
      quoteElement.classList.remove('draggable-active');
    }
  });

  // Optional: Add keyboard shortcut to reset position
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Press 'R' to reset position (when quote is visible)
    if (e.key === 'r' && !isMoving && !isResizing && quoteElement.classList.contains('resizable')) {
      // Optionally reset - comment out if not desired
      // quoteElement.classList.remove('resizable', 'draggable-active');
      // quoteElement.style.position = '';
      // quoteElement.style.left = '';
      // quoteElement.style.top = '';
      // quoteElement.style.width = '';
      // quoteElement.style.minHeight = '';
    }
  });
}
