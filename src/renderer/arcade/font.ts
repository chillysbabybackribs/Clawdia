// ============================================================================
// Arcade — retro font loader (Press Start 2P via FontFace API)
// ============================================================================

const FONT_URL = 'https://fonts.gstatic.com/s/pressstart2p/v15/e3t4euO8T-267oIAQAu6jDQyK3nVivM.woff2';
const FONT_FAMILY = 'Press Start 2P';
const FALLBACK = '"Courier New", monospace';

let loaded = false;
let loading: Promise<void> | null = null;

export function ensureRetroFont(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;

  loading = (async () => {
    try {
      const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
      const loadedFace = await face.load();
      document.fonts.add(loadedFace);
      loaded = true;
    } catch {
      // Font failed to load — we'll use fallback
      loaded = true;
    }
  })();

  return loading;
}

export function getRetroFont(size: number): string {
  return `${size}px "${FONT_FAMILY}", ${FALLBACK}`;
}
