/**
 * SRE Notes — Theme Toggle v2
 * Light / Dark mode with localStorage persistence and system preference detection.
 * Exposes window.SRETheme.
 */
(function() {
  'use strict';

  var STORAGE_KEY = 'sre-notes-theme';
  var THEMES = ['dark', 'light'];
  var DEFAULT_THEME = 'dark';

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch(e) { return null; }
  }
  function setStored(t) {
    try { localStorage.setItem(STORAGE_KEY, t); } catch(e) {}
  }

  function getSystemPreference() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return DEFAULT_THEME;
  }

  function applyTheme(theme) {
    if (THEMES.indexOf(theme) === -1) theme = DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', theme);
    setStored(theme);
    // Class-based body theming (more reliable than CSS var() for body bg)
    try {
      var body = document.body;
      if (body) {
        body.classList.remove('theme-dark', 'theme-light');
        body.classList.add('theme-' + theme);
      }
    } catch(e) {}
    // Update all theme toggle buttons on the page
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      btn.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
      btn.setAttribute('data-current-theme', theme);
    }
    // Notify listeners (palette, charts, etc.)
    try {
      window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
    } catch(e) {}
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // Initialize on first paint (avoid FOUC)
  function init() {
    var stored = getStored();
    var theme = stored || getSystemPreference();
    applyTheme(theme);

    // Bind to all toggle buttons
    document.addEventListener('click', function(e) {
      var t = e.target.closest('[data-theme-toggle]');
      if (!t) return;
      e.preventDefault();
      toggleTheme();
    });

    // Listen to system theme changes (if user hasn't set explicit preference)
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var listener = function(e) {
        if (getStored()) return; // user explicitly chose
        applyTheme(e.matches ? 'light' : DEFAULT_THEME);
      };
      if (mq.addEventListener) mq.addEventListener('change', listener);
      else if (mq.addListener) mq.addListener(listener);
    }
  }

  // Run before page render to avoid flash
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SRETheme = {
    get: function() { return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME; },
    set: applyTheme,
    toggle: toggleTheme
  };
})();
