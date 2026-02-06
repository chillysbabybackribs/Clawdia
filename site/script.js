// ───────────────────────────────────────────────
// Clawdia Landing Page — script.js
// ───────────────────────────────────────────────

(function () {
  'use strict';

  // ─── OS Detection & Download Button ───

  function detectOS() {
    var ua = navigator.userAgent.toLowerCase();
    var platform = (navigator.platform || '').toLowerCase();
    if (ua.indexOf('win') !== -1) return 'windows';
    if (ua.indexOf('mac') !== -1 || platform.indexOf('mac') !== -1) return 'mac';
    if (ua.indexOf('linux') !== -1 || platform.indexOf('linux') !== -1) return 'linux';
    return 'linux';
  }

  function getDownloadInfo(os) {
    var version = '1.0.0';
    var base = 'https://github.com/chillysbabybackribs/Clawdia/releases/download/v' + version;
    switch (os) {
      case 'windows':
        return { label: 'Download for Windows', file: base + '/Clawdia-Setup-' + version + '.exe', note: '.exe installer', others: 'macOS and Linux' };
      case 'mac':
        return { label: 'Download for macOS', file: base + '/Clawdia-' + version + '.dmg', note: '.dmg \u00b7 Universal', others: 'Linux and Windows' };
      default:
        return { label: 'Download for Linux', file: base + '/Clawdia-' + version + '.AppImage', note: '.AppImage \u00b7 159 MB', others: 'macOS and Windows' };
    }
  }

  var os = detectOS();
  var info = getDownloadInfo(os);

  var downloadBtn = document.getElementById('download-btn');
  var downloadLabel = document.getElementById('download-label');
  var downloadNote = document.getElementById('download-note');
  var downloadSize = document.getElementById('download-size');

  if (downloadBtn && downloadLabel) {
    downloadBtn.href = info.file;
    downloadLabel.textContent = info.label;
  }

  if (downloadNote) {
    downloadNote.innerHTML = 'Also available for <a href="https://github.com/chillysbabybackribs/Clawdia/releases" target="_blank" rel="noopener">' + info.others + '</a>';
  }

  if (downloadSize) {
    downloadSize.textContent = info.note;
  }

  // Highlight current OS in download grid
  var downloadCards = document.querySelectorAll('.download-card[data-os]');
  downloadCards.forEach(function (card) {
    if (card.getAttribute('data-os') === os) {
      card.setAttribute('data-current', 'true');
    }
  });

  // ─── Fixed Top Bar ───

  var topbar = document.getElementById('topbar');
  var heroEl = document.getElementById('hero');

  function onScroll() {
    if (!topbar || !heroEl) return;
    var heroBottom = heroEl.offsetHeight;
    if (window.scrollY > heroBottom * 0.7) {
      topbar.classList.add('visible');
    } else {
      topbar.classList.remove('visible');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ─── Scroll Animations ───

  var animateEls = document.querySelectorAll('.animate-on-scroll');
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.1 });

    animateEls.forEach(function (el) { observer.observe(el); });
  } else {
    // Fallback: show all
    animateEls.forEach(function (el) { el.classList.add('visible'); });
  }

  // ─── Hero Video Detection ───

  var video = document.getElementById('hero-video');
  var fallback = document.getElementById('video-fallback');

  if (video && fallback) {
    video.addEventListener('canplay', function () {
      fallback.style.display = 'none';
      video.style.opacity = '1';
    });

    var source = video.querySelector('source');
    if (source) {
      source.addEventListener('error', function () {
        video.style.display = 'none';
        fallback.style.display = 'flex';
      });
    }

    video.addEventListener('error', function () {
      video.style.display = 'none';
      fallback.style.display = 'flex';
    });
  }

  // ─── Copy Button ───

  var copyBtn = document.getElementById('copy-btn');
  var cloneCmd = document.getElementById('clone-cmd');

  if (copyBtn && cloneCmd) {
    copyBtn.addEventListener('click', function () {
      var text = cloneCmd.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showCopied();
        });
      } else {
        // Fallback
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showCopied();
      }
    });
  }

  function showCopied() {
    if (!copyBtn) return;
    var textEl = copyBtn.querySelector('.copy-text');
    copyBtn.classList.add('copied');
    if (textEl) textEl.textContent = 'Copied!';
    setTimeout(function () {
      copyBtn.classList.remove('copied');
      if (textEl) textEl.textContent = 'Copy';
    }, 2000);
  }

})();
