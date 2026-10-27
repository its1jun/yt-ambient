import { CONFIG } from './config.js';
import { SEL } from './selectors.js';
import { createStore } from './store.js';
import { computeLayout } from './layout.js';
import { createController } from './controller.js';
import { createAdapter } from './adapter.js';
import { createMount } from './mount.js';
import { createRenderer } from './renderer.js';
import { createPowerStorage } from './power-storage.js';
import { createSettings, createLiveConfig, applySettings } from './settings.js';

// 확장 프로그램의 시작점. 같은 페이지에 두 번 실행되지 않도록 막고, 모듈을 만들어 연결한다.
async function boot() {
  if (window.__ytAmbientBooted) return;
  window.__ytAmbientBooted = true;

  // 모듈들이 받아 쓰는 config: config.js 기본값 위에 팝업에서 저장한 값을 얹는다 (이후 변경도 이 객체의 값만 제자리에서 바꾼다)
  const config = createLiveConfig();
  const settings = createSettings();
  // 시작 전에 저장된 값을 먼저 읽어 적용한다 (기본값으로 잠깐 그려졌다 바뀌는 깜빡임 방지, 읽기에 실패하면 기본값)
  applySettings({ live: config, values: await settings.load() });

  const store = createStore();
  // adapter가 관측한 사실을 store에 넣는다 (표시 판단은 store/controller 몫)
  const adapter = createAdapter({
    onChange: (facts) => store.set(facts),
    config,
    selectors: SEL,
  });
  const mount = createMount({ config });
  const renderer = createRenderer({ config });
  const controller = createController({
    adapter, store, mount, renderer, config, computeLayout,
  });
  // 팝업의 전원 상태를 store에 반영한다 (전원이 꺼져 있으면 controller가 IDLE로 둔다)
  const powerStorage = createPowerStorage({ store, config });

  // 팝업에서 설정이 바뀌면 (모든 탭에서) 바로 반영한다
  settings.onChange((values) => {
    const effects = applySettings({ live: config, values });
    if (effects.reflow || effects.resetBars) controller.refresh({ resetBars: effects.resetBars });
  });

  powerStorage.start();
  controller.start();
}

boot();
