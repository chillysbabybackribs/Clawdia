// ============================================================================
// THOUGHT GENERATOR
// ============================================================================
//
// Translates raw tool calls into human-readable thoughts.
// The renderer never sees tool names, parameters, or raw results.

export function generateThought(toolName: string, input: any): string {
  switch (toolName) {
    case 'browser_search':
      return `Searching for ${truncate(String(input?.query || ''), 50)}`;

    case 'browser_news':
      return `Looking for recent news about ${truncate(String(input?.query || ''), 50)}`;

    case 'browser_shopping':
      return `Finding prices for ${truncate(String(input?.query || ''), 50)}`;

    case 'browser_places':
      return `Looking up ${truncate(String(input?.query || ''), 50)}`;

    case 'browser_images':
      return `Finding images of ${truncate(String(input?.query || ''), 50)}`;

    case 'browser_navigate': {
      const domain = extractDomain(String(input?.url || ''));
      return `Reading ${domain}`;
    }

    case 'browser_read_page':
      return 'Reading the page content';

    case 'browser_click':
      return `Clicking ${truncate(String(input?.ref || ''), 40)}`;

    case 'browser_type':
      return 'Typing into the page';

    case 'browser_tab':
      switch (input?.action) {
        case 'new':
          return input?.url ? `Opening ${extractDomain(String(input.url))}` : 'Opening a new tab';
        case 'switch':
          return 'Switching tabs';
        case 'close':
          return 'Closing tab';
        case 'list':
          return 'Checking open tabs';
        default:
          return 'Managing tabs';
      }

    case 'browser_screenshot':
      return 'Capturing the page';

    case 'shell_exec': {
      const command = String(input?.command || '');
      if (command.startsWith('apt') || command.startsWith('sudo apt')) return 'Installing packages';
      if (command.startsWith('npm install') || command.startsWith('yarn add') || command.startsWith('pnpm add')) {
        return 'Installing dependencies';
      }
      if (command.startsWith('pip install')) return 'Installing Python packages';
      if (command.startsWith('git clone')) return 'Cloning repository';
      if (command.startsWith('git ')) return 'Running git operation';
      if (command.startsWith('docker')) return 'Managing Docker';
      if (command.startsWith('find ') || command.startsWith('grep ') || command.startsWith('rg ')) {
        return 'Searching files';
      }
      if (command.startsWith('mkdir')) return 'Creating directories';
      if (command.startsWith('mv ')) return 'Moving files';
      if (command.startsWith('cp ')) return 'Copying files';
      if (command.startsWith('rm ')) return 'Deleting files';
      if (command.startsWith('chmod') || command.startsWith('chown')) return 'Changing permissions';
      if (command.startsWith('cat ') || command.startsWith('head ') || command.startsWith('tail ')) {
        return 'Reading file contents';
      }
      if (command.includes('|')) return 'Running command pipeline';
      return 'Running command';
    }

    case 'file_read':
      return `Reading ${extractFilename(String(input?.path || 'file'))}`;

    case 'file_write':
      return `Writing ${extractFilename(String(input?.path || 'file'))}`;

    case 'file_edit':
      return `Editing ${extractFilename(String(input?.path || 'file'))}`;

    case 'directory_tree':
      return `Scanning ${String(input?.path || 'home')} directory`;

    case 'process_manager':
      switch (input?.action) {
        case 'list':
          return 'Checking running processes';
        case 'find':
          return `Finding ${truncate(String(input?.query || ''), 40)} process`;
        case 'kill':
          return `Stopping process ${truncate(String(input?.query || ''), 20)}`;
        case 'info':
          return `Inspecting process ${truncate(String(input?.query || ''), 20)}`;
        default:
          return 'Managing processes';
      }

    case 'sequential_thinking': {
      const step = Number(input?.thoughtNumber || 1);
      const total = Number(input?.totalThoughts || 1);
      if (step === 1) return 'Planning approach';
      if (input?.isRevision) return `Reconsidering step ${input?.revisesThought || step}`;
      if (input?.branchId) return `Exploring alternative: ${truncate(String(input.branchId), 30)}`;
      if (!input?.nextThoughtNeeded) return 'Finalizing plan';
      return `Reasoning (step ${step}/${total})`;
    }

    default:
      return 'Thinking';
  }
}

export function generateSynthesisThought(toolCallCount: number): string {
  if (toolCallCount === 0) return 'Thinking';
  if (toolCallCount === 1) return 'Putting together a response';
  if (toolCallCount <= 3) return 'Reviewing what I found';
  return 'Synthesizing from multiple sources';
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url?.slice(0, 40) || 'a page';
  }
}

function extractFilename(filepath: string): string {
  if (!filepath) return 'file';
  const parts = filepath.split('/');
  return parts[parts.length - 1] || filepath;
}
