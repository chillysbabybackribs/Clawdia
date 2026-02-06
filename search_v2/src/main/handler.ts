import type { BrowserWindow } from 'electron';
import { Router } from './pipeline/router';
import { Planner } from './pipeline/planner';
import { Executor } from './pipeline/executor';
import { Synthesizer } from './pipeline/synthesizer';
import { log } from './util/log';

const IPC_EVENTS = {
  RESEARCH_PROGRESS: 'research:progress',
  CHAT_STREAM_TEXT: 'chat:stream:text',
  CHAT_STREAM_END: 'chat:stream:end',
};

const { BrowserPool: BrowserPoolImpl } = require('../../main/browser/pool');

type BrowserPool = any;
let browserPool: BrowserPool | null = null;

function createPool(win: BrowserWindow): BrowserPool {
  if (!browserPool) {
    browserPool = new BrowserPoolImpl(win, {
      discoveryCount: 1,
      evidenceCount: 1,
      useSharedSession: true,
    });
  }
  return browserPool;
}

export async function handleResearchRouteV2(apiKey: string, prompt: string, win: BrowserWindow): Promise<string> {
  const pool = createPool(win);
  log.info('SearchV2 routing prompt:', prompt);

  const router = new Router();
  const routerResult = router.classify({ latestMessage: prompt });
  const planner = new Planner();
  const taskSpec = planner.plan({ prompt, routerResult });
  const executor = new Executor(pool, win);
  const synthesizer = new Synthesizer();

  win.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, {
    phase: 'intake',
    message: `Planning ${taskSpec.actions.length} action(s) for domain ${routerResult.domain}`,
  });

  const summary = await executor.execute(taskSpec);
  const answer = synthesizer.synthesize(taskSpec, summary);

  win.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, {
    phase: 'done',
    message: 'SearchV2 pipeline completed',
  });

  win.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, answer);
  win.webContents.send(IPC_EVENTS.CHAT_STREAM_END, answer);

  return answer;
}
