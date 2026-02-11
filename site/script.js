// ───────────────────────────────────────────────
// Clawdia Landing Page — script.js
// ───────────────────────────────────────────────

(function () {
  'use strict';

  // ─── Video Playback ───

  var videoEl = document.getElementById('hero-video');
  if (videoEl) {
    videoEl.playbackRate = 0.5;
  }

  // ─── GitHub Release Config ───

  var GITHUB_REPO = 'chillysbabybackribs/Clawdia';
  var GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';

  var FALLBACK_BASE = 'https://github.com/' + GITHUB_REPO + '/releases/latest/download';
  var FALLBACK_DOWNLOADS = {
    linux: { url: FALLBACK_BASE + '/Clawdia.AppImage', filename: 'Clawdia.AppImage' },
    mac: { url: FALLBACK_BASE + '/Clawdia.dmg', filename: 'Clawdia.dmg' },
    windows: { url: FALLBACK_BASE + '/Clawdia-setup.exe', filename: 'Clawdia-setup.exe' }
  };

  function getLatestRelease() {
    return fetch(GITHUB_API)
      .then(function (response) {
        if (!response.ok) throw new Error('GitHub API returned ' + response.status);
        return response.json();
      })
      .then(function (release) {
        var assets = release.assets || [];

        var linux = assets.find(function (a) { return a.name === 'Clawdia.AppImage'; }) || assets.find(function (a) { return /\.AppImage$/i.test(a.name); });
        var mac = assets.find(function (a) { return a.name === 'Clawdia.dmg'; }) || assets.find(function (a) { return /\.dmg$/i.test(a.name); });
        var windows = assets.find(function (a) { return a.name === 'Clawdia-setup.exe'; }) || assets.find(function (a) { return /setup.*\.exe$/i.test(a.name) || /\.exe$/i.test(a.name); });

        return {
          linux: linux ? { url: linux.browser_download_url, filename: linux.name, size: linux.size } : FALLBACK_DOWNLOADS.linux,
          mac: mac ? { url: mac.browser_download_url, filename: mac.name, size: mac.size } : FALLBACK_DOWNLOADS.mac,
          windows: windows ? { url: windows.browser_download_url, filename: windows.name, size: windows.size } : FALLBACK_DOWNLOADS.windows
        };
      })
      .catch(function (err) {
        console.warn('Failed to fetch latest release, using fallback:', err);
        return { linux: FALLBACK_DOWNLOADS.linux, mac: FALLBACK_DOWNLOADS.mac, windows: FALLBACK_DOWNLOADS.windows };
      });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    var mb = bytes / (1024 * 1024);
    return Math.round(mb) + ' MB';
  }

  // ─── OS Detection ───

  function detectOS() {
    var ua = navigator.userAgent.toLowerCase();
    var platform = (navigator.platform || '').toLowerCase();
    if (ua.indexOf('win') !== -1) return 'windows';
    if (ua.indexOf('mac') !== -1 || platform.indexOf('mac') !== -1) return 'mac';
    if (ua.indexOf('linux') !== -1 || platform.indexOf('linux') !== -1) return 'linux';
    return 'linux';
  }

  var os = detectOS();

  // ─── Set Download Links (fallback first, then dynamic) ───

  var downloadBtn = document.getElementById('download-btn');
  var downloadLabel = document.getElementById('download-label');
  var downloadNote = document.getElementById('download-note');
  var downloadSize = document.getElementById('download-size');

  var osLabels = { linux: 'Download for Linux', mac: 'Download for macOS', windows: 'Download for Windows' };
  var osOthers = { linux: 'macOS and Windows', mac: 'Linux and Windows', windows: 'macOS and Linux' };
  var osFormats = { linux: '.AppImage', mac: '.dmg \u00b7 Universal', windows: '.exe installer' };

  // Set label immediately based on detected OS (no API needed)
  if (downloadBtn && downloadLabel) {
    downloadLabel.textContent = osLabels[os] || osLabels.linux;
  }
  if (downloadNote) {
    var others = osOthers[os] || osOthers.linux;
    downloadNote.innerHTML = 'Also available for <a href="https://github.com/' + GITHUB_REPO + '/releases/latest" target="_blank" rel="noopener">' + others + '</a>';
  }
  if (downloadSize) {
    downloadSize.textContent = osFormats[os] || osFormats.linux;
  }

  // Highlight current OS in download grid
  var downloadCards = document.querySelectorAll('.download-card[data-platform]');
  downloadCards.forEach(function (card) {
    if (card.getAttribute('data-platform') === os) {
      card.setAttribute('data-current', 'true');
    }
  });

  // Fetch latest release and update all links
  getLatestRelease().then(function (release) {
    var platformData = release[os] || release.linux;

    // Update hero download button
    if (downloadBtn) {
      downloadBtn.href = platformData.url;
    }
    if (downloadSize && platformData.size) {
      downloadSize.textContent = (osFormats[os] || osFormats.linux) + ' \u00b7 ' + formatSize(platformData.size);
    }

    // Update download grid cards
    downloadCards.forEach(function (card) {
      var platform = card.getAttribute('data-platform');
      var data = release[platform];
      if (data && data.url) {
        card.href = data.url;
        var formatEl = card.querySelector('.download-format');
        if (formatEl && data.size) {
          var ext = (osFormats[platform] || '').split(' \u00b7 ')[0];
          formatEl.textContent = ext + ' \u00b7 ' + formatSize(data.size);
        }
      }
    });
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
  var heroMedia = document.getElementById('hero-media');

  if (video && fallback) {
    video.playbackRate = 2;

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

  if (heroMedia && video) {
    var openModal = function (e) {
      // Prevent default behavior if needed
      if (e) e.preventDefault();

      // Create modal elements
      var overlay = document.createElement('div');
      overlay.className = 'media-modal-overlay';

      var content = document.createElement('div');
      content.className = 'media-modal-content';

      var closeBtn = document.createElement('div');
      closeBtn.className = 'media-modal-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.setAttribute('role', 'button');
      closeBtn.setAttribute('aria-label', 'Close modal');
      closeBtn.tabIndex = 0;

      // Create fresh video element instead of cloning to avoid carrying over state
      var videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.muted = true;
      videoEl.loop = true;
      videoEl.playsInline = true;
      videoEl.controls = false;

      // Use currentSrc if available, else fallback to source elements
      if (video.currentSrc) {
        videoEl.src = video.currentSrc;
      } else {
        // Fallback: copy source children
        var sources = video.querySelectorAll('source');
        for (var i = 0; i < sources.length; i++) {
          videoEl.appendChild(sources[i].cloneNode(true));
        }
      }

      // Append elements
      content.appendChild(videoEl);
      overlay.appendChild(content);
      overlay.appendChild(closeBtn);
      document.body.appendChild(overlay);

      // Prevent body scroll
      document.body.style.overflow = 'hidden';

      // Animate in
      requestAnimationFrame(function () {
        overlay.classList.add('active');
        // Need to play explicitly after insertion
        var playPromise = videoEl.play();
        if (playPromise !== undefined) {
          playPromise.catch(function (error) {
            console.log('Auto-play was prevented:', error);
          });
        }
      });

      // Cleanup function
      function closeModal() {
        overlay.classList.remove('active');
        document.body.style.overflow = '';
        setTimeout(function () {
          if (overlay.parentNode) document.body.removeChild(overlay);
        }, 300);
        document.removeEventListener('keydown', escHandler);
      }

      // Close events
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeModal();
      });

      closeBtn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          closeModal();
        }
      });

      overlay.addEventListener('click', function (e) {
        // Close if clicking overlay OR the content wrapper (video itself ignores pointer events via CSS)
        if (e.target === overlay || e.target === content) {
          closeModal();
        }
      });

      // Also allow clicking content explicitly if it captures events
      content.addEventListener('click', function (e) {
        closeModal();
      });

      var escHandler = function (e) {
        if (e.key === 'Escape') closeModal();
      };
      document.addEventListener('keydown', escHandler);

      // Trap focus
      closeBtn.focus();
    };

    // Attach click directly
    heroMedia.addEventListener('click', function (e) {
      openModal(e);
    });

    // Attach keyboard listener
    heroMedia.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        openModal(e);
      }
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
