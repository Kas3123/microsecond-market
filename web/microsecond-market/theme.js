// Themes, colour modes and saved view preferences. Every view reads its colours from Theme.c,
// so switching theme or colour mode restyles the page, the charts, the flow map and the 3D scenes together.
(function () {
  'use strict';
  const THEMES = {
    // Amber on black, square corners, dense panels: the trading-terminal look.
    terminal: {
      label: 'Terminal', bg: '#000000', page: '#050505', panel: '#0A0A0A', panel2: '#141414', line: '#232323', line2: '#343434',
      ink: '#E8E8E8', muted: '#A3A3A3', dim: '#6B6B6B', accent: '#FFA028', hi: '#FFD84D', info: '#4FC3F7',
      stage: '#000000', floor: '#070707', grid: '#1C1C1C', grid2: '#2A2A2A', fair: '#FF4FC3', node: '#FFA028', nodeDim: '#3A3A3A',
      coast: '#5C4A2E', globe: '#0B0B0B', grat: '#161616', tooltip: 'rgba(12,12,12,.96)',
      media: { crossconnect: '#9A9A9A', mmwave: '#FF4FC3', metrofiber: '#4FC3F7', longfiber: '#4FC3F7', microwave: '#FFA028', subsea: '#2DD4BF', internet: '#D4D4D4' },
    },
    // Blue-grey, softer contrast, rounded corners.
    slate: {
      label: 'Slate', bg: '#0A0D12', page: '#0A0D12', panel: '#10151C', panel2: '#161D26', line: '#233040', line2: '#2D3B4D',
      ink: '#E6EDF5', muted: '#8C9AAB', dim: '#5D6B7B', accent: '#F2A33A', hi: '#F2C14E', info: '#4FA3FF',
      stage: '#090C11', floor: '#0D121A', grid: '#1A2430', grid2: '#22303F', fair: '#FF5FA2', node: '#F2A33A', nodeDim: '#2D3B4D',
      coast: '#3D5C78', globe: '#0C1622', grat: '#121C27', tooltip: 'rgba(16,21,28,.96)',
      media: { crossconnect: '#8C9AAB', mmwave: '#FF5FA2', metrofiber: '#4FA3FF', longfiber: '#4FA3FF', microwave: '#F2A33A', subsea: '#2EC4B6', internet: '#C9D3E0' },
    },
  };
  // Up/down and bid/ask colours. "cvd" uses blue and orange (Okabe–Ito), readable with red–green colour blindness.
  const MODES = {
    classic: { label: 'Classic (green / red)', up: '#2FD37A', down: '#FF4A3D', bid: '#1FA971', ask: '#D9463B' },
    cvd: { label: 'Colour-blind safe (blue / orange)', up: '#4DA3FF', down: '#FF8A33', bid: '#2F7FD8', ask: '#E2741F' },
  };
  // View preferences and their defaults. Stored per browser; the page works without storage.
  const DEFAULTS = {
    theme: 'terminal', mode: 'classic',
    book: { camera: 'perspective', style: 'bars', color: 'participant', range: 20, history: 70, scale: 'sqrt', labels: true, lines: true, sparks: true, spin: false },
    flow: { layout: 'schematic', particles: 'dots', density: 'medium', color: 'participant', delays: true, firms: true, weight: true, captions: true },
  };
  const KEY = 'microsecond-market.prefs.v1';
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
    const p = JSON.parse(JSON.stringify(DEFAULTS));
    if (saved && typeof saved === 'object') {
      if (THEMES[saved.theme]) p.theme = saved.theme;
      if (MODES[saved.mode]) p.mode = saved.mode;
      for (const k of ['book', 'flow']) if (saved[k]) for (const f of Object.keys(p[k])) if (typeof saved[k][f] === typeof p[k][f]) p[k][f] = saved[k][f];
    }
    return p;
  }
  const Theme = {
    THEMES, MODES, DEFAULTS, prefs: load(), c: {}, listeners: [],
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.prefs)); } catch (e) { /* storage unavailable: keep working */ } },
    apply() {
      const t = THEMES[this.prefs.theme] || THEMES.terminal, m = MODES[this.prefs.mode] || MODES.classic;
      this.c = Object.assign({}, t, m, { media: Object.assign({}, t.media) });
      const root = document.documentElement;
      root.dataset.theme = this.prefs.theme; root.dataset.mode = this.prefs.mode;
      for (const f of this.listeners) f(this.c);
    },
    set(k, v) { this.prefs[k] = v; this.save(); this.apply(); },
    setView(view, k, v) { this.prefs[view][k] = v; this.save(); },
    resetView(view) { this.prefs[view] = JSON.parse(JSON.stringify(DEFAULTS[view])); this.save(); },
    on(f) { this.listeners.push(f); },
    // mix two hex colours: t = 0 gives a, 1 gives b
    mix(a, b, t) {
      const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      const A = p(a), B = p(b);
      return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
    },
    alpha(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; },
  };
  Theme.apply();
  window.Theme = Theme;
})();
