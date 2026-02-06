// ============================================================================
// Arcade — shared types
// ============================================================================

export interface ArcadeGame {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly isGameOver: boolean;
  readonly isPaused: boolean;
  readonly score: number;
}

export interface GameEntry {
  id: string;
  displayName: string;
  color: string;
  create: (canvas: HTMLCanvasElement, blockSize: number, onEscape: () => void) => ArcadeGame;
}
