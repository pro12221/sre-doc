/**
 * SRE Notes — Reading Helpers v2
 * Code block copy buttons + reading time injection.
 */
(function() {
  'use strict';

  function addCopyButtons() {
    var pres = document.querySelectorAll('.article-content pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.querySelector('.code-copy')) continue; // already injected
      // Find code element
      var code = pre.querySelector('code');
      if (!code) continue;
      var btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
        '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +
        '</svg>';
      btn.addEventListener('click', function(c) { return function() {
        try {
          navigator.clipboard.writeText(c.innerText);
        } catch(e) {
          // Fallback
          var r = document.createRange();
          r.selectNodeContents(c);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          try { document.execCommand('copy'); } catch(e2) {}
          sel.removeAllRanges();
        }
        btn.classList.add('copied');
        setTimeout(function() { btn.classList.remove('copied'); }, 1500);
      }; }(code));
      pre.appendChild(btn);
    }
  }

  function init() {
    addCopyButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
