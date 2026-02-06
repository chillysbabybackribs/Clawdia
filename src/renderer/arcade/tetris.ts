// ============================================================================
// Arcade — Tetris game
// ============================================================================

import type { ArcadeGame } from './types';

const COLS = 10;
const ROWS = 20;
const PIECE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;
type PieceName = (typeof PIECE_NAMES)[number];

const SHAPES: Record<PieceName, number[][][]> = {
  I: [
    [[0,0],[0,1],[0,2],[0,3]],
    [[0,0],[1,0],[2,0],[3,0]],
    [[0,0],[0,1],[0,2],[0,3]],
    [[0,0],[1,0],[2,0],[3,0]],
  ],
  O: [
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
  ],
  T: [
    [[0,0],[0,1],[0,2],[1,1]],
    [[0,0],[1,0],[2,0],[1,1]],
    [[1,0],[1,1],[1,2],[0,1]],
    [[0,0],[1,0],[2,0],[1,-1]],
  ],
  S: [
    [[0,1],[0,2],[1,0],[1,1]],
    [[0,0],[1,0],[1,1],[2,1]],
    [[0,1],[0,2],[1,0],[1,1]],
    [[0,0],[1,0],[1,1],[2,1]],
  ],
  Z: [
    [[0,0],[0,1],[1,1],[1,2]],
    [[0,1],[1,0],[1,1],[2,0]],
    [[0,0],[0,1],[1,1],[1,2]],
    [[0,1],[1,0],[1,1],[2,0]],
  ],
  J: [
    [[0,0],[1,0],[1,1],[1,2]],
    [[0,0],[0,1],[1,0],[2,0]],
    [[0,0],[0,1],[0,2],[1,2]],
    [[0,0],[1,0],[2,0],[2,-1]],
  ],
  L: [
    [[0,2],[1,0],[1,1],[1,2]],
    [[0,0],[1,0],[2,0],[2,1]],
    [[0,0],[0,1],[0,2],[1,0]],
    [[0,0],[0,1],[1,1],[2,1]],
  ],
};

const COLORS: Record<PieceName, string> = {
  I: '#00f5ff',
  O: '#ffd700',
  T: '#bf5af2',
  S: '#30d158',
  Z: '#ff453a',
  J: '#0a84ff',
  L: '#ff9f0a',
};

const LINE_SCORES = [0, 100, 300, 500, 800];

interface Piece {
  name: PieceName;
  rotation: number;
  row: number;
  col: number;
}

type Cell = PieceName | null;

export { COLS, ROWS };

export function calculateBlockSize(containerWidth: number, containerHeight: number): number {
  const maxBlockWidth = Math.floor((containerWidth * 0.7) / (COLS + 5));
  const maxBlockHeight = Math.floor((containerHeight - 40) * 0.92 / ROWS);
  return Math.min(maxBlockWidth, maxBlockHeight, 36);
}

export class TetrisGame implements ArcadeGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private blockSize: number;
  private board: Cell[][];
  private current: Piece | null = null;
  private next: PieceName;
  private _score = 0;
  private level = 0;
  private linesCleared = 0;
  private highScore = 0;
  private gameOver = false;
  private _paused = false;
  private started = false;
  private animFrameId = 0;
  private lastDrop = 0;
  private clearFlashRows: number[] = [];
  private clearFlashStart = 0;
  private keyCleanup: (() => void) | null = null;
  private sidePanelWidth: number;
  private onEscape: () => void;

  constructor(canvas: HTMLCanvasElement, blockSize: number, onEscape: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.blockSize = blockSize;
    this.sidePanelWidth = blockSize * 5;
    this.onEscape = onEscape;

    this.canvas.width = COLS * blockSize + this.sidePanelWidth;
    this.canvas.height = ROWS * blockSize;

    this.board = this.emptyBoard();
    this.next = this.randomPiece();
    this.highScore = parseInt(localStorage.getItem('clawdia-tetris-high') || '0', 10);
  }

  get isGameOver(): boolean { return this.gameOver; }
  get isPaused(): boolean { return this._paused; }
  get score(): number { return this._score; }

  start(): void {
    this.keyCleanup = this.setupKeyboard();
    this.render();
  }

  stop(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    if (this.keyCleanup) {
      this.keyCleanup();
      this.keyCleanup = null;
    }
  }

  pause(): void {
    if (this.gameOver || !this.started || this._paused) return;
    this._paused = true;
  }

  resume(): void {
    if (this.gameOver || !this.started || !this._paused) return;
    this._paused = false;
    this.lastDrop = performance.now();
  }

  private emptyBoard(): Cell[][] {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null) as Cell[]);
  }

  private randomPiece(): PieceName {
    return PIECE_NAMES[Math.floor(Math.random() * PIECE_NAMES.length)];
  }

  private spawnPiece(): void {
    this.current = {
      name: this.next,
      rotation: 0,
      row: 0,
      col: Math.floor((COLS - 3) / 2),
    };
    this.next = this.randomPiece();

    if (!this.isValid(this.current)) {
      this.gameOver = true;
      if (this._score > this.highScore) {
        this.highScore = this._score;
        localStorage.setItem('clawdia-tetris-high', String(this.highScore));
      }
    }
  }

  private getCells(piece: Piece): [number, number][] {
    const shape = SHAPES[piece.name][piece.rotation % SHAPES[piece.name].length];
    return shape.map(([dr, dc]) => [piece.row + dr, piece.col + dc]);
  }

  private isValid(piece: Piece): boolean {
    for (const [r, c] of this.getCells(piece)) {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
      if (this.board[r][c] !== null) return false;
    }
    return true;
  }

  private lock(): void {
    if (!this.current) return;
    for (const [r, c] of this.getCells(this.current)) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        this.board[r][c] = this.current.name;
      }
    }
    this.current = null;
    this.clearLines();
    this.spawnPiece();
  }

  private clearLines(): void {
    const fullRows: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      if (this.board[r].every((cell) => cell !== null)) {
        fullRows.push(r);
      }
    }
    if (fullRows.length === 0) return;

    this.clearFlashRows = fullRows;
    this.clearFlashStart = performance.now();

    setTimeout(() => {
      for (const row of fullRows.sort((a, b) => b - a)) {
        this.board.splice(row, 1);
        this.board.unshift(Array(COLS).fill(null) as Cell[]);
      }
      this.clearFlashRows = [];
    }, 100);

    this.linesCleared += fullRows.length;
    this._score += LINE_SCORES[fullRows.length] || 0;
    this.level = Math.floor(this.linesCleared / 10);

    if (this._score > this.highScore) {
      this.highScore = this._score;
      localStorage.setItem('clawdia-tetris-high', String(this.highScore));
    }
  }

  private getDropInterval(): number {
    return Math.max(80, 500 - this.level * 40);
  }

  private getGhostRow(): number {
    if (!this.current) return 0;
    let ghostRow = this.current.row;
    while (true) {
      const test: Piece = { ...this.current, row: ghostRow + 1 };
      if (!this.isValid(test)) break;
      ghostRow++;
    }
    return ghostRow;
  }

  private moveLeft(): void {
    if (!this.current || this.gameOver || this._paused || !this.started) return;
    const moved: Piece = { ...this.current, col: this.current.col - 1 };
    if (this.isValid(moved)) this.current = moved;
  }

  private moveRight(): void {
    if (!this.current || this.gameOver || this._paused || !this.started) return;
    const moved: Piece = { ...this.current, col: this.current.col + 1 };
    if (this.isValid(moved)) this.current = moved;
  }

  private softDrop(): void {
    if (!this.current || this.gameOver || this._paused || !this.started) return;
    const moved: Piece = { ...this.current, row: this.current.row + 1 };
    if (this.isValid(moved)) {
      this.current = moved;
      this.lastDrop = performance.now();
    }
  }

  private hardDrop(): void {
    if (!this.current || this.gameOver || this._paused || !this.started) return;
    this.current.row = this.getGhostRow();
    this.lock();
  }

  private rotate(): void {
    if (!this.current || this.gameOver || this._paused || !this.started) return;
    const rotations = SHAPES[this.current.name].length;
    const rotated: Piece = { ...this.current, rotation: (this.current.rotation + 1) % rotations };
    if (this.isValid(rotated)) { this.current = rotated; return; }
    for (const offset of [-1, 1, -2, 2]) {
      const kicked: Piece = { ...rotated, col: rotated.col + offset };
      if (this.isValid(kicked)) { this.current = kicked; return; }
    }
  }

  private togglePause(): void {
    if (this._paused) this.resume(); else this.pause();
  }

  private restart(): void {
    this.board = this.emptyBoard();
    this._score = 0;
    this.level = 0;
    this.linesCleared = 0;
    this.gameOver = false;
    this._paused = false;
    this.started = true;
    this.current = null;
    this.next = this.randomPiece();
    this.clearFlashRows = [];
    this.spawnPiece();
    this.lastDrop = performance.now();
  }

  private beginGame(): void {
    this.started = true;
    this.spawnPiece();
    this.lastDrop = performance.now();
  }

  // === Rendering ===

  private render = (): void => {
    this.animFrameId = requestAnimationFrame(this.render);
    const now = performance.now();

    if (this.started && !this.gameOver && !this._paused && this.current) {
      if (now - this.lastDrop > this.getDropInterval()) {
        const moved: Piece = { ...this.current, row: this.current.row + 1 };
        if (this.isValid(moved)) {
          this.current = moved;
        } else {
          this.lock();
        }
        this.lastDrop = now;
      }
    }

    this.draw(now);
  };

  private draw(now: number): void {
    const { ctx, blockSize } = this;
    const boardW = COLS * blockSize;
    const boardH = ROWS * blockSize;
    const totalW = boardW + this.sidePanelWidth;

    ctx.clearRect(0, 0, totalW, boardH);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, boardW, boardH);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let r = 1; r < ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * blockSize);
      ctx.lineTo(boardW, r * blockSize);
      ctx.stroke();
    }
    for (let c = 1; c < COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * blockSize, 0);
      ctx.lineTo(c * blockSize, boardH);
      ctx.stroke();
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.board[r][c];
        if (cell) {
          if (this.clearFlashRows.includes(r)) {
            const elapsed = now - this.clearFlashStart;
            const flashAlpha = elapsed < 80 ? 0.9 : 0.4;
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
          } else {
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = COLORS[cell];
          }
          this.drawBlock(r, c);
          ctx.globalAlpha = 1;
        }
      }
    }

    if (this.current && !this.gameOver && !this._paused && this.started) {
      const ghostRow = this.getGhostRow();
      if (ghostRow !== this.current.row) {
        const ghost: Piece = { ...this.current, row: ghostRow };
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = COLORS[this.current.name];
        for (const [r, c] of this.getCells(ghost)) {
          if (r >= 0) this.drawBlock(r, c);
        }
        ctx.globalAlpha = 1;
      }
    }

    if (this.current && !this.gameOver) {
      ctx.fillStyle = COLORS[this.current.name];
      for (const [r, c] of this.getCells(this.current)) {
        if (r >= 0) this.drawBlock(r, c);
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, boardW - 1, boardH - 1);

    // === Side Panel ===
    const px = boardW + 16;
    const labelColor = '#9a9a9a';
    const valueColor = '#e8e8e8';

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(blockSize * 0.45)}px -apple-system, sans-serif`;
    ctx.fillText('SCORE', px, blockSize * 1.5);
    ctx.fillStyle = valueColor;
    ctx.font = `${Math.round(blockSize * 0.65)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this._score), px, blockSize * 2.3);

    ctx.fillStyle = '#787878';
    ctx.font = `600 ${Math.round(blockSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('HIGH', px, blockSize * 3.2);
    ctx.fillStyle = '#8a8a8a';
    ctx.font = `${Math.round(blockSize * 0.5)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this.highScore), px, blockSize * 3.9);

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(blockSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('LEVEL', px, blockSize * 5);
    ctx.fillStyle = valueColor;
    ctx.font = `${Math.round(blockSize * 0.55)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this.level), px, blockSize * 5.7);

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(blockSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('NEXT', px, blockSize * 7);

    const nextShape = SHAPES[this.next][0];
    ctx.fillStyle = COLORS[this.next];
    const previewSize = blockSize * 0.65;
    for (const [dr, dc] of nextShape) {
      const x = px + dc * previewSize;
      const y = blockSize * 7.4 + dr * previewSize;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, previewSize - 2, previewSize - 2, 2);
      ctx.fill();
    }

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(blockSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('LINES', px, blockSize * 10.5);
    ctx.fillStyle = valueColor;
    ctx.font = `${Math.round(blockSize * 0.55)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this.linesCleared), px, blockSize * 11.2);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = `600 ${Math.round(blockSize * 0.35)}px -apple-system, sans-serif`;
    const controlsY = boardH - blockSize * 4.5;
    ctx.fillText('CONTROLS', px, controlsY);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = `${Math.round(blockSize * 0.33)}px "SF Mono", monospace`;
    const lineH = blockSize * 0.5;
    ctx.fillText('\u2190\u2192  move', px, controlsY + lineH);
    ctx.fillText('\u2193   soft drop', px, controlsY + lineH * 2);
    ctx.fillText('\u2191   rotate', px, controlsY + lineH * 3);
    ctx.fillText('SPC  hard drop', px, controlsY + lineH * 4);
    ctx.fillText('ESC  menu', px, controlsY + lineH * 5);

    if (!this.started) {
      this.drawOverlay('Press any key to start', boardW, boardH);
    } else if (this.gameOver) {
      this.drawOverlay('GAME OVER', boardW, boardH, 'Press Enter to restart');
    } else if (this._paused) {
      this.drawOverlay('PAUSED', boardW, boardH);
    }
  }

  private drawBlock(r: number, c: number): void {
    const { ctx, blockSize } = this;
    const x = c * blockSize;
    const y = r * blockSize;
    const inset = 1;
    ctx.beginPath();
    ctx.roundRect(x + inset, y + inset, blockSize - inset * 2, blockSize - inset * 2, 3);
    ctx.fill();
  }

  private drawOverlay(text: string, w: number, h: number, subtext?: string): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(this.blockSize * 0.7)}px -apple-system, sans-serif`;
    ctx.fillText(text, w / 2, h / 2);

    if (subtext) {
      ctx.fillStyle = '#6b6b6b';
      ctx.font = `${Math.round(this.blockSize * 0.45)}px -apple-system, sans-serif`;
      ctx.fillText(subtext, w / 2, h / 2 + this.blockSize);
    }

    ctx.textAlign = 'left';
  }

  // === Keyboard ===

  private setupKeyboard(): () => void {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this.onEscape();
        return;
      }

      if (!this.started && !this.gameOver) {
        e.preventDefault();
        this.beginGame();
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':  this.moveLeft();  e.preventDefault(); break;
        case 'ArrowRight': this.moveRight(); e.preventDefault(); break;
        case 'ArrowDown':  this.softDrop();  e.preventDefault(); break;
        case 'ArrowUp':    this.rotate();    e.preventDefault(); break;
        case ' ':          this.hardDrop();  e.preventDefault(); break;
        case 'p': case 'P': this.togglePause(); break;
        case 'Enter':      if (this.gameOver) this.restart(); break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }
}
