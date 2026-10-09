/**
 * Video Playlist Widget — Storefront Player (MP4 only)
 *
 * Behaviour:
 *  - Panel opens automatically on page load
 *  - Autoplay follows the merchant setting and starts muted
 *  - If browser blocks unmuted autoplay, retries muted (browser policy)
 *  - If browser blocks all autoplay, shows play button for user to tap
 *  - Native MP4 video support only
 *  - Card shuffle / stacked-card UI with swipe support
 */

(function () {
  'use strict';

  const CARD_OFFSET_X   = 8;
  const CARD_OFFSET_Y   = 6;
  const STACK_DEPTH     = 3;
  const SWIPE_THRESHOLD = 55;

  // ─── Detect Shopify theme editor ───────────────────────────────────────────
  // window.Shopify.designMode is true when the page is loaded inside the
  // theme customiser iframe. We skip autoplay and avoid re-init on section
  // reload events.
  const IN_EDITOR = !!(window.Shopify && window.Shopify.designMode);

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  function boot() {
    const root = document.getElementById('avp-root');
    if (!root) return;

    // Teardown any existing instance before creating a new one.
    // This handles the theme editor's section:load event which re-injects
    // the block HTML but keeps the same JS context — without teardown a
    // second instance would be created on the re-injected root.
    if (root._avpInstance) {
      root._avpInstance._teardown();
      root._avpInstance = null;
    }

    root._avpInstance = new AVPWidget(root, { skipAutoplay: IN_EDITOR });
  }

  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

  // Re-init when the theme editor reloads the section (settings change)
  document.addEventListener('shopify:section:load', (e) => {
    if (e.target && e.target.querySelector('#avp-root')) boot();
  });
  // Also handle the block-level reload event
  document.addEventListener('shopify:block:select', () => {
    const root = document.getElementById('avp-root');
    if (root && !root._avpInstance) boot();
  });

  // ─── Widget class ─────────────────────────────────────────────────────────────

  class AVPWidget {
    constructor(root, opts = {}) {
      this.root        = root;
      this.loop        = root.dataset.loop !== 'false';
      this.accentColor = root.dataset.accent || '#667eea';
      this.shop        = (root.dataset.shop || (window.Shopify && window.Shopify.shop) || '').toLowerCase();
      this.autoplay    = false;
      this.skipAutoplay = opts.skipAutoplay || false;

      this.playlist       = [];
      this.currentIndex   = -1;
      this.isPlaying      = false;
      this.isMuted        = false;
      this.panelOpen      = false;
      this.drawerOpen     = false;
      this._progressTimer = null;
      this.nativeEl       = null;

      this.$ = {
        fab:          root.querySelector('#avp-fab'),
        panel:        root.querySelector('#avp-panel'),
        stage:        root.querySelector('#avp-stage'),
        empty:        root.querySelector('#avp-empty'),
        muteToast:    root.querySelector('#avp-mute-toast'),
        overlayInfo:  root.querySelector('#avp-overlay-info'),
        overlayBadge: root.querySelector('#avp-overlay-badge'),
        overlayTitle: root.querySelector('#avp-overlay-title'),
        prev:         root.querySelector('#avp-prev'),
        play:         root.querySelector('#avp-play'),
        next:         root.querySelector('#avp-next'),
        mute:         root.querySelector('#avp-mute'),
        progressBar:  root.querySelector('#avp-progress'),
        progressFill: root.querySelector('#avp-progress-fill'),
        seek:         root.querySelector('#avp-seek'),
        time:         root.querySelector('#avp-time'),
        drawerToggle: root.querySelector('#avp-drawer-toggle'),
        trackList:    root.querySelector('#avp-track-list'),
        fabMusic:     root.querySelector('.avp-fab-icon--music'),
        fabClose:     root.querySelector('.avp-fab-icon--close'),
        fabEqualizer: root.querySelector('#avp-fab-equalizer'),
      };

      this._applyAccent();
      this._bindUI();
      this._updateMuteBtn();
      this._updateFabState();

      // Open panel on page load — unless the user already closed it this session
      this.$.panel.style.transition = 'none';
      let closedThisSession = false;
      try {
        closedThisSession = sessionStorage.getItem('avp-panel-closed') === '1';
      } catch (_) {
        closedThisSession = false;
      }
      if (!closedThisSession) {
        this._togglePanel();   // open by default
      }
      requestAnimationFrame(() => { this.$.panel.style.transition = ''; });

      this._loadPlaylist();
    }

    // ─── Accent ─────────────────────────────────────────────────────────────────────
    _applyAccent() {
      this.root.style.setProperty('--avp-accent', this.accentColor);
    }

    // ─── UI bindings ───────────────────────────────────────────────────────────────
    _bindUI() {
      const { fab, prev, play, next, mute, seek, drawerToggle } = this.$;

      fab.addEventListener('click',          () => this._togglePanel());
      prev.addEventListener('click',         () => this.playPrev());
      next.addEventListener('click',         () => this.playNext());
      play.addEventListener('click',         () => this._togglePlay());
      mute.addEventListener('click',         () => this._toggleMute());
      seek.addEventListener('input',         (e) => this._seek(+e.target.value));
      drawerToggle.addEventListener('click', () => this._toggleDrawer());

      document.addEventListener('keydown', (e) => {
        if (!this.panelOpen) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.code === 'Space')      { e.preventDefault(); this._togglePlay(); }
        if (e.code === 'ArrowRight') { e.preventDefault(); this.playNext(); }
        if (e.code === 'ArrowLeft')  { e.preventDefault(); this.playPrev(); }
        if (e.code === 'KeyM')       { e.preventDefault(); this._toggleMute(); }
      });

      let startX = 0;
      this.$.stage.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
      this.$.stage.addEventListener('touchend',   (e) => {
        const dx = e.changedTouches[0].clientX - startX;
        if (dx < -SWIPE_THRESHOLD) this.playNext();
        else if (dx > SWIPE_THRESHOLD) this.playPrev();
        else this._flashControls();   // tap without swipe → briefly show controls
      }, { passive: true });
    }

    // ─── Flash controls briefly (for touch devices with no hover) ─────────────────
    _flashControls() {
      const ctrl = this.root.querySelector('#avp-overlay-controls');
      if (!ctrl) return;
      clearTimeout(this._flashTimer);
      ctrl.classList.add('avp-overlay-controls--visible');
      this._flashTimer = setTimeout(() => {
        ctrl.classList.remove('avp-overlay-controls--visible');
      }, 3000);
    }

    // ─── Panel toggle ─────────────────────────────────────────────────────────────
    _togglePanel() {
      this.panelOpen = !this.panelOpen;
      const { fab, panel } = this.$;
      panel.classList.toggle('avp-panel--open', this.panelOpen);
      panel.setAttribute('aria-hidden', String(!this.panelOpen));
      fab.setAttribute('aria-expanded', String(this.panelOpen));
      this._updateFabState();

      // Remember user preference for this browser session:
      // closed → don't auto-open on next page navigation
      // opened → clear the flag so future sessions open by default
      if (!this.panelOpen) {
        try { sessionStorage.setItem('avp-panel-closed', '1'); } catch (_) {}
      } else {
        try { sessionStorage.removeItem('avp-panel-closed'); } catch (_) {}
      }
    }

    // ─── Load playlist then autoplay unmuted ─────────────────────────────────────
    async _loadPlaylist() {
      try {
        const shop = this.shop || (window.Shopify && window.Shopify.shop) || '';
        const target = new URL('/apps/playlist/api/media', window.location.origin);
        if (shop) target.searchParams.set('shop', shop);

        let res = await fetch(target.toString(), {
          headers: { 'Accept': 'application/json' },
        });

        // Fail-safe: If Shopify App Proxy returns 404, fall back to direct app API
        if (!res.ok && shop) {
          console.warn('[AVP] App Proxy returned HTTP ' + res.status + ', trying direct fallback...');
          const fallbackUrl = new URL('https://saitriq-entertainment-player.vercel.app/api/media');
          fallbackUrl.searchParams.set('shop', shop);
          res = await fetch(fallbackUrl.toString(), {
            headers: { 'Accept': 'application/json' },
          });
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${body.slice(0, 120)}`);
        }

        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'API error');

        const settings = json.settings || {};
        if (settings.widget_enabled === false) {
          this._teardown();
          this.root.remove();
          return;
        }
        if (['bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(settings.widget_position)) {
          this.root.dataset.position = settings.widget_position;
        }
        if (typeof settings.loop_playlist === 'boolean') {
          this.loop = settings.loop_playlist;
        }
        this.autoplay = settings.autoplay === true;
        if (typeof settings.widget_title === 'string' && settings.widget_title.trim()) {
          const label = this.root.querySelector('.avp-drawer__label');
          if (label) label.textContent = settings.widget_title.trim();
        }

        this.playlist = json.items || [];
        this._renderCards();
        this._renderTrackList();
        this._setTransportEnabled(this.playlist.length > 0);

        if (!this.skipAutoplay && this.autoplay && this.playlist.length > 0) {
          this.isMuted = true;
          this._updateMuteBtn();
          this.playAt(0);
        }
      } catch (err) {
        console.error('[AVP] Could not load playlist:', err.message);
        this._showEmpty('Playlist is temporarily unavailable. Please try again later.');
      }
    }

    // ─── Cards ─────────────────────────────────────────────────────────────────────
    _renderCards() {
      this.$.stage.querySelectorAll('.avp-card').forEach((c) => c.remove());

      if (this.playlist.length === 0) {
        this._showEmpty('No videos in playlist.');
        return;
      }
      this._hideEmpty();

      // Set initial ratio from the first item before any track plays
      this.$.stage.style.setProperty(
        '--avp-stage-ratio',
        this._stageRatioForItem(this.playlist[0]),
      );

      this.playlist.forEach((item, idx) => {
        this.$.stage.appendChild(this._makeCard(item, idx));
      });
      this._stackCards();
    }

    _makeCard(item, idx) {
      const card = document.createElement('div');
      card.className = 'avp-card';
      card.dataset.index = String(idx);
      card.setAttribute('role', 'article');
      card.setAttribute('aria-label', item.title);

      const thumb = item.thumbnailUrl;
      if (thumb) {
        card.style.backgroundImage    = `url('${thumb}')`;
        card.style.backgroundSize     = 'cover';
        card.style.backgroundPosition = 'center';
      }

      const bg = document.createElement('div');
      bg.className = 'avp-card__overlay';
      card.appendChild(bg);

      const media = document.createElement('div');
      media.className = 'avp-card__media';
      media.id = `avp-media-${idx}`;
      card.appendChild(media);

      card.addEventListener('click', () => {
        if (idx !== this.currentIndex) this.playAt(idx);
      });
      return card;
    }

    _stackCards() {
      const base  = this.currentIndex < 0 ? 0 : this.currentIndex;
      const cards = Array.from(this.$.stage.querySelectorAll('.avp-card'));
      cards.forEach((card, i) => {
        const rel = i - base;
        card.classList.remove('avp-card--active', 'avp-card--behind', 'avp-card--hidden');
        if (rel === 0) {
          card.classList.add('avp-card--active');
          card.style.transform = 'translateX(0) rotate(0deg) scale(1)';
          card.style.zIndex    = '10';
          card.style.opacity   = '1';
        } else if (rel > 0 && rel <= STACK_DEPTH) {
          card.classList.add('avp-card--behind');
          const ox = rel * CARD_OFFSET_X, oy = rel * CARD_OFFSET_Y;
          const rot = rel % 2 === 0 ? rel * 1.5 : -rel * 1.5;
          card.style.transform = `translate(${ox}px,${oy}px) rotate(${rot}deg) scale(${1 - rel * 0.03})`;
          card.style.zIndex    = String(10 - rel);
          card.style.opacity   = String(1 - rel * 0.15);
        } else {
          card.classList.add('avp-card--hidden');
          card.style.transform = 'translateX(60px) scale(0.85)';
          card.style.zIndex    = '0';
          card.style.opacity   = '0';
        }
      });
    }

    // ─── Track list ─────────────────────────────────────────────────────────────
    _renderTrackList() {
      const ul = this.$.trackList;
      ul.innerHTML = '';
      this.playlist.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'avp-track';
        li.dataset.index = String(idx);

        const type = document.createElement('span');
        type.className = `avp-track__type avp-track__type--video`;
        type.textContent = '🎬';

        const title = document.createElement('span');
        title.className = 'avp-track__title';
        title.textContent = item.title;

        const dot = document.createElement('span');
        dot.className = 'avp-track__indicator';
        dot.setAttribute('aria-hidden', 'true');

        li.appendChild(type);
        li.appendChild(title);
        li.appendChild(dot);
        li.addEventListener('click', () => this.playAt(idx));
        ul.appendChild(li);
      });
    }

    _highlightTrack() {
      this.$.trackList.querySelectorAll('.avp-track').forEach((li, i) => {
        li.classList.toggle('avp-track--active', i === this.currentIndex);
        if (i === this.currentIndex) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    _toggleDrawer() {
      this.drawerOpen = !this.drawerOpen;
      this.$.trackList.classList.toggle('avp-track-list--open', this.drawerOpen);
      this.$.drawerToggle.setAttribute('aria-expanded', String(this.drawerOpen));
      this.$.drawerToggle.querySelector('.avp-drawer__chevron').style.transform =
        this.drawerOpen ? 'rotate(180deg)' : '';
    }

    // ─── Core playback ─────────────────────────────────────────────────────────────
    async playAt(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;

      this._teardown();
      this.currentIndex = idx;
      const item = this.playlist[idx];

      // Use a platform-appropriate default; direct video files refine it from metadata.
      this.$.stage.style.setProperty(
        '--avp-stage-ratio',
        this._stageRatioForItem(item),
      );

      this._stackCards();
      this._highlightTrack();
      this._setTransportEnabled(true);

      // Update overlay info strip
      if (this.$.overlayInfo) {
        this.$.overlayInfo.style.display = 'flex';
        this.$.overlayBadge.textContent  = '🎬 VIDEO';
        this.$.overlayBadge.className    = 'avp-card__badge avp-card__badge--video';
        this.$.overlayTitle.textContent  = item.title;
      }

      // Shuffle-in card animation
      const activeCard = this.$.stage.querySelector(`.avp-card[data-index="${idx}"]`);
      if (activeCard) {
        activeCard.classList.add('avp-card--shuffle-in');
        activeCard.addEventListener('animationend', () => activeCard.classList.remove('avp-card--shuffle-in'), { once: true });
      }

      try {
        await this._playVideo(item, activeCard);
        // briefly show controls when a track starts
        this._flashControls();
      } catch (err) {
        console.warn('[AVP] playAt error:', err.message);
      }
    }

    playNext() {
      if (!this.playlist.length) return;
      let next = this.currentIndex + 1;
      if (next >= this.playlist.length) {
        if (!this.loop) { this._setPlayState(false); return; }
        next = 0;
      }
      this.playAt(next);
    }

    playPrev() {
      if (!this.playlist.length) return;
      let prev = this.currentIndex - 1;
      if (prev < 0) prev = this.playlist.length - 1;
      this.playAt(prev);
    }

    _togglePlay() {
      if (this.currentIndex === -1) {
        if (this.playlist.length) this.playAt(0);
        return;
      }
      if (this.nativeEl) {
        this.nativeEl.paused
          ? this.nativeEl.play().catch(() => {})
          : this.nativeEl.pause();
      }
    }

    _toggleMute() {
      this.isMuted = !this.isMuted;
      if (this.nativeEl) this.nativeEl.muted = this.isMuted;
      this._updateMuteBtn();
      // Hide the toast as soon as the user unmutes
      if (!this.isMuted) this._hideMuteToast();
    }

    _seek(pct) {
      if (this.nativeEl?.duration) {
        this.nativeEl.currentTime = (pct / 100) * this.nativeEl.duration;
      }
    }

    // ─── Native video (MP4 only) ─────────────────────────────────────────────────
    async _playVideo(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      const video = document.createElement('video');
      video.muted       = this.isMuted;
      video.volume      = 1;
      video.preload     = 'auto';
      video.playsInline = true;
      video.controls    = false;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      this.nativeEl = video;

      video.addEventListener('timeupdate', () => this._tickNative());
      video.addEventListener('ended',      () => {
        if (this.nativeEl === video) this.playNext();
      });
      video.addEventListener('play',       () => this._setPlayState(true));
      video.addEventListener('pause',      () => this._setPlayState(false));
      video.addEventListener('error',      (e) => console.warn('[AVP] video error', e));

      // Detect real dimensions and apply exact aspect ratio to the stage
      video.addEventListener('loadedmetadata', () => {
        if (
          this.nativeEl === video &&
          video.videoWidth &&
          video.videoHeight
        ) {
          this.$.stage.style.setProperty('--avp-stage-ratio', `${video.videoWidth}/${video.videoHeight}`);
        }
      }, { once: true });

      if (mediaEl) {
        mediaEl.innerHTML = '';
        mediaEl.appendChild(video);
      }

      video.src = item.sourceUrl;
      video.load();

      try {
        await video.play();
        this._updateMuteBtn();
        if (this.isMuted) this._showMuteToast();
        else this._hideMuteToast();
      } catch (err) {
        if (err.name === 'NotAllowedError' && !this.isMuted) {
          // Browser blocked unmuted autoplay — retry muted
          console.info('[AVP] Unmuted video autoplay blocked, retrying muted');
          video.muted  = true;
          this.isMuted = true;
          this._updateMuteBtn();
          try {
            await video.play();
            this._showMuteToast();  // playing muted — tell the user
          } catch (err2) {
            // All autoplay blocked — show play button
            console.info('[AVP] All video autoplay blocked:', err2.name);
            video.muted  = false;
            this.isMuted = false;
            this._updateMuteBtn();
            this._setPlayState(false);
          }
        } else {
          console.warn('[AVP] Video play error:', err.message);
          this._setPlayState(false);
        }
      }
    }

    // ─── Progress ─────────────────────────────────────────────────────────────────
    _tickNative() {
      if (!this.nativeEl) return;
      this._updateProgress(this.nativeEl.currentTime, this.nativeEl.duration);
    }

    _updateProgress(cur, dur) {
      const pct = (dur && dur > 0) ? (cur / dur) * 100 : 0;
      this.$.progressFill.style.width = `${pct}%`;
      this.$.seek.value = pct;
      this.$.progressBar.setAttribute('aria-valuenow', Math.round(pct));
      this.$.time.textContent = `${this._fmt(cur)} / ${this._fmt(dur)}`;
    }

    _stopProgress() {
      if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
    }

    // ─── Teardown ───────────────────────────────────────────────────────────────────
    _teardown() {
      this._stopProgress();
      this._setPlayState(false);
      this._updateProgress(0, 0);

      if (this.nativeEl) {
        this.nativeEl.pause();
        this.nativeEl.removeAttribute('src');
        this.nativeEl.load();
        this.nativeEl.remove();
        this.nativeEl = null;
      }

      this.$.stage.querySelectorAll('.avp-card__media').forEach((el) => {
        el.innerHTML = '';
        el.style.display = '';
      });
    }

    // ─── UI helpers ───────────────────────────────────────────────────────────────
    _setPlayState(playing) {
      this.isPlaying = playing;
      this.$.play.querySelector('.avp-play-icon').style.display  = playing ? 'none' : '';
      this.$.play.querySelector('.avp-pause-icon').style.display = playing ? ''     : 'none';
      this.$.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this._updateFabState();
    }

    _updateFabState() {
      const { fab, fabMusic, fabClose, fabEqualizer } = this.$;
      if (!fab) return;

      if (this.panelOpen) {
        if (fabMusic) fabMusic.style.display = 'none';
        if (fabEqualizer) fabEqualizer.style.display = 'none';
        if (fabClose) fabClose.style.display = '';
        fab.classList.remove('avp-fab--playing');
        fab.setAttribute('aria-label', 'Close playlist');
      } else {
        if (fabClose) fabClose.style.display = 'none';
        if (this.isPlaying) {
          if (fabMusic) fabMusic.style.display = 'none';
          if (fabEqualizer) fabEqualizer.style.display = 'flex';
          fab.classList.add('avp-fab--playing');
          fab.setAttribute('aria-label', 'Playing - Open playlist');
        } else {
          if (fabEqualizer) fabEqualizer.style.display = 'none';
          if (fabMusic) fabMusic.style.display = '';
          fab.classList.remove('avp-fab--playing');
          fab.setAttribute('aria-label', 'Open playlist');
        }
      }
    }

    _updateMuteBtn() {
      this.$.mute.querySelector('.avp-vol-icon').style.display  = this.isMuted ? 'none' : '';
      this.$.mute.querySelector('.avp-mute-icon').style.display = this.isMuted ? ''     : 'none';
      this.$.mute.setAttribute('aria-pressed', String(this.isMuted));
      this.$.mute.setAttribute('aria-label', this.isMuted ? 'Unmute' : 'Mute');
    }

    // ─── Mute toast ─────────────────────────────────────────────────────────────
    _showMuteToast() {
      const toast = this.$.muteToast;
      if (!toast) return;
      clearTimeout(this._toastTimer);
      toast.style.display = 'flex';
      // force reflow so transition fires
      void toast.offsetWidth;
      toast.classList.add('avp-mute-toast--visible');
    }

    _hideMuteToast() {
      const toast = this.$.muteToast;
      if (!toast) return;
      clearTimeout(this._toastTimer);
      toast.classList.remove('avp-mute-toast--visible');
      this._toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 350);
    }

    _setTransportEnabled(enabled) {
      ['prev', 'play', 'next'].forEach((k) => { this.$[k].disabled = !enabled; });
    }

    _showEmpty(msg) {
      const el = this.$.empty;
      el.style.display = '';
      el.querySelector('span').textContent = msg;
      el.querySelector('.avp-spinner').style.display = 'none';
    }

    _hideEmpty() { this.$.empty.style.display = 'none'; }

    // ─── URL helpers ─────────────────────────────────────────────────────────────
    _stageRatioForItem(item) {
      // Default to 16:9 for videos
      return '16/9';
    }

    _fmt(seconds) {
      if (!seconds || !isFinite(seconds)) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
  }
})();
