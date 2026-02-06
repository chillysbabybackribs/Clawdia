// ============================================================================
// Arcade — Pac-Man game
// ============================================================================

import type { ArcadeGame } from './types';

// 21x21 maze: 0=wall, 1=dot, 2=power pellet, 3=empty, 4=ghost house
const MAZE: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,0],
  [0,2,0,0,1,0,0,0,0,1,0,1,0,0,0,0,1,0,0,2,0],
  [0,1,0,0,1,0,0,0,0,1,0,1,0,0,0,0,1,0,0,1,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
  [0,1,0,0,1,0,1,0,0,0,0,0,0,0,1,0,1,0,0,1,0],
  [0,1,1,1,1,0,1,1,1,0,0,0,1,1,1,0,1,1,1,1,0],
  [0,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0],
  [3,3,3,0,1,0,1,1,1,1,1,1,1,1,1,0,1,0,3,3,3],
  [0,0,0,0,1,0,1,0,0,4,4,4,0,0,1,0,1,0,0,0,0],
  [3,3,3,3,1,1,1,0,4,4,4,4,4,0,1,1,1,3,3,3,3],
  [0,0,0,0,1,0,1,0,0,0,0,0,0,0,1,0,1,0,0,0,0],
  [3,3,3,0,1,0,1,1,1,1,1,1,1,1,1,0,1,0,3,3,3],
  [0,0,0,0,1,0,1,0,0,0,0,0,0,0,1,0,1,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,0],
  [0,1,0,0,1,0,0,0,0,1,0,1,0,0,0,0,1,0,0,1,0],
  [0,2,1,0,1,1,1,1,1,1,3,1,1,1,1,1,1,0,1,2,0],
  [0,0,1,0,1,0,1,0,0,0,0,0,0,0,1,0,1,0,1,0,0],
  [0,1,1,1,1,0,1,1,1,1,0,1,1,1,1,0,1,1,1,1,0],
  [0,1,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,1,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
  // -- -- removed extra row to keep 21 rows -- --
];

const MAZE_ROWS = MAZE.length;
const MAZE_COLS = MAZE[0].length;

interface Ghost {
  row: number;
  col: number;
  prevRow: number;
  prevCol: number;
  moveProgress: number;
  color: string;
  frightened: boolean;
  eaten: boolean;
  name: string;
}

export class PacManGame implements ArcadeGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cellSize: number;
  private sidePanelWidth: number;
  private onEscape: () => void;

  private maze: number[][];
  private pacRow = 16;
  private pacCol = 10;
  private pacPrevRow = 16;
  private pacPrevCol = 10;
  private pacMoveProgress = 1;
  private pacDir: [number, number] = [0, 0];
  private pacNextDir: [number, number] = [0, 0];
  private mouthAngle = 0;
  private mouthOpening = true;

  private ghosts: Ghost[] = [];
  private _score = 0;
  private highScore = 0;
  private lives = 3;
  private _gameOver = false;
  private _paused = false;
  private frightenedTimer = 0;
  private frightenedDuration = 8000;
  private ghostsEatenCombo = 0;
  private dotsRemaining = 0;
  private levelNum = 1;

  private animFrameId = 0;
  private lastTick = 0;
  private moveInterval = 150;
  private keyCleanup: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, blockSize: number, onEscape: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.cellSize = blockSize;
    this.sidePanelWidth = blockSize * 5;
    this.onEscape = onEscape;

    this.canvas.width = MAZE_COLS * blockSize + this.sidePanelWidth;
    this.canvas.height = MAZE_ROWS * blockSize;

    this.maze = this.cloneMaze();
    this.highScore = parseInt(localStorage.getItem('clawdia-pacman-high') || '0', 10);
    this.countDots();
    this.initGhosts();
  }

  get isGameOver(): boolean { return this._gameOver; }
  get isPaused(): boolean { return this._paused; }
  get score(): number { return this._score; }

  start(): void {
    this.keyCleanup = this.setupKeyboard();
    this.lastTick = performance.now();
    this.loop();
  }

  stop(): void {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = 0; }
    if (this.keyCleanup) { this.keyCleanup(); this.keyCleanup = null; }
  }

  pause(): void { if (!this._gameOver) this._paused = true; }
  resume(): void { if (!this._gameOver) { this._paused = false; this.lastTick = performance.now(); } }

  // === Init helpers ===

  private cloneMaze(): number[][] {
    return MAZE.map(r => [...r]);
  }

  private countDots(): void {
    this.dotsRemaining = 0;
    for (const row of this.maze) {
      for (const cell of row) {
        if (cell === 1 || cell === 2) this.dotsRemaining++;
      }
    }
  }

  private initGhosts(): void {
    this.ghosts = [
      { row: 9, col: 9,  prevRow: 9, prevCol: 9,  moveProgress: 1, color: '#ff0000', frightened: false, eaten: false, name: 'blinky' },
      { row: 9, col: 10, prevRow: 9, prevCol: 10, moveProgress: 1, color: '#ffb8ff', frightened: false, eaten: false, name: 'pinky' },
      { row: 9, col: 11, prevRow: 9, prevCol: 11, moveProgress: 1, color: '#00ffff', frightened: false, eaten: false, name: 'inky' },
      { row: 10, col: 10, prevRow: 10, prevCol: 10, moveProgress: 1, color: '#ffb852', frightened: false, eaten: false, name: 'clyde' },
    ];
  }

  // === Game loop ===

  private loop = (): void => {
    this.animFrameId = requestAnimationFrame(this.loop);
    const now = performance.now();

    if (!this._paused && !this._gameOver) {
      const dt = now - this.lastTick;
      this.update(dt, now);
      this.lastTick = now;
    }

    this.draw(now);
  };

  private update(dt: number, now: number): void {
    // Animate mouth
    if (this.mouthOpening) {
      this.mouthAngle += dt * 0.008;
      if (this.mouthAngle >= 0.35) this.mouthOpening = false;
    } else {
      this.mouthAngle -= dt * 0.008;
      if (this.mouthAngle <= 0.05) this.mouthOpening = true;
    }

    // Frightened timer
    if (this.frightenedTimer > 0) {
      this.frightenedTimer -= dt;
      if (this.frightenedTimer <= 0) {
        this.frightenedTimer = 0;
        this.ghostsEatenCombo = 0;
        for (const g of this.ghosts) g.frightened = false;
      }
    }

    // Move pac-man
    this.pacMoveProgress += dt / this.moveInterval;
    if (this.pacMoveProgress >= 1) {
      this.pacMoveProgress = 0;
      this.pacPrevRow = this.pacRow;
      this.pacPrevCol = this.pacCol;

      // Try next direction first
      if (this.canMove(this.pacRow, this.pacCol, this.pacNextDir)) {
        this.pacDir = this.pacNextDir;
      }
      if (this.canMove(this.pacRow, this.pacCol, this.pacDir)) {
        this.pacRow += this.pacDir[0];
        this.pacCol += this.pacDir[1];
        // Tunnel wrap
        if (this.pacCol < 0) this.pacCol = MAZE_COLS - 1;
        else if (this.pacCol >= MAZE_COLS) this.pacCol = 0;
      } else {
        this.pacPrevRow = this.pacRow;
        this.pacPrevCol = this.pacCol;
        this.pacMoveProgress = 1;
      }

      // Eat dot
      const cell = this.maze[this.pacRow]?.[this.pacCol];
      if (cell === 1) {
        this.maze[this.pacRow][this.pacCol] = 3;
        this._score += 10;
        this.dotsRemaining--;
      } else if (cell === 2) {
        this.maze[this.pacRow][this.pacCol] = 3;
        this._score += 50;
        this.dotsRemaining--;
        this.activateFrightened();
      }

      if (this.dotsRemaining <= 0) {
        this.nextLevel();
      }

      this.updateHighScore();
    }

    // Move ghosts
    for (const g of this.ghosts) {
      if (g.eaten) continue;
      g.moveProgress += dt / (g.frightened ? this.moveInterval * 1.5 : this.moveInterval * 1.1);
      if (g.moveProgress >= 1) {
        g.moveProgress = 0;
        g.prevRow = g.row;
        g.prevCol = g.col;

        const dir = this.getGhostDirection(g);
        if (this.canMoveGhost(g.row, g.col, dir)) {
          g.row += dir[0];
          g.col += dir[1];
          if (g.col < 0) g.col = MAZE_COLS - 1;
          else if (g.col >= MAZE_COLS) g.col = 0;
        }
      }
    }

    // Collision detection
    for (const g of this.ghosts) {
      if (g.eaten) continue;
      const gr = g.prevRow + (g.row - g.prevRow) * Math.min(g.moveProgress, 1);
      const gc = g.prevCol + (g.col - g.prevCol) * Math.min(g.moveProgress, 1);
      const pr = this.pacPrevRow + (this.pacRow - this.pacPrevRow) * Math.min(this.pacMoveProgress, 1);
      const pc = this.pacPrevCol + (this.pacCol - this.pacPrevCol) * Math.min(this.pacMoveProgress, 1);
      const dist = Math.abs(gr - pr) + Math.abs(gc - pc);
      if (dist < 0.8) {
        if (g.frightened) {
          g.eaten = true;
          this.ghostsEatenCombo++;
          this._score += 200 * Math.pow(2, this.ghostsEatenCombo - 1);
          this.updateHighScore();
          // Respawn after delay
          setTimeout(() => {
            g.row = 9; g.col = 10; g.prevRow = 9; g.prevCol = 10;
            g.moveProgress = 1; g.eaten = false; g.frightened = false;
          }, 2000);
        } else {
          this.loseLife();
        }
      }
    }
  }

  private activateFrightened(): void {
    this.frightenedTimer = this.frightenedDuration;
    this.ghostsEatenCombo = 0;
    for (const g of this.ghosts) {
      if (!g.eaten) g.frightened = true;
    }
  }

  private loseLife(): void {
    this.lives--;
    if (this.lives <= 0) {
      this._gameOver = true;
      this.updateHighScore();
    } else {
      this.resetPositions();
    }
  }

  private resetPositions(): void {
    this.pacRow = 16; this.pacCol = 10;
    this.pacPrevRow = 16; this.pacPrevCol = 10;
    this.pacMoveProgress = 1;
    this.pacDir = [0, 0];
    this.pacNextDir = [0, 0];
    this.initGhosts();
  }

  private nextLevel(): void {
    this.levelNum++;
    this.maze = this.cloneMaze();
    this.countDots();
    this.resetPositions();
    this.moveInterval = Math.max(80, 150 - (this.levelNum - 1) * 8);
  }

  private updateHighScore(): void {
    if (this._score > this.highScore) {
      this.highScore = this._score;
      localStorage.setItem('clawdia-pacman-high', String(this.highScore));
    }
  }

  private canMove(row: number, col: number, dir: [number, number]): boolean {
    if (dir[0] === 0 && dir[1] === 0) return false;
    let nr = row + dir[0];
    let nc = col + dir[1];
    // Tunnel
    if (nc < 0) nc = MAZE_COLS - 1;
    else if (nc >= MAZE_COLS) nc = 0;
    if (nr < 0 || nr >= MAZE_ROWS) return false;
    const cell = this.maze[nr][nc];
    return cell !== 0;
  }

  private canMoveGhost(row: number, col: number, dir: [number, number]): boolean {
    if (dir[0] === 0 && dir[1] === 0) return false;
    let nr = row + dir[0];
    let nc = col + dir[1];
    if (nc < 0) nc = MAZE_COLS - 1;
    else if (nc >= MAZE_COLS) nc = 0;
    if (nr < 0 || nr >= MAZE_ROWS) return false;
    const cell = this.maze[nr][nc];
    return cell !== 0;
  }

  private getGhostDirection(g: Ghost): [number, number] {
    const dirs: [number, number][] = [[-1,0],[1,0],[0,-1],[0,1]];
    const valid = dirs.filter(d => this.canMoveGhost(g.row, g.col, d));
    if (valid.length === 0) return [0, 0];

    // Don't reverse direction if possible
    const noReverse = valid.filter(d =>
      !(d[0] === -(g.row - g.prevRow) && d[1] === -(g.col - g.prevCol))
    );
    const choices = noReverse.length > 0 ? noReverse : valid;

    if (g.frightened) {
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // Target-based movement
    let targetRow = this.pacRow;
    let targetCol = this.pacCol;

    if (g.name === 'pinky') {
      targetRow = this.pacRow + this.pacDir[0] * 4;
      targetCol = this.pacCol + this.pacDir[1] * 4;
    } else if (g.name === 'inky') {
      if (Math.random() < 0.3) {
        return choices[Math.floor(Math.random() * choices.length)];
      }
    } else if (g.name === 'clyde') {
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // Pick direction closest to target
    let bestDir = choices[0];
    let bestDist = Infinity;
    for (const d of choices) {
      const nr = g.row + d[0];
      const nc = g.col + d[1];
      const dist = Math.abs(nr - targetRow) + Math.abs(nc - targetCol);
      if (dist < bestDist) {
        bestDist = dist;
        bestDir = d;
      }
    }
    return bestDir;
  }

  // === Drawing ===

  private draw(now: number): void {
    const { ctx, cellSize } = this;
    const mazeW = MAZE_COLS * cellSize;
    const mazeH = MAZE_ROWS * cellSize;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mazeW, mazeH);

    // Draw maze
    for (let r = 0; r < MAZE_ROWS; r++) {
      for (let c = 0; c < MAZE_COLS; c++) {
        const cell = this.maze[r][c];
        const x = c * cellSize;
        const y = r * cellSize;

        if (cell === 0) {
          ctx.fillStyle = '#1a1a5c';
          ctx.fillRect(x, y, cellSize, cellSize);
          // Draw wall border
          ctx.strokeStyle = '#3333aa';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
        } else if (cell === 1) {
          ctx.fillStyle = '#ffb8ae';
          ctx.beginPath();
          ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.1, 0, Math.PI * 2);
          ctx.fill();
        } else if (cell === 2) {
          const pulseScale = 1 + Math.sin(now * 0.005) * 0.2;
          ctx.fillStyle = '#ffb8ae';
          ctx.beginPath();
          ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.22 * pulseScale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw ghosts
    for (const g of this.ghosts) {
      if (g.eaten) continue;
      const gx = (g.prevCol + (g.col - g.prevCol) * Math.min(g.moveProgress, 1)) * cellSize + cellSize / 2;
      const gy = (g.prevRow + (g.row - g.prevRow) * Math.min(g.moveProgress, 1)) * cellSize + cellSize / 2;
      const gr = cellSize * 0.42;

      if (g.frightened) {
        const flashing = this.frightenedTimer < 2000 && Math.floor(now / 200) % 2 === 0;
        ctx.fillStyle = flashing ? '#fff' : '#2121de';
      } else {
        ctx.fillStyle = g.color;
      }

      // Ghost body
      ctx.beginPath();
      ctx.arc(gx, gy - gr * 0.1, gr, Math.PI, 0);
      ctx.lineTo(gx + gr, gy + gr * 0.7);
      // Wavy bottom
      const waves = 3;
      const waveW = (gr * 2) / waves;
      for (let i = 0; i < waves; i++) {
        const wx = gx + gr - i * waveW;
        ctx.quadraticCurveTo(wx - waveW * 0.25, gy + gr * 0.3, wx - waveW * 0.5, gy + gr * 0.7);
        ctx.quadraticCurveTo(wx - waveW * 0.75, gy + gr * 1.1, wx - waveW, gy + gr * 0.7);
      }
      ctx.closePath();
      ctx.fill();

      // Eyes
      if (!g.frightened) {
        const eyeOff = gr * 0.25;
        for (const side of [-1, 1]) {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(gx + side * eyeOff, gy - gr * 0.15, gr * 0.22, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#00f';
          ctx.beginPath();
          ctx.arc(gx + side * eyeOff + this.pacDir[1] * gr * 0.08, gy - gr * 0.15 + this.pacDir[0] * gr * 0.08, gr * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Frightened eyes — small dots
        const eyeOff = gr * 0.2;
        ctx.fillStyle = '#fff';
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(gx + side * eyeOff, gy - gr * 0.1, gr * 0.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw pac-man
    const px = (this.pacPrevCol + (this.pacCol - this.pacPrevCol) * Math.min(this.pacMoveProgress, 1)) * cellSize + cellSize / 2;
    const py = (this.pacPrevRow + (this.pacRow - this.pacPrevRow) * Math.min(this.pacMoveProgress, 1)) * cellSize + cellSize / 2;
    const pr = cellSize * 0.42;
    const mouth = this.mouthAngle * Math.PI;
    let angle = 0;
    if (this.pacDir[1] === 1) angle = 0;
    else if (this.pacDir[1] === -1) angle = Math.PI;
    else if (this.pacDir[0] === -1) angle = -Math.PI / 2;
    else if (this.pacDir[0] === 1) angle = Math.PI / 2;

    ctx.fillStyle = '#ffff00';
    ctx.beginPath();
    ctx.arc(px, py, pr, angle + mouth, angle + Math.PI * 2 - mouth);
    ctx.lineTo(px, py);
    ctx.closePath();
    ctx.fill();

    // === Side Panel ===
    const spx = mazeW + 16;
    const labelColor = '#9a9a9a';
    const valueColor = '#e8e8e8';

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(cellSize * 0.45)}px -apple-system, sans-serif`;
    ctx.fillText('SCORE', spx, cellSize * 1.5);
    ctx.fillStyle = valueColor;
    ctx.font = `${Math.round(cellSize * 0.65)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this._score), spx, cellSize * 2.3);

    ctx.fillStyle = '#787878';
    ctx.font = `600 ${Math.round(cellSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('HIGH', spx, cellSize * 3.2);
    ctx.fillStyle = '#8a8a8a';
    ctx.font = `${Math.round(cellSize * 0.5)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this.highScore), spx, cellSize * 3.9);

    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(cellSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('LEVEL', spx, cellSize * 5);
    ctx.fillStyle = valueColor;
    ctx.font = `${Math.round(cellSize * 0.55)}px "SF Mono", "Fira Code", monospace`;
    ctx.fillText(String(this.levelNum), spx, cellSize * 5.7);

    // Lives
    ctx.fillStyle = labelColor;
    ctx.font = `600 ${Math.round(cellSize * 0.4)}px -apple-system, sans-serif`;
    ctx.fillText('LIVES', spx, cellSize * 7);
    ctx.fillStyle = '#ffff00';
    for (let i = 0; i < this.lives; i++) {
      ctx.beginPath();
      ctx.arc(spx + i * cellSize * 0.8 + cellSize * 0.3, cellSize * 7.6, cellSize * 0.28, 0.2 * Math.PI, 1.8 * Math.PI);
      ctx.lineTo(spx + i * cellSize * 0.8 + cellSize * 0.3, cellSize * 7.6);
      ctx.closePath();
      ctx.fill();
    }

    // Controls
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = `600 ${Math.round(cellSize * 0.35)}px -apple-system, sans-serif`;
    const controlsY = mazeH - cellSize * 3.5;
    ctx.fillText('CONTROLS', spx, controlsY);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = `${Math.round(cellSize * 0.33)}px "SF Mono", monospace`;
    const lineH = cellSize * 0.5;
    ctx.fillText('\u2190\u2191\u2192\u2193  move', spx, controlsY + lineH);
    ctx.fillText('ESC  menu', spx, controlsY + lineH * 2);

    // Overlays
    if (this._gameOver) {
      this.drawOverlay('GAME OVER', mazeW, mazeH, 'Press Enter to restart');
    } else if (this._paused) {
      this.drawOverlay('PAUSED', mazeW, mazeH);
    }
  }

  private drawOverlay(text: string, w: number, h: number, subtext?: string): void {
    const { ctx, cellSize } = this;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(cellSize * 0.7)}px -apple-system, sans-serif`;
    ctx.fillText(text, w / 2, h / 2);
    if (subtext) {
      ctx.fillStyle = '#6b6b6b';
      ctx.font = `${Math.round(cellSize * 0.45)}px -apple-system, sans-serif`;
      ctx.fillText(subtext, w / 2, h / 2 + cellSize);
    }
    ctx.textAlign = 'left';
  }

  // === Keyboard ===

  private setupKeyboard(): () => void {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;

      if (e.key === 'Escape') { e.preventDefault(); this.onEscape(); return; }

      if (this._gameOver && e.key === 'Enter') {
        this.restartGame();
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'ArrowUp':    this.pacNextDir = [-1, 0]; e.preventDefault(); break;
        case 'ArrowDown':  this.pacNextDir = [1, 0];  e.preventDefault(); break;
        case 'ArrowLeft':  this.pacNextDir = [0, -1]; e.preventDefault(); break;
        case 'ArrowRight': this.pacNextDir = [0, 1];  e.preventDefault(); break;
        case 'p': case 'P':
          if (this._paused) this.resume(); else this.pause();
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  private restartGame(): void {
    this._score = 0;
    this.lives = 3;
    this._gameOver = false;
    this._paused = false;
    this.levelNum = 1;
    this.moveInterval = 150;
    this.maze = this.cloneMaze();
    this.countDots();
    this.resetPositions();
    this.frightenedTimer = 0;
    this.lastTick = performance.now();
  }
}
