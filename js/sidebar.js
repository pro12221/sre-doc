/**
 * SRE Notes — Sidebar v2
 * Renders persistent left sidebar with category tree.
 * Expects window.SREData to be loaded first.
 */
(function() {
  'use strict';

  var COLLAPSE_KEY = 'sre-notes-sidebar-collapse';

  function getCollapsed() {
    try {
      var raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch(e) { return {}; }
  }
  function setCollapsed(map) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch(e) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getCurrentPath() {
    var path = window.location.pathname;
    // Normalize: posts/xxx.html or index.html
    var parts = path.split('/');
    var file = parts[parts.length - 1] || 'index.html';
    return file;
  }

  function getCurrentCategory() {
    var file = getCurrentPath();
    if (file === 'index.html' || file === 'about.html') return null;
    if (window.SREData && window.SREData.findByUrl) {
      // Match by URL suffix
      var suffix = 'posts/' + file;
      var article = window.SREData.findByUrl(suffix);
      if (article) return article.category;
    }
    return null;
  }

  function isCurrentArticle(articleUrl) {
    var file = getCurrentPath();
    return articleUrl && articleUrl.indexOf(file) !== -1;
  }

  function render() {
    var sidebar = document.querySelector('[data-sidebar]');
    if (!sidebar) return;
    if (!window.SREData) {
      console.warn('SREData not loaded; sidebar cannot render.');
      return;
    }

    var data = window.SREData;
    var collapsed = getCollapsed();
    var currentCat = getCurrentCategory();

    var html = '';
    html += '<div class="sidebar-header">';
    html +=   '<a href="index.html" class="sidebar-brand">';
    html +=     '<span class="logo">S</span>';
    html +=     '<span>SRE Notes</span>';
    html +=   '</a>';
    html += '</div>';

    html += '<div class="sidebar-search">';
    html +=   '<button type="button" class="sidebar-search-btn" data-palette-open>';
    html +=     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
    html +=     '<span>Search articles...</span>';
    html +=     '<span class="kbd">⌘K</span>';
    html +=   '</button>';
    html += '</div>';

    html += '<nav class="sidebar-nav">';

    // Home link
    html += '<div class="nav-section">';
    html +=   '<a href="index.html" class="nav-item' + (getCurrentPath() === 'index.html' ? ' active' : '') + '">';
    html +=     '<span class="dot" style="background: var(--accent)"></span>';
    html +=     '<span>首页</span>';
    html +=   '</a>';
    html += '</div>';

    // Article categories
    for (var i = 0; i < data.categories.length; i++) {
      var cat = data.categories[i];
      var articles = data.getByCategory(cat.id);
      if (articles.length === 0) continue;
      var isCollapsed = collapsed[cat.id];
      var isActive = currentCat === cat.id;
      // Auto-expand if active
      if (isActive) isCollapsed = false;

      html += '<div class="nav-section">';
      html +=   '<div class="nav-section-title" data-category-toggle="' + cat.id + '">';
      html +=     '<svg class="chev" data-chev="' + cat.id + '" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" style="transition: transform 0.15s; transform: rotate(' + (isCollapsed ? '-90deg' : '0deg') + ')"><path d="M2 4l3 3 3-3"/></svg>';
      html +=     '<span class="dot tag-dot tag-dot-' + cat.id + '"></span>';
      html +=     '<span>' + escapeHtml(cat.name) + '</span>';
      html +=     '<span class="count" style="margin-left: auto; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted);">' + cat.count + '</span>';
      html +=   '</div>';
      html +=   '<div class="nav-section-items" data-items="' + cat.id + '"' + (isCollapsed ? ' style="display: none;"' : '') + '>';
      for (var j = 0; j < articles.length; j++) {
        var a = articles[j];
        var isCurrent = isCurrentArticle(a.url);
        html += '<a href="../' + a.url + '" class="nav-item' + (isCurrent ? ' active' : '') + '">';
        html +=   '<span style="width: 4px; height: 4px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;"></span>';
        html +=   '<span title="' + escapeHtml(a.title) + '">' + escapeHtml(a.title) + '</span>';
        html += '</a>';
      }
      html +=   '</div>';
      html += '</div>';
    }

    html += '</nav>';

    html += '<div class="sidebar-footer">';
    html +=   '<button type="button" data-theme-toggle aria-label="Toggle theme">';
    html +=     '<svg data-theme-icon="dark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display: none;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    html +=     '<svg data-theme-icon="light" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    html +=   '</button>';
    html +=   '<a href="https://github.com/pro12221" target="_blank" rel="noopener" aria-label="GitHub">';
    html +=     '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>';
    html +=   '</a>';
    html +=   '<a href="about.html"' + (getCurrentPath() === 'about.html' ? ' style="color: var(--accent)"' : '') + '>关于</a>';
    html += '</div>';

    sidebar.innerHTML = html;
    bindEvents();
  }

  function bindEvents() {
    // Category collapse/expand
    var titles = document.querySelectorAll('[data-category-toggle]');
    for (var i = 0; i < titles.length; i++) {
      titles[i].addEventListener('click', function(e) {
        var cat = this.getAttribute('data-category-toggle');
        var items = document.querySelector('[data-items="' + cat + '"]');
        var chev = document.querySelector('[data-chev="' + cat + '"]');
        if (!items) return;
        var isHidden = items.style.display === 'none';
        items.style.display = isHidden ? '' : 'none';
        if (chev) chev.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
        var map = getCollapsed();
        map[cat] = !isHidden;
        setCollapsed(map);
      });
    }
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render);
    } else {
      render();
    }
  }

  init();
  window.SRESidebar = { render: render };
})();
