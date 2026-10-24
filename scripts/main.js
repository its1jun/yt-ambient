import { CONFIG } from './config.js';
import { SEL } from './selectors.js';
import { createStore } from './store.js';
import { computeLayout } from './layout.js';
import { createController } from './controller.js';
import { createAdapter } from './adapter.js';
import { createMount } from './mount.js';
import { createRenderer } from './renderer.js';

// 확장 프로그램의 시작점. 같은 페이지에 두 번 실행되지 않도록 막고, 모듈을 만들어 연결한다.
function boot() {
  if (window.__ytAmbientBooted) return;
  window.__ytAmbientBooted = true;

  const store = createStore();
  // adapter가 관측한 사실을 store에 넣는다 (표시 판단은 store/controller 몫)
  const adapter = createAdapter({
    onChange: (facts) => store.set(facts),
    config: CONFIG,
    selectors: SEL,
  });
  const mount = createMount({ config: CONFIG });
  const renderer = createRenderer({ config: CONFIG });
  const controller = createController({
    adapter, store, mount, renderer, config: CONFIG, computeLayout,
  });

  controller.start();
}

boot();
