/**
 * SRE Notes — Command Palette v2
 * ⌘K / Ctrl+K opens a terminal-style search palette.
 * Exposes window.SREPalette.
 */
(function() {
  'use strict';

  var isOpen = false;
  var selectedIndex = 0;
  var results = [];
  var paletteEl, inputEl, listEl;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function search(query) {
    if (!window.SREData) return [];
    var q = (query || '').trim().toLowerCase();
    if (!q) {
      return window.SREData.getRecent(8);
    }
    var all = window.SREData.articles;
    var matches = [];
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      var hay = (a.title + ' ' + (a.excerpt || '') + ' ' + (a.tags || []).join(' ')).toLowerCase();
      if (hay.indexOf(q) !== -1) {
        matches.push(a);
      }
    }
    return matches.slice(0, 12);
  }

  function getCategory(id) {
    if (!window.SREData) return null;
    var cats = window.SREData.categories;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].id === id) return cats[i];
    }
    return null;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (results.length === 0) {
      listEl.innerHTML = '<div class="palette-empty">未找到匹配的文章</div>';
      return;
    }
    for (var i = 0; i < results.length; i++) {
      var a = results[i];
      var cat = getCategory(a.category);
      var dotColor = cat ? cat.color : 'var(--accent)';
      var catName = cat ? cat.name : a.category;
      // a.url is root-relative (`/posts/{slug}.html`) — use directly, no `../` needed.
      var path = a.url;
      var item = document.createElement('a');
      item.href = path;
      item.className = 'palette-item' + (i === selectedIndex ? ' selected' : '');
      item.innerHTML =
        '<span class="palette-dot" style="background: ' + dotColor + '"></span>' +
        '<span class="palette-item-main">' +
          '<span class="palette-item-title">' + escapeHtml(a.title) + '</span>' +
          '<span class="palette-item-meta">' + escapeHtml(catName) + ' · ' + a.date + '</span>' +
        '</span>' +
        '<span class="palette-arrow">↵</span>';
      item.addEventListener('mouseenter', function(idx) { return function() {
        selectedIndex = idx;
        render();
      }; }(i));
      listEl.appendChild(item);
    }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    selectedIndex = 0;
    results = search('');
    if (!paletteEl) createPalette();
    paletteEl.classList.add('open');
    if (inputEl) {
      inputEl.value = '';
      setTimeout(function() { inputEl.focus(); }, 30);
    }
    render();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (paletteEl) paletteEl.classList.remove('open');
  }

  function onInput() {
    results = search(inputEl.value);
    selectedIndex = 0;
    render();
  }

  function onKeydown(e) {
    if (!isOpen) {
      // Open shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        open();
        return;
      }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        open();
        return;
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, results.length - 1); render(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); render(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        // a.url is root-relative — navigate directly.
        window.location.href = results[selectedIndex].url;
      }
    }
  }

  function createPalette() {
    paletteEl = document.createElement('div');
    paletteEl.className = 'palette';
    paletteEl.innerHTML =
      '<div class="palette-backdrop" data-palette-close></div>' +
      '<div class="palette-panel" role="dialog" aria-label="Search">' +
        '<div class="palette-input-row">' +
          '<span class="palette-prompt">&gt;</span>' +
          '<input type="text" class="palette-input" placeholder="搜索文章、命令..." autocomplete="off" spellcheck="false" />' +
          '<span class="palette-esc">esc</span>' +
        '</div>' +
        '<div class="palette-list"></div>' +
        '<div class="palette-footer">' +
          '<span><kbd>↑↓</kbd> 选择</span>' +
          '<span><kbd>↵</kbd> 打开</span>' +
          '<span><kbd>esc</kbd> 关闭</span>' +
          '<span class="palette-count">0 篇</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(paletteEl);
    inputEl = paletteEl.querySelector('.palette-input');
    listEl = paletteEl.querySelector('.palette-list');
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    paletteEl.addEventListener('click', function(e) {
      if (e.target.closest('[data-palette-close]')) close();
    });
  }

  function bindOpeners() {
    document.addEventListener('click', function(e) {
      var t = e.target.closest('[data-palette-open]');
      if (t) { e.preventDefault(); open(); }
    });
  }

  function init() {
    bindOpeners();
    document.addEventListener('keydown', onKeydown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SREPalette = { open: open, close: close, toggle: function() { isOpen ? close() : open(); } };
})();
