/**
 * SRE Notes — Universal Navigation Component
 * Injects top nav bar into all pages, handles mobile menu, scroll effects.
 * v2 — No emoji. Clean text. CSS-only accent dot.
 */
(function() {
  'use strict';

  var navHTML = 
    '<nav class="top-nav" id="top-nav">' +
      '<div class="nav-inner">' +
        '<a href="' + getBasePath() + 'index.html" class="nav-brand">' +
          '<span class="logo-icon">S</span>' +
          '<span>SRE Notes</span>' +
          '<span class="logo-dot"></span>' +
        '</a>' +
        '<ul class="nav-links" id="nav-links">' +
          '<li><a href="' + getBasePath() + 'index.html" class="nav-home">首页</a></li>' +
          '<li><a href="' + getBasePath() + 'index.html#kubernetes" class="nav-docs">文档</a></li>' +
          '<li><a href="' + getBasePath() + 'about.html" class="nav-about">关于</a></li>' +
        '</ul>' +
        '<div class="nav-external">' +
          '<a href="https://github.com/pro12221" target="_blank" title="GitHub">' +
            '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>' +
          '</a>' +
        '</div>' +
        '<button class="nav-toggle" id="nav-toggle" aria-label="Toggle menu">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>' +
          '</svg>' +
        '</button>' +
      '</div>' +
    '</nav>' +
    '<div class="mobile-menu" id="mobile-menu">' +
      '<a href="' + getBasePath() + 'index.html">首页</a>' +
      '<a href="' + getBasePath() + 'index.html#kubernetes">文档</a>' +
      '<a href="' + getBasePath() + 'about.html">关于</a>' +
      '<a href="https://github.com/pro12221" target="_blank">GitHub</a>' +
    '</div>';

  function getBasePath() {
    // Detect if we're in a subdirectory (posts/*.html) or root
    var path = window.location.pathname;
    if (path.indexOf('/posts/') !== -1) return '../';
    return '';
  }

  // Inject nav at body start
  var body = document.body;
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = navHTML;
  while (tempDiv.firstChild) {
    body.insertBefore(tempDiv.firstChild, body.firstChild);
  }

  // Wrap existing content in main-content div
  var existingContent = [];
  var navElements = [];
  var mainContent = document.createElement('div');
  mainContent.className = 'main-content';

  // Move all remaining body children into main-content (skip canvas, nav, mobile-menu)
  while (body.children.length > 0) {
    var child = body.children[0];
    if (child.tagName === 'CANVAS' && child.id === 'particles-canvas') {
      // Keep canvas as direct body child
      body.removeChild(child);
      existingContent.push(child);
    } else if (!child.classList.contains('top-nav') && !child.classList.contains('mobile-menu') && child.id !== 'particles-canvas') {
      body.removeChild(child);
      mainContent.appendChild(child);
    } else {
      // It's the nav or mobile menu we just injected, save for re-insertion
      body.removeChild(child);
      navElements.push(child);
    }
  }

  // Re-insert canvas first, then nav elements, then main content
  for (var i = 0; i < existingContent.length; i++) {
    body.appendChild(existingContent[i]);
  }
  for (var i = 0; i < navElements.length; i++) {
    body.appendChild(navElements[i]);
  }
  body.appendChild(mainContent);

  // --- Event Handlers ---
  var navToggle = document.getElementById('nav-toggle');
  var mobileMenu = document.getElementById('mobile-menu');
  var topNav = document.getElementById('top-nav');

  // Mobile menu toggle
  navToggle.addEventListener('click', function() {
    mobileMenu.classList.toggle('open');
  });

  // Close mobile menu on link click
  mobileMenu.querySelectorAll('a').forEach(function(link) {
    link.addEventListener('click', function() {
      mobileMenu.classList.remove('open');
    });
  });

  // Scroll effect on nav
  window.addEventListener('scroll', function() {
    if (window.scrollY > 50) {
      topNav.classList.add('scrolled');
    } else {
      topNav.classList.remove('scrolled');
    }
  });

  // Highlight active nav link
  var path = window.location.pathname;
  var navLinks = document.querySelectorAll('.nav-links a');
  navLinks.forEach(function(link) {
    link.classList.remove('active');
    var href = link.getAttribute('href');
    if (path.endsWith('index.html') && href.indexOf('index.html') !== -1 && href.indexOf('#') === -1) {
      link.classList.add('active');
    } else if (path.endsWith('about.html') && href.indexOf('about.html') !== -1) {
      link.classList.add('active');
    } else if (path.indexOf('/posts/') !== -1 && href.indexOf('#kubernetes') !== -1) {
      link.classList.add('active');
    }
  });

  // Scroll reveal animation — opacity + translateY
  var revealElements = document.querySelectorAll('.post-card, .contact-card, .skill-item, .category-card, .about-hero');
  revealElements.forEach(function(el) {
    el.classList.add('reveal');
  });

  var revealObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });

  document.querySelectorAll('.reveal').forEach(function(el) {
    revealObserver.observe(el);
  });

  // Article page entrance animation
  var articleHeader = document.querySelector('.article-header');
  if (articleHeader) {
    articleHeader.style.opacity = '0';
    articleHeader.style.transform = 'translateY(16px)';
    articleHeader.style.transition = 'opacity .5s ease, transform .5s ease';
    setTimeout(function() {
      articleHeader.style.opacity = '1';
      articleHeader.style.transform = 'translateY(0)';
    }, 100);
  }

  // getBoundingClientRect is required here: offsetTop is relative to offsetParent,
  // which is .main-content (position:relative), not the document root
  var tocLinks = document.querySelectorAll('.toc-link[data-target]');
  if (tocLinks.length > 0) {
    var content = document.querySelector('.article-content');
    if (content) {
      var headings = content.querySelectorAll('h2, h3');
      function updateActiveToc() {
        var currentId = '';
        headings.forEach(function(h) {
          if (h.getBoundingClientRect().top <= 100) currentId = h.id;
        });
        tocLinks.forEach(function(link) {
          link.classList.toggle('active', link.getAttribute('data-target') === currentId);
        });
      }
      var tocTicking = false;
      window.addEventListener('scroll', function() {
        if (!tocTicking) {
          window.requestAnimationFrame(function() { updateActiveToc(); tocTicking = false; });
          tocTicking = true;
        }
      });
      updateActiveToc();
    }
  }

})();
