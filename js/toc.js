/**
 * SRE Notes — TOC + Scroll Progress v2
 * Scroll spy for in-page TOC, scroll progress bar at top.
 * Article page only.
 */
(function() {
  'use strict';

  var progressEl, tocLinks = [], headings = [];

  function updateProgress() {
    if (!progressEl) return;
    var doc = document.documentElement;
    var scrollTop = window.scrollY || doc.scrollTop;
    var max = (doc.scrollHeight - window.innerHeight) || 1;
    var pct = Math.max(0, Math.min(1, scrollTop / max));
    progressEl.style.transform = 'scaleX(' + pct + ')';
  }

  function updateActiveToc() {
    var scrollTop = window.scrollY || document.documentElement.scrollTop;
    var currentId = '';
    var triggerY = 100; // topbar height + buffer
    for (var i = 0; i < headings.length; i++) {
      var rect = headings[i].getBoundingClientRect();
      if (rect.top <= triggerY) currentId = headings[i].id;
    }
    for (var j = 0; j < tocLinks.length; j++) {
      var link = tocLinks[j];
      var target = link.getAttribute('data-target');
      if (target === currentId) link.classList.add('active');
      else link.classList.remove('active');
    }
  }

  function buildToc() {
    var content = document.querySelector('.article-content');
    var tocContainer = document.querySelector('[data-toc]');
    if (!content || !tocContainer) return;
    headings = Array.prototype.slice.call(content.querySelectorAll('h2, h3'));
    if (headings.length === 0) {
      // Hide TOC column if no headings
      var shell = document.querySelector('.app-shell');
      if (shell) shell.classList.remove('with-toc');
      var toc = document.querySelector('.toc');
      if (toc) toc.style.display = 'none';
      return;
    }
    // Add ids to headings
    var counter = 0;
    var html = '<ul class="toc-list">';
    for (var i = 0; i < headings.length; i++) {
      counter++;
      var h = headings[i];
      var slug = 'h-' + counter;
      h.id = slug;
      var level = h.tagName === 'H3' ? ' level-h3' : '';
      html += '<li class="toc-item">';
      html +=   '<a href="#' + slug + '" class="toc-link' + level + '" data-target="' + slug + '">' + escapeHtml(h.textContent) + '</a>';
      html += '</li>';
    }
    html += '</ul>';
    tocContainer.innerHTML = html;
    // Cache link references
    tocLinks = Array.prototype.slice.call(tocContainer.querySelectorAll('.toc-link'));
    // Bind click handlers
    for (var j = 0; j < tocLinks.length; j++) {
      tocLinks[j].addEventListener('click', function(e) {
        e.preventDefault();
        var target = this.getAttribute('data-target');
        var el = document.getElementById(target);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Close mobile TOC if open
        var panel = document.querySelector('.toc-mobile-panel');
        if (panel) panel.classList.remove('open');
      });
    }
    // Also build mobile TOC
    var mobileToc = document.querySelector('[data-toc-mobile]');
    if (mobileToc) mobileToc.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function init() {
    progressEl = document.querySelector('[data-progress]');
    buildToc();

    var onScroll = function() {
      updateProgress();
      updateActiveToc();
    };
    var ticking = false;
    window.addEventListener('scroll', function() {
      if (!ticking) {
        window.requestAnimationFrame(function() {
          onScroll();
          ticking = false;
        });
        ticking = true;
      }
    });
    onScroll();

    // Mobile TOC FAB toggle
    var fab = document.querySelector('[data-toc-mobile-fab]');
    var panel = document.querySelector('.toc-mobile-panel');
    if (fab && panel) {
      fab.addEventListener('click', function() {
        panel.classList.toggle('open');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SREToc = { rebuild: buildToc };
})();
