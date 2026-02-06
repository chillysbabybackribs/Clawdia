// ============================================================================
// Arcade — Asteroids game
// ============================================================================

import type { ArcadeGame } from './types';

interface Vec2 { x: number; y: number; }

interface Bullet {
  pos: Vec2;
  vel: Vec2;
  life: number;
}

interface Asteroid {
  pos: Vec2;
  vel: Vec2;
  size: number; // 3=large, 2=medium, 1=small
  radius: number;
  vertices: number[]; // angular offsets for jagged shape
}

interface Particle {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
}

const SIZE_SCORES: Record<number, number> = { 3: 20, 2: 50, 1: 100 };
const SIZE_RADII: Record<number, number> = { 3: 40, 2: 20, 1: 10 };
const MAX_BULLETS = 5;
const BULLET_LIFE = 60;
const EXTRA_LIFE_SCORE = 10000;

export class AsteroidsGame implements ArcadeGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private onEscape: () => void;

  // Ship
  private shipPos: Vec2 = { x: 0, y: 0 };
  private shipVel: Vec2 = { x: 0, y: 0 };
  private shipAngle = -Math.PI / 2;
  private thrusting = false;
  private shipInvuln = 0;

  // Entities
  private bullets: Bullet[] = [];
  private asteroids: Asteroid[] = [];
  private particles: Particle[] = [];
  private starfield: Vec2[] = [];

  // State
  private _score = 0;
  private highScore = 0;
  private lives = 3;
  private level = 0;
  private _gameOver = false;
  private _paused = false;
  private nextLifeAt: number;

  // Input
  private keys = new Set<string>();
  private keyCleanup: (() => void) | null = null;
  private animFrameId = 0;
  private lastTime = 0;

  // Flame particles
  private flameParticles: Particle[] = [];

  constructor(canvas: HTMLCanvasElement, _blockSize: number, onEscape: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.onEscape = onEscape;
    this.highScore = parseInt(localStorage.getItem('clawdia-asteroids-high') || '0', 10);
    this.nextLifeAt = EXTRA_LIFE_SCORE;
  }

  get isGameOver(): boolean { return this._gameOver; }
  get isPaused(): boolean { return this._paused; }
  get score(): number { return this._score; }

  start(): void {
    this.w = this.canvas.width;
    this.h = this.canvas.height;
    this.shipPos = { x: this.w / 2, y: this.h / 2 };
    this.shipVel = { x: 0, y: 0 };
    this.generateStarfield();
    this.startLevel();
    this.keyCleanup = this.setupKeyboard();
    this.lastTime = performance.now();
    this.loop();
  }

  stop(): void {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = 0; }
    if (this.keyCleanup) { this.keyCleanup(); this.keyCleanup = null; }
  }

  pause(): void { if (!this._gameOver) this._paused = true; }
  resume(): void { if (!this._gameOver) { this._paused = false; this.lastTime = performance.now(); } }

  private generateStarfield(): void {
    this.starfield = [];
    for (let i = 0; i < 80; i++) {
      this.starfield.push({ x: Math.random() * this.w, y: Math.random() * this.h });
    }
  }

  private startLevel(): void {
    this.level++;
    const count = 3 + this.level;
    for (let i = 0; i < count; i++) {
      this.spawnAsteroid(3);
    }
  }

  private spawnAsteroid(size: number, pos?: Vec2): void {
    const radius = SIZE_RADII[size] * (this.w / 600);
    let p: Vec2;
    if (pos) {
      p = { ...pos };
    } else {
      // Spawn away from ship
      do {
        p = { x: Math.random() * this.w, y: Math.random() * this.h };
      } while (this.dist(p, this.shipPos) < 150);
    }
    const angle = Math.random() * Math.PI * 2;
    const speed = (1 + Math.random() * 1.5) * (1 + this.level * 0.1);
    const verts: number[] = [];
    const numVerts = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < numVerts; i++) {
      verts.push(0.7 + Math.random() * 0.3);
    }
    this.asteroids.push({
      pos: p,
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      size,
      radius,
      vertices: verts,
    });
  }

  private dist(a: Vec2, b: Vec2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private wrap(pos: Vec2): void {
    if (pos.x < 0) pos.x += this.w;
    else if (pos.x > this.w) pos.x -= this.w;
    if (pos.y < 0) pos.y += this.h;
    else if (pos.y > this.h) pos.y -= this.h;
  }

  // === Game loop ===

  private loop = (): void => {
    this.animFrameId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 16.67, 3); // normalize to ~60fps

    if (!this._paused && !this._gameOver) {
      this.update(dt);
    }

    this.lastTime = now;
    this.draw(now);
  };

  private update(dt: number): void {
    // Ship rotation
    if (this.keys.has('ArrowLeft')) this.shipAngle -= 0.065 * dt;
    if (this.keys.has('ArrowRight')) this.shipAngle += 0.065 * dt;

    // Thrust
    this.thrusting = this.keys.has('ArrowUp');
    if (this.thrusting) {
      this.shipVel.x += Math.cos(this.shipAngle) * 0.12 * dt;
      this.shipVel.y += Math.sin(this.shipAngle) * 0.12 * dt;
      // Flame particles
      if (Math.random() < 0.6) {
        const backAngle = this.shipAngle + Math.PI + (Math.random() - 0.5) * 0.5;
        this.flameParticles.push({
          pos: { ...this.shipPos },
          vel: { x: Math.cos(backAngle) * (2 + Math.random() * 2), y: Math.sin(backAngle) * (2 + Math.random() * 2) },
          life: 10 + Math.random() * 10,
          maxLife: 20,
        });
      }
    }

    // Friction
    this.shipVel.x *= 0.995;
    this.shipVel.y *= 0.995;

    // Speed cap
    const speed = Math.hypot(this.shipVel.x, this.shipVel.y);
    if (speed > 8) {
      this.shipVel.x = (this.shipVel.x / speed) * 8;
      this.shipVel.y = (this.shipVel.y / speed) * 8;
    }

    // Move ship
    this.shipPos.x += this.shipVel.x * dt;
    this.shipPos.y += this.shipVel.y * dt;
    this.wrap(this.shipPos);

    if (this.shipInvuln > 0) this.shipInvuln -= dt;

    // Move bullets
    for (const b of this.bullets) {
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      this.wrap(b.pos);
      b.life -= dt;
    }
    this.bullets = this.bullets.filter(b => b.life > 0);

    // Move asteroids
    for (const a of this.asteroids) {
      a.pos.x += a.vel.x * dt;
      a.pos.y += a.vel.y * dt;
      this.wrap(a.pos);
    }

    // Update particles
    for (const p of this.particles) p.life -= dt;
    this.particles = this.particles.filter(p => p.life > 0);
    for (const p of this.particles) {
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
    }

    for (const p of this.flameParticles) p.life -= dt;
    this.flameParticles = this.flameParticles.filter(p => p.life > 0);
    for (const p of this.flameParticles) {
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
    }

    // Bullet-asteroid collision
    for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      for (let ai = this.asteroids.length - 1; ai >= 0; ai--) {
        const a = this.asteroids[ai];
        if (this.dist(b.pos, a.pos) < a.radius) {
          this.bullets.splice(bi, 1);
          this.asteroids.splice(ai, 1);
          this._score += SIZE_SCORES[a.size] || 0;

          // Check extra life
          if (this._score >= this.nextLifeAt) {
            this.lives++;
            this.nextLifeAt += EXTRA_LIFE_SCORE;
          }

          this.updateHighScore();

          // Spawn explosion
          const numP = 8 + Math.floor(Math.random() * 8);
          for (let i = 0; i < numP; i++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = 1 + Math.random() * 3;
            this.particles.push({
              pos: { ...a.pos },
              vel: { x: Math.cos(ang) * spd, y: Math.sin(ang) * spd },
              life: 20 + Math.random() * 20,
              maxLife: 40,
            });
          }

          // Split
          if (a.size > 1) {
            this.spawnAsteroid(a.size - 1, a.pos);
            this.spawnAsteroid(a.size - 1, a.pos);
          }
          break;
        }
      }
    }

    // Ship-asteroid collision
    if (this.shipInvuln <= 0) {
      const shipRadius = 12 * (this.w / 600);
      for (let ai = this.asteroids.length - 1; ai >= 0; ai--) {
        const a = this.asteroids[ai];
        if (this.dist(this.shipPos, a.pos) < a.radius + shipRadius) {
          this.lives--;
          if (this.lives <= 0) {
            this._gameOver = true;
            this.updateHighScore();
          } else {
            this.shipPos = { x: this.w / 2, y: this.h / 2 };
            this.shipVel = { x: 0, y: 0 };
            this.shipInvuln = 120;
          }
          // Destroy the asteroid too
          this.asteroids.splice(ai, 1);
          if (a.size > 1) {
            this.spawnAsteroid(a.size - 1, a.pos);
            this.spawnAsteroid(a.size - 1, a.pos);
          }
          break;
        }
      }
    }

    // Next level
    if (this.asteroids.length === 0) {
      this.startLevel();
    }
  }

  private shoot(): void {
    if (this._gameOver || this._paused) return;
    if (this.bullets.length >= MAX_BULLETS) return;
    const speed = 8;
    this.bullets.push({
      pos: { ...this.shipPos },
      vel: { x: Math.cos(this.shipAngle) * speed, y: Math.sin(this.shipAngle) * speed },
      life: BULLET_LIFE,
    });
  }

  private updateHighScore(): void {
    if (this._score > this.highScore) {
      this.highScore = this._score;
      localStorage.setItem('clawdia-asteroids-high', String(this.highScore));
    }
  }

  // === Drawing ===

  private draw(now: number): void {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Starfield
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (const s of this.starfield) {
      ctx.fillRect(s.x, s.y, 1.5, 1.5);
    }

    // Flame particles
    for (const p of this.flameParticles) {
      const alpha = (p.life / p.maxLife) * 0.8;
      ctx.fillStyle = `rgba(255, ${Math.floor(150 + 100 * (p.life / p.maxLife))}, 0, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Explosion particles
    for (const p of this.particles) {
      const alpha = (p.life / p.maxLife) * 0.9;
      ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 2.5 * (p.life / p.maxLife), 0, Math.PI * 2);
      ctx.fill();
    }

    // Asteroids
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 1.5;
    for (const a of this.asteroids) {
      ctx.beginPath();
      const n = a.vertices.length;
      for (let i = 0; i <= n; i++) {
        const angle = (i / n) * Math.PI * 2;
        const r = a.radius * a.vertices[i % n];
        const x = a.pos.x + Math.cos(angle) * r;
        const y = a.pos.y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // Bullets
    ctx.fillStyle = '#ff4444';
    for (const b of this.bullets) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ship
    if (!this._gameOver) {
      const blink = this.shipInvuln > 0 && Math.floor(now / 100) % 2 === 0;
      if (!blink) {
        const s = 14 * (this.w / 600);
        const ax = this.shipPos.x + Math.cos(this.shipAngle) * s;
        const ay = this.shipPos.y + Math.sin(this.shipAngle) * s;
        const bx = this.shipPos.x + Math.cos(this.shipAngle + 2.4) * s;
        const by = this.shipPos.y + Math.sin(this.shipAngle + 2.4) * s;
        const cx = this.shipPos.x + Math.cos(this.shipAngle - 2.4) * s;
        const cy = this.shipPos.y + Math.sin(this.shipAngle - 2.4) * s;

        ctx.strokeStyle = '#00f5ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.stroke();
      }
    }

    // HUD — top left
    ctx.fillStyle = '#e8e8e8';
    ctx.font = `${Math.round(14 * (w / 600))}px "SF Mono", "Fira Code", monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE  ${this._score}`, 12, 24 * (h / 400));
    ctx.fillStyle = '#787878';
    ctx.fillText(`HIGH  ${this.highScore}`, 12, 44 * (h / 400));
    ctx.fillStyle = '#9a9a9a';
    ctx.fillText(`LEVEL  ${this.level}`, 12, 64 * (h / 400));

    // Lives — ship icons
    const lifeSize = 10 * (w / 600);
    ctx.strokeStyle = '#00f5ff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < this.lives; i++) {
      const lx = w - 20 - i * (lifeSize * 2.5);
      const ly = 20;
      const a = -Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(lx + Math.cos(a) * lifeSize, ly + Math.sin(a) * lifeSize);
      ctx.lineTo(lx + Math.cos(a + 2.4) * lifeSize, ly + Math.sin(a + 2.4) * lifeSize);
      ctx.lineTo(lx + Math.cos(a - 2.4) * lifeSize, ly + Math.sin(a - 2.4) * lifeSize);
      ctx.closePath();
      ctx.stroke();
    }

    // Controls hint — bottom center
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.font = `${Math.round(10 * (w / 600))}px "SF Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('\u2190\u2192 ROTATE   \u2191 THRUST   SPACE FIRE   ESC MENU', w / 2, h - 12);
    ctx.textAlign = 'left';

    // Overlays
    if (this._gameOver) {
      this.drawOverlay('GAME OVER', 'Press Enter to restart');
    } else if (this._paused) {
      this.drawOverlay('PAUSED');
    }
  }

  private drawOverlay(text: string, subtext?: string): void {
    const { ctx, w, h } = this;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(24 * (w / 600))}px -apple-system, sans-serif`;
    ctx.fillText(text, w / 2, h / 2);
    if (subtext) {
      ctx.fillStyle = '#6b6b6b';
      ctx.font = `${Math.round(14 * (w / 600))}px -apple-system, sans-serif`;
      ctx.fillText(subtext, w / 2, h / 2 + 30 * (h / 400));
    }
    ctx.textAlign = 'left';
  }

  // === Keyboard ===

  private setupKeyboard(): () => void {
    const keydown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;

      if (e.key === 'Escape') { e.preventDefault(); this.onEscape(); return; }

      if (this._gameOver && e.key === 'Enter') {
        this.restartGame();
        e.preventDefault();
        return;
      }

      this.keys.add(e.key);
      if (e.key === ' ') { this.shoot(); e.preventDefault(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault();
      if (e.key === 'p' || e.key === 'P') {
        if (this._paused) this.resume(); else this.pause();
      }
    };

    const keyup = (e: KeyboardEvent) => {
      this.keys.delete(e.key);
    };

    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', keyup);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('keyup', keyup);
    };
  }

  private restartGame(): void {
    this._score = 0;
    this.lives = 3;
    this.level = 0;
    this._gameOver = false;
    this._paused = false;
    this.nextLifeAt = EXTRA_LIFE_SCORE;
    this.asteroids = [];
    this.bullets = [];
    this.particles = [];
    this.flameParticles = [];
    this.shipPos = { x: this.w / 2, y: this.h / 2 };
    this.shipVel = { x: 0, y: 0 };
    this.shipAngle = -Math.PI / 2;
    this.shipInvuln = 0;
    this.startLevel();
    this.lastTime = performance.now();
  }
}
