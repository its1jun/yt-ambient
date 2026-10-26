// Ambient Light popup: UI behavior only (no storage / messaging yet).
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

  function notify(nextState) {
    // TODO: persist (chrome.storage) and send to the content script.
    void nextState;
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
})();
