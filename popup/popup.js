// Ambient Light popup: 전원 ON/OFF만 chrome.storage에 연결되어 있다 (나머지는 화면 동작만).
import { CONFIG } from '../scripts/config.js';

(() => {
  'use strict';

  // ===== Elements =====
  const $ = (selector) => document.querySelector(selector);

  const el = {
    lightingSwitch: $('.switch__input'),
    slider: $('.slider'),
    sliderInput: $('.slider__input'),
    sliderValue: $('.slider__value'),
    powerButton: $('.power-button'),
    powerState: $('.power-button__state'),
    resetButton: $('.panel__reset-button'),
  };

  // ===== State =====
  // Rule: powerOn is the feature's master power. lightingEnabled and intensity are
  // settings. They are independent: neither one changes the other.
  // Initial values come from the HTML, so the markup stays the single source of defaults.
  const state = {
    lightingEnabled: el.lightingSwitch.checked,
    intensity: Number(el.sliderInput.value),
    powerOn: el.powerButton.getAttribute('aria-pressed') === 'true',
  };

  const defaults = { ...state };

  // 마지막으로 저장소와 맞춘 전원 상태 (같은 값을 다시 저장하지 않기 위한 기준)
  let savedPower = state.powerOn;

  // ===== Render (state -> DOM) =====
  function render() {
    el.lightingSwitch.checked = state.lightingEnabled;

    el.sliderInput.value = state.intensity;
    el.sliderValue.textContent = `${state.intensity}%`;
    el.slider.style.setProperty('--slider-value', `${state.intensity}%`);

    el.powerButton.setAttribute('aria-pressed', String(state.powerOn));
    el.powerState.textContent = state.powerOn ? 'ON' : 'OFF';
  }

  // ===== Update =====
  // Single entry point for every change. Real features (storage, messaging
  // to the page, etc.) can hook into notify() later.
  function setState(patch) {
    Object.assign(state, patch);
    render();
    notify(state);
  }

  // 전원 상태가 바뀐 경우에만 저장소에 쓴다 (콘텐츠 스크립트가 저장 변경을 감지해 켜고 끈다)
  // 스위치/슬라이더 값은 아직 연결하지 않는다
  function notify(nextState) {
    if (nextState.powerOn === savedPower) return;
    savedPower = nextState.powerOn;
    chrome.storage.local.set({ [CONFIG.power.storageKey]: nextState.powerOn });
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
    render();
  }

  // ===== Events =====
  el.lightingSwitch.addEventListener('change', () => {
    setState({ lightingEnabled: el.lightingSwitch.checked });
  });

  el.sliderInput.addEventListener('input', () => {
    setState({ intensity: Number(el.sliderInput.value) });
  });

  el.powerButton.addEventListener('click', () => {
    setState({ powerOn: !state.powerOn });
  });

  // Reset restores settings only. It never touches powerOn.
  el.resetButton.addEventListener('click', () => {
    setState({
      lightingEnabled: defaults.lightingEnabled,
      intensity: defaults.intensity,
    });
  });

  render();
  loadPower();
})();
