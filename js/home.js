/**
 * SRE Notes — Home Page Renderer v2
 * Renders hero stats, recent list, category grid, featured articles.
 */
(function() {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getCategory(id) {
    if (!window.SREData) return null;
    var cats = window.SREData.categories;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].id === id) return cats[i];
    }
    return null;
  }

  function renderStats() {
    var el = document.getElementById('hero-stats');
    if (!el || !window.SREData) return;
    var data = window.SREData;
    var total = data.articles.length;
    var cats = data.categories.filter(function(c) { return c.count > 0; }).length;
    // Compute active days: distinct months in dates
    var months = {};
    for (var i = 0; i < data.articles.length; i++) {
      var m = data.articles[i].date.substring(0, 7);
      months[m] = true;
    }
    var activeMonths = Object.keys(months).length;
    el.innerHTML =
      '<div class="stat"><span class="stat-value">' + total + '</span><span class="stat-label">篇文章</span></div>' +
      '<div class="stat"><span class="stat-value">' + cats + '</span><span class="stat-label">个分类</span></div>' +
      '<div class="stat"><span class="stat-value">' + activeMonths + '</span><span class="stat-label">个月活跃</span></div>';
  }

  function renderRecent() {
    var el = document.getElementById('recent-list');
    if (!el || !window.SREData) return;
    var items = window.SREData.getRecent(6);
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var cat = getCategory(a.category);
      var catName = cat ? cat.name : a.category;
      var catColor = cat ? cat.color : 'var(--accent)';
      html += '<a class="recent-item" href="' + a.url + '">';
      html +=   '<span class="recent-date">' + a.date + '</span>';
      html +=   '<span class="recent-title">' + escapeHtml(a.title) + '</span>';
      html +=   '<span class="recent-tag"><span class="tag" style="background: ' + catColor + '20; color: ' + catColor + ';">' + escapeHtml(catName) + '</span></span>';
      html +=   '<svg class="recent-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      html += '</a>';
    }
    el.innerHTML = html;
  }

  function renderCategories() {
    var el = document.getElementById('category-grid');
    if (!el || !window.SREData) return;
    var data = window.SREData;
    var html = '';
    for (var i = 0; i < data.categories.length; i++) {
      var cat = data.categories[i];
      if (cat.count === 0) continue;
      html += '<a class="category-card" href="#' + cat.id + '">';
      html +=   '<div class="name"><span class="dot tag-dot tag-dot-' + cat.id + '"></span>' + escapeHtml(cat.name) + '<span class="count">' + cat.count + '</span></div>';
      html +=   '<div class="desc">' + escapeHtml(cat.desc) + '</div>';
      html += '</a>';
    }
    el.innerHTML = html;
  }

  function renderFeatured() {
    var el = document.getElementById('featured-grid');
    if (!el || !window.SREData) return;
    // Featured: pick the 3 most recent articles with longest excerpts (heuristic for "important")
    var data = window.SREData;
    var sorted = data.articles.slice().sort(function(a, b) {
      var la = (a.excerpt || '').length;
      var lb = (b.excerpt || '').length;
      if (lb !== la) return lb - la;
      return b.date.localeCompare(a.date);
    });
    var featured = sorted.slice(0, 6);
    var html = '';
    for (var i = 0; i < featured.length; i++) {
      var a = featured[i];
      var cat = getCategory(a.category);
      var catName = cat ? cat.name : a.category;
      html += '<a class="post-card" href="' + a.url + '">';
      html +=   '<div class="post-card-title">' + escapeHtml(a.title) + '</div>';
      html +=   '<div class="post-card-desc">' + escapeHtml(a.excerpt || '') + '</div>';
      html +=   '<div class="post-card-meta">';
      html +=     '<span class="tag" style="background: ' + (cat ? cat.color : 'var(--accent)') + '20; color: ' + (cat ? cat.color : 'var(--accent)') + ';">' + escapeHtml(catName) + '</span>';
      html +=     '<span>' + a.date + '</span>';
      html +=   '</div>';
      html += '</a>';
    }
    el.innerHTML = html;
  }

  function init() {
    renderStats();
    renderRecent();
    renderCategories();
    renderFeatured();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SREHome = { render: init };
})();
