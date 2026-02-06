/// <reference types="vitest" />

import { Router } from '../router';
import { Planner } from '../planner';

describe('SearchV2 planner router', () => {
  test('olive oil prompt avoids infosec tokens', () => {
    const router = new Router();
    const planner = new Planner();
    const prompt = 'What are the health benefits of olive oil?';
    const taskSpec = planner.plan({ prompt, routerResult: router.classify({ latestMessage: prompt }) });
    expect(taskSpec.actions.every((action) => !/cve|sandbox|oauth|token|webhook|prompt injection/i.test(action.query))).toBe(true);
  });

  test('OpenClaw safety prompt adds tech only when domain SOFTWARE safety', () => {
    const router = new Router();
    const planner = new Planner();
    const prompt = 'OpenClaw needs a safety review before deployment for our API';
    const routerResult = router.classify({ latestMessage: prompt });
    expect(routerResult.domain).toBe('SOFTWARE');
    const taskSpec = planner.plan({ prompt, routerResult });
    expect(taskSpec.actions.some((action) => /safety review/i.test(action.query))).toBe(true);
    expect(taskSpec.actions.every((action) => action.source === 'google')).toBe(true);
  });

  test('restaurant prompt uses only google queries', () => {
    const router = new Router();
    const planner = new Planner();
    const prompt = 'What are the best restaurants in Austin this weekend?';
    const taskSpec = planner.plan({ prompt, routerResult: router.classify({ latestMessage: prompt }) });
    expect(taskSpec.actions.every((action) => action.source === 'google')).toBe(true);
  });
});
