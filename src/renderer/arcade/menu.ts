// ============================================================================
// Arcade — Menu + lifecycle manager
// ============================================================================

import type { ArcadeGame, GameEntry } from './types';
import { ensureRetroFont, getRetroFont } from './font';
import { TetrisGame, COLS as TETRIS_COLS, ROWS as TETRIS_ROWS, calculateBlockSize } from './tetris';
import { PacManGame } from './pacman';
import { AsteroidsGame } from './asteroids';

const PACMAN_MAZE_COLS = 21;
const PACMAN_MAZE_ROWS = 21;

const GAMES: GameEntry[] = [
  {
    id: 'tetris',
    displayName: 'T E T R I S',
    color: '#ffffff',
    create: (canvas, blockSize, onEscape) => new TetrisGame(canvas, blockSize, onEscape),
  },
  {
    id: 'pacman',
    displayName: 'P A C - M A N',
    color: '#ffffff',
    create: (canvas, blockSize, onEscape) => new PacManGame(canvas, blockSize, onEscape),
  },
  {
    id: 'asteroids',
    displayName: 'A S T E R O I D S',
    color: '#ffffff',
    create: (canvas, blockSize, onEscape) => new AsteroidsGame(canvas, blockSize, onEscape),
  },
];

type ArcadeState = 'menu' | 'playing';

class ArcadeManager {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLDivElement;
  private state: ArcadeState = 'menu';
  private selectedIndex = 0;
  private currentGame: ArcadeGame | null = null;
  private animFrameId = 0;
  private keyCleanup: (() => void) | null = null;
  private focusCleanup: (() => void) | null = null;
  private containerWidth: number;
  private containerHeight: number;
  private blockSize: number;
  private hoverIndex = -1;

  constructor(canvas: HTMLCanvasElement, container: HTMLDivElement, containerWidth: number, containerHeight: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.container = container;
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;
    this.blockSize = calculateBlockSize(containerWidth, containerHeight);
  }

  start(): void {
    this.showMenu();
  }

  stop(): void {
    if (this.currentGame) {
      this.currentGame.stop();
      this.currentGame = null;
    }
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.removeKeyboard();
    this.removeFocusListeners();
  }

  // === Menu ===

  private showMenu(): void {
    this.state = 'menu';
    if (this.currentGame) {
      this.currentGame.stop();
      this.currentGame = null;
    }
    this.removeKeyboard();
    this.removeFocusListeners();

    // Size canvas for menu
    const w = Math.floor(this.containerWidth * 0.85);
    const h = Math.floor(this.containerHeight * 0.85);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.cursor = 'pointer';

    this.keyCleanup = this.setupMenuKeyboard();
    this.setupMenuMouse();
    this.startMenuLoop();
  }

  private startMenuLoop(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    const loop = (): void => {
      this.animFrameId = requestAnimationFrame(loop);
      this.drawMenu();
    };
    loop();
  }

  private drawMenu(): void {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const now = performance.now();

    ctx.clearRect(0, 0, w, h);
    // No backdrop — fully transparent

    // Title
    const titleSize = Math.max(9, Math.floor(w / 32));
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.font = getRetroFont(titleSize);
    ctx.fillText('C L A W D I A', w / 2, h * 0.34);

    const subtitleSize = Math.max(6, Math.floor(titleSize * 0.55));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.font = getRetroFont(subtitleSize);
    ctx.fillText('A R C A D E', w / 2, h * 0.34 + titleSize * 1.7);

    // Game entries — clustered near center
    const entryFontSize = Math.max(8, Math.floor(w / 42));
    const entryH = entryFontSize * 2.8;
    const startY = h * 0.48;

    for (let i = 0; i < GAMES.length; i++) {
      const entry = GAMES[i];
      const y = startY + i * entryH;
      const selected = i === this.selectedIndex;

      if (selected) {
        // Subtle arrow
        const arrowX = w / 2 - entryFontSize * 7 + Math.sin(now * 0.004) * 3;
        ctx.fillStyle = this.hexWithAlpha(entry.color, 0.45);
        ctx.font = getRetroFont(entryFontSize * 0.7);
        ctx.textAlign = 'left';
        ctx.fillText('\u25B6', arrowX, y + entryFontSize * 0.35);
      }

      // Game name
      ctx.textAlign = 'center';
      ctx.fillStyle = selected
        ? this.hexWithAlpha(entry.color, 0.5)
        : 'rgba(255, 255, 255, 0.18)';
      ctx.font = getRetroFont(entryFontSize);
      ctx.fillText(entry.displayName, w / 2, y + entryFontSize * 0.35);
    }

    // Controls hint
    const hintSize = Math.max(5, Math.floor(w / 70));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.font = getRetroFont(hintSize);
    ctx.textAlign = 'center';
    ctx.fillText('\u2191 \u2193  SELECT       ENTER  PLAY', w / 2, h * 0.48 + GAMES.length * entryH + entryH * 0.8);

    ctx.textAlign = 'left';
  }

  /** Convert a hex color to rgba with given alpha */
  private hexWithAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private setupMenuKeyboard(): () => void {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;

      switch (e.key) {
        case 'ArrowUp':
          this.selectedIndex = (this.selectedIndex - 1 + GAMES.length) % GAMES.length;
          e.preventDefault();
          break;
        case 'ArrowDown':
          this.selectedIndex = (this.selectedIndex + 1) % GAMES.length;
          e.preventDefault();
          break;
        case 'Enter':
        case ' ':
          this.launchGame(this.selectedIndex);
          e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  private setupMenuMouse(): void {
    const canvas = this.canvas;

    const getEntryAtY = (clientY: number): number => {
      const rect = canvas.getBoundingClientRect();
      const y = clientY - rect.top;
      const h = canvas.height;
      const w = canvas.width;
      const entryFontSize = Math.max(8, Math.floor(w / 42));
      const entryH = entryFontSize * 2.8;
      const startY = h * 0.48;

      for (let i = 0; i < GAMES.length; i++) {
        const ey = startY + i * entryH;
        if (y >= ey - entryH * 0.45 && y <= ey + entryH * 0.55) {
          return i;
        }
      }
      return -1;
    };

    const onMove = (e: MouseEvent) => {
      if (this.state !== 'menu') return;
      const idx = getEntryAtY(e.clientY);
      if (idx >= 0) {
        this.selectedIndex = idx;
        this.hoverIndex = idx;
        canvas.style.cursor = 'pointer';
      } else {
        this.hoverIndex = -1;
        canvas.style.cursor = 'default';
      }
    };

    const onClick = (e: MouseEvent) => {
      if (this.state !== 'menu') return;
      const idx = getEntryAtY(e.clientY);
      if (idx >= 0) {
        this.launchGame(idx);
      }
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);

    // Store for cleanup
    const origRemoveKb = this.keyCleanup;
    this.keyCleanup = () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
      if (origRemoveKb) origRemoveKb();
    };
  }

  // === Game launch ===

  private launchGame(index: number): void {
    const entry = GAMES[index];
    if (!entry) return;

    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = 0; }
    this.removeKeyboard();
    this.state = 'playing';
    this.canvas.style.cursor = 'default';

    const bs = this.blockSize;

    // Resize canvas per game
    if (entry.id === 'tetris') {
      this.canvas.width = (TETRIS_COLS + 5) * bs;
      this.canvas.height = TETRIS_ROWS * bs;
    } else if (entry.id === 'pacman') {
      this.canvas.width = (PACMAN_MAZE_COLS + 5) * bs;
      this.canvas.height = PACMAN_MAZE_ROWS * bs;
    } else if (entry.id === 'asteroids') {
      this.canvas.width = Math.floor(this.containerWidth * 0.85);
      this.canvas.height = Math.floor(this.containerHeight * 0.85);
    }

    const onEscape = () => this.showMenu();
    this.currentGame = entry.create(this.canvas, bs, onEscape);
    this.currentGame.start();

    this.setupFocusListeners();
  }

  // === Focus pause ===

  private setupFocusListeners(): void {
    this.removeFocusListeners();

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        if (this.currentGame && !this.currentGame.isPaused && !this.currentGame.isGameOver) {
          this.currentGame.pause();
        }
      }
    };

    const onFocusOut = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        if (this.currentGame && this.currentGame.isPaused) {
          this.currentGame.resume();
        }
      }
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    this.focusCleanup = () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }

  private removeFocusListeners(): void {
    if (this.focusCleanup) { this.focusCleanup(); this.focusCleanup = null; }
  }

  private removeKeyboard(): void {
    if (this.keyCleanup) { this.keyCleanup(); this.keyCleanup = null; }
  }
}

// ============================================================================
// Public exports (drop-in replacement for tetris.ts)
// ============================================================================

let arcadeManager: ArcadeManager | null = null;
let arcadeContainer: HTMLDivElement | null = null;
let arcadeDismissed = false;

export function showArcade(outputEl: HTMLElement): void {
  if (arcadeManager || arcadeDismissed) return;

  const rect = outputEl.getBoundingClientRect();
  const blockSize = calculateBlockSize(rect.width, rect.height);
  if (blockSize < 10) return;

  arcadeContainer = document.createElement('div');
  arcadeContainer.id = 'arcade-idle';
  arcadeContainer.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    user-select: none;
  `;

  // Top-right button bar (pause + close)
  const btnBar = document.createElement('div');
  btnBar.style.cssText = `
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    z-index: 2;
  `;

  const btnStyle = `
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  `;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.title = 'Close Arcade';
  closeBtn.style.cssText = btnStyle;
  closeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'rgba(248,113,113,0.15)';
    closeBtn.style.color = '#f87171';
    closeBtn.style.borderColor = 'rgba(248,113,113,0.3)';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'rgba(255,255,255,0.04)';
    closeBtn.style.color = 'rgba(255,255,255,0.35)';
    closeBtn.style.borderColor = 'rgba(255,255,255,0.08)';
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissArcade();
  });

  btnBar.appendChild(closeBtn);
  arcadeContainer.appendChild(btnBar);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `border-radius: 4px;`;

  arcadeContainer.appendChild(canvas);

  const parent = outputEl.parentElement!;
  parent.style.position = 'relative';
  parent.appendChild(arcadeContainer);

  // Load retro font, then start
  void ensureRetroFont().then(() => {
    if (!arcadeContainer) return; // was removed while loading
    arcadeManager = new ArcadeManager(canvas, arcadeContainer, rect.width, rect.height);
    arcadeManager.start();
  });
}

export function hideArcade(): void {
  if (!arcadeManager) {
    // Still remove container if font was still loading
    if (arcadeContainer) {
      arcadeContainer.remove();
      arcadeContainer = null;
    }
    return;
  }

  arcadeManager.stop();
  arcadeManager = null;

  if (arcadeContainer) {
    arcadeContainer.remove();
    arcadeContainer = null;
  }
}

export function dismissArcade(): void {
  arcadeDismissed = true;
  hideArcade();
}

export function resetArcadeDismissed(): void {
  arcadeDismissed = false;
}

export function isArcadeVisible(): boolean {
  return arcadeManager !== null || arcadeContainer !== null;
}
