// Ambient Light popup
//  - 전원 ON/OFF: chrome.storage에 저장 (콘텐츠 스크립트가 변경을 감지해 켜고 끈다)
//  - data-setting 컨트롤: scripts/settings.js의 스키마대로 자동으로 불러오고 저장한다 (새 설정은 HTML에 data-setting만 붙이면 된다)
import { CONFIG } from '../scripts/config.js';
import { SCHEMA, createSettings, resolve, snap } from '../scripts/settings.js';

(() => {
  'use strict';

  // ===== Elements =====
  const $ = (selector) => document.querySelector(selector);

  const el = {
    powerButton: $('.power-button'),
    powerState: $('.power-button__state'),
    resetButton: $('.panel__reset-button'),
    controls: [...document.querySelectorAll('[data-setting]')],
  };

  const settings = createSettings();

  // ===== Power state =====
  const state = {
    powerOn: el.powerButton.getAttribute('aria-pressed') === 'true',
  };

  // 마지막으로 저장소와 맞춘 전원 상태 (같은 값을 다시 저장하지 않기 위한 기준)
  let savedPower = state.powerOn;

  function renderPower() {
    el.powerButton.setAttribute('aria-pressed', String(state.powerOn));
    el.powerState.textContent = state.powerOn ? 'ON' : 'OFF';
  }

  // 팝업을 열 때 저장된 전원 상태를 읽어 화면에 반영한다 (없으면 기본값)
  async function loadPower() {
    try {
      const result = await chrome.storage.local.get(CONFIG.power.storageKey);
      const stored = result[CONFIG.power.storageKey];
      state.powerOn = typeof stored === 'boolean' ? stored : CONFIG.power.defaultOn;
    } catch {
      state.powerOn = CONFIG.power.defaultOn;
    }
    savedPower = state.powerOn;
    renderPower();
  }

  // 전원 상태가 바뀐 경우에만 저장소에 쓴다
  function savePower() {
    if (state.powerOn === savedPower) return;
    savedPower = state.powerOn;
    chrome.storage.local.set({ [CONFIG.power.storageKey]: state.powerOn });
  }

  // ===== data-setting 컨트롤 (스키마 기반 자동 바인딩) =====
  const isCheckbox = (input) => input.type === 'checkbox';

  const ruleOf = (input) => SCHEMA[input.dataset.setting];

  // 컨트롤의 현재 설정값. 정해진 값(values) 설정은 슬라이더 위치(0, 1, 2…)를 그 값으로 바꿔 돌려준다
  function readControl(input) {
    if (isCheckbox(input)) return input.checked;
    const rule = ruleOf(input);
    const position = Number(input.value);
    return rule && rule.values ? rule.values[position] : position;
  }

  // 슬라이더의 채움 폭과 값 표시를 현재 값에 맞춘다
  function renderRange(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const percent = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    const box = input.closest('.slider');
    if (!box) return;
    box.style.setProperty('--slider-value', `${percent}%`);
    const label = box.querySelector('.slider__value');
    if (label) label.textContent = `${readControl(input)}${input.dataset.unit || ''}`;
  }

  function writeControl(input, value) {
    if (value === undefined) return;
    const rule = ruleOf(input);
    if (isCheckbox(input)) input.checked = value;
    else if (rule && rule.values) input.value = Math.max(0, rule.values.indexOf(value));
    else input.value = value;
    if (input.type === 'range') renderRange(input);
  }

  // 컨트롤에 스키마의 범위를 넣는다 (범위는 settings.js 한 곳에서만 정한다)
  function applyRange(input) {
    const rule = ruleOf(input);
    if (!rule || input.type !== 'range') return;
    if (rule.values) {   // 정해진 값: 슬라이더는 단계 번호(0 ~ 개수-1)를 움직인다
      input.min = 0;
      input.max = rule.values.length - 1;
      input.step = 1;
      return;
    }
    if (Number.isFinite(rule.min)) input.min = rule.min;
    if (Number.isFinite(rule.max)) input.max = rule.max;
  }

  function writeAll(values) {
    for (const input of el.controls) writeControl(input, values[input.dataset.setting]);
  }

  // ===== Events =====
  for (const input of el.controls) {
    applyRange(input);
    input.addEventListener('input', () => {
      if (input.type === 'range') {
        // 기본값 주변 ±1은 기본값으로 붙인다 (슬라이더도 그 위치로 옮긴다)
        const snapped = snap(input.dataset.setting, Number(input.value));
        if (snapped !== Number(input.value)) input.value = snapped;
        renderRange(input);
      }
      settings.save(input.dataset.setting, readControl(input));
    });
  }

  el.powerButton.addEventListener('click', () => {
    state.powerOn = !state.powerOn;
    renderPower();
    savePower();
  });

  // Reset은 설정만 기본값으로 되돌린다 (저장된 값을 지운다). 전원은 건드리지 않는다.
  el.resetButton.addEventListener('click', async () => {
    writeAll(await settings.reset());
  });

  renderPower();
  writeAll(resolve({}));   // 저장값을 읽기 전에는 config.js 기본값을 보여 준다
  loadPower();
  settings.load().then(writeAll);
})();
