/**
 * Audio & Video Playlist Widget â€” Storefront Player
 *
 * Behaviour:
 *  - Panel opens automatically on page load
 *  - Autoplay follows the merchant setting and starts muted
 *  - If browser blocks unmuted autoplay, retries muted (browser policy)
 *  - If browser blocks all autoplay, shows play button for user to tap
 *  - YouTube, TikTok, native MP4 video, native MP3 audio all supported
 *  - Card shuffle / stacked-card UI with swipe support
 */

(function () {
  'use strict';

  const CARD_OFFSET_X   = 8;
  const CARD_OFFSET_Y   = 6;
  const STACK_DEPTH     = 3;
  const SWIPE_THRESHOLD = 55;

  // â”€â”€ Detect Shopify theme editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // window.Shopify.designMode is true when the page is loaded inside the
  // theme customiser iframe. We skip autoplay and avoid re-init on section
  // reload events.
  const IN_EDITOR = !!(window.Shopify && window.Shopify.designMode);

  // â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function boot() {
    const root = document.getElementById('avp-root');
    if (!root) return;

    // Teardown any existing instance before creating a new one.
    // This handles the theme editor's section:load event which re-injects
    // the block HTML but keeps the same JS context â€” without teardown a
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

  // â”€â”€ Widget class â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class AVPWidget {
    constructor(root, opts = {}) {
      this.root        = root;
      this.loop        = root.dataset.loop !== 'false';
      this.accentColor = root.dataset.accent || '#667eea';
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
      this.ytPlayer       = null;
      this.tiktokIframe   = null;

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
      };

      this._applyAccent();
      this._bindUI();
      this._updateMuteBtn();

      // Open panel on page load â€” unless the user already closed it this session
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

    // â”€â”€ Accent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _applyAccent() {
      this.root.style.setProperty('--avp-accent', this.accentColor);
    }

    // â”€â”€ UI bindings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        else this._flashControls();   // tap without swipe â†’ briefly show controls
      }, { passive: true });
    }

    // â”€â”€ Flash controls briefly (for touch devices with no hover) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _flashControls() {
      const ctrl = this.root.querySelector('#avp-overlay-controls');
      if (!ctrl) return;
      clearTimeout(this._flashTimer);
      ctrl.classList.add('avp-overlay-controls--visible');
      this._flashTimer = setTimeout(() => {
        ctrl.classList.remove('avp-overlay-controls--visible');
      }, 3000);
    }

    // â”€â”€ Panel toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _togglePanel() {
      this.panelOpen = !this.panelOpen;
      const { fab, panel } = this.$;
      panel.classList.toggle('avp-panel--open', this.panelOpen);
      panel.setAttribute('aria-hidden', String(!this.panelOpen));
      fab.setAttribute('aria-expanded', String(this.panelOpen));
      fab.setAttribute('aria-label', this.panelOpen ? 'Close playlist' : 'Open playlist');
      fab.querySelector('.avp-fab-icon--music').style.display = this.panelOpen ? 'none' : '';
      fab.querySelector('.avp-fab-icon--close').style.display = this.panelOpen ? ''     : 'none';

      // Remember user preference for this browser session:
      // closed â†’ don't auto-open on next page navigation
      // opened â†’ clear the flag so future sessions open by default
      if (!this.panelOpen) {
        try { sessionStorage.setItem('avp-panel-closed', '1'); } catch (_) {}
      } else {
        try { sessionStorage.removeItem('avp-panel-closed'); } catch (_) {}
      }
    }

    // â”€â”€ Load playlist then autoplay unmuted â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async _loadPlaylist() {
      try {
        // Shopify adds and signs the app-proxy query parameters, including shop.
        const target = new URL('/apps/playlist/api/media', window.location.origin);

        const res = await fetch(target.toString(), {
          headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} â€” ${body.slice(0, 120)}`);
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

    // â”€â”€ Cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _renderCards() {
      this.$.stage.querySelectorAll('.avp-card').forEach((c) => c.remove());

      if (this.playlist.length === 0) {
        this._showEmpty('No items in playlist.');
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

      const thumb = item.thumbnailUrl || this._autoThumb(item);
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

    _autoThumb(item) {
      if (this._isYouTube(item.sourceUrl)) {
        const id = this._ytId(item.sourceUrl);
        return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : '';
      }
      return '';
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

    // â”€â”€ Track list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _renderTrackList() {
      const ul = this.$.trackList;
      ul.innerHTML = '';
      this.playlist.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'avp-track';
        li.dataset.index = String(idx);

        const type = document.createElement('span');
        type.className = `avp-track__type avp-track__type--${item.mediaType}`;
        type.textContent = item.mediaType === 'audio' ? 'ðŸŽµ' : 'ðŸŽ¬';

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

    // â”€â”€ Core playback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async playAt(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;

      this._teardown();
      this.currentIndex = idx;
      const item = this.playlist[idx];
      const usesProviderControls = this._isTikTok(item.sourceUrl)
        || this._isFacebook(item.sourceUrl)
        || this._isInstagram(item.sourceUrl);
      this.root.classList.toggle('avp-root--provider-player', usesProviderControls);

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
        this.$.overlayBadge.textContent  = (item.mediaType === 'audio' ? 'ðŸŽµ ' : 'ðŸŽ¬ ') + item.mediaType.toUpperCase();
        this.$.overlayBadge.className    = `avp-card__badge avp-card__badge--${item.mediaType}`;
        this.$.overlayTitle.textContent  = item.title;
      }

      // Shuffle-in card animation
      const activeCard = this.$.stage.querySelector(`.avp-card[data-index="${idx}"]`);
      if (activeCard) {
        activeCard.classList.add('avp-card--shuffle-in');
        activeCard.addEventListener('animationend', () => activeCard.classList.remove('avp-card--shuffle-in'), { once: true });
      }

      try {
        if      (this._isYouTube(item.sourceUrl))   await this._playYT(item, activeCard);
        else if (this._isTikTok(item.sourceUrl))    await this._playTikTok(item, activeCard);
        else if (this._isFacebook(item.sourceUrl))  await this._playFacebook(item, activeCard);
        else if (this._isInstagram(item.sourceUrl)) await this._playInstagram(item, activeCard);
        else if (item.mediaType === 'video')         await this._playVideo(item, activeCard);
        else                                         await this._playAudio(item);
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
      if (this.ytPlayer) {
        try {
          this.ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
            ? this.ytPlayer.pauseVideo()
            : this.ytPlayer.playVideo();
        } catch (_) {}
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
      if (this.ytPlayer) {
        try { this.isMuted ? this.ytPlayer.mute() : this.ytPlayer.unMute(); } catch (_) {}
      }
      this._updateMuteBtn();
      // Hide the toast as soon as the user unmutes
      if (!this.isMuted) this._hideMuteToast();
    }

    _seek(pct) {
      if (this.nativeEl?.duration) {
        this.nativeEl.currentTime = (pct / 100) * this.nativeEl.duration;
      } else if (this.ytPlayer) {
        try {
          const dur = this.ytPlayer.getDuration();
          if (dur) this.ytPlayer.seekTo((pct / 100) * dur, true);
        } catch (_) {}
      }
    }

    // â”€â”€ Native audio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async _playAudio(item) {
      const audio = new Audio();
      audio.preload     = 'auto';
      audio.volume      = 1;
      audio.muted       = this.isMuted;
      this.nativeEl     = audio;

      audio.addEventListener('timeupdate', () => this._tickNative());
      audio.addEventListener('ended',      () => {
        if (this.nativeEl === audio) this.playNext();
      });
      audio.addEventListener('play',       () => this._setPlayState(true));
      audio.addEventListener('pause',      () => this._setPlayState(false));
      audio.addEventListener('error',      (e) => console.warn('[AVP] audio error', e));

      audio.src = item.sourceUrl;

      try {
        await audio.play();
        this._updateMuteBtn();
        if (this.isMuted) this._showMuteToast();
        else this._hideMuteToast();
      } catch (err) {
        if (err.name === 'NotAllowedError' && !this.isMuted) {
          // Browser blocked unmuted autoplay â€” retry muted
          console.info('[AVP] Unmuted autoplay blocked, retrying muted');
          audio.muted  = true;
          this.isMuted = true;
          this._updateMuteBtn();
          try {
            await audio.play();
            this._showMuteToast();  // playing muted â€” tell the user
          } catch (err2) {
            // All autoplay blocked â€” show play button, keep unmuted preference
            console.info('[AVP] All autoplay blocked:', err2.name);
            audio.muted  = false;
            this.isMuted = false;
            this._updateMuteBtn();
            this._setPlayState(false);
          }
        } else {
          console.warn('[AVP] Audio play error:', err.message);
          this._setPlayState(false);
        }
      }
    }

    // â”€â”€ Native video â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          // Browser blocked unmuted autoplay â€” retry muted
          console.info('[AVP] Unmuted video autoplay blocked, retrying muted');
          video.muted  = true;
          this.isMuted = true;
          this._updateMuteBtn();
          try {
            await video.play();
            this._showMuteToast();  // playing muted â€” tell the user
          } catch (err2) {
            // All autoplay blocked â€” show play button
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

    // â”€â”€ YouTube â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async _playYT(item, cardEl) {
      const videoId = this._ytId(item.sourceUrl);
      if (!videoId) return;

      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) {
        mediaEl.innerHTML = '';
        mediaEl.style.display = 'block';
      }

      const divId = `avp-yt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const div   = document.createElement('div');
      div.id      = divId;
      // pointer-events none so our overlay controls stay clickable over the iframe
      div.style.cssText = 'width:100%;height:100%;pointer-events:none;';
      (mediaEl || this.$.stage).appendChild(div);

      await this._loadYTApi();

      return new Promise((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) reject(new Error('YouTube player timed out'));
        }, 15000);

        this.ytPlayer = new YT.Player(divId, {
          videoId,
          width:  '100%',
          height: '100%',
          playerVars: {
            autoplay:       1,
            controls:       0,   // hide YouTube controls
            modestbranding: 1,   // hide YouTube logo
            rel:            0,   // no related videos at end
            showinfo:       0,   // hide title bar
            iv_load_policy: 3,   // hide video annotations
            disablekb:      1,   // disable keyboard shortcuts (we handle them)
            playsinline:    1,
            enablejsapi:    1,
            origin:         window.location.origin,
            mute:           this.isMuted ? 1 : 0,
          },
          events: {
            onReady: (e) => {
              clearTimeout(timer);
              resolved = true;
              try {
                e.target.setVolume(100);
                if (this.isMuted) e.target.mute();
                else e.target.unMute();
              } catch (_) {}
              this._updateMuteBtn();
              e.target.playVideo();
              this._setPlayState(true);
              this._startYTProgress();
              resolve();
            },
            onStateChange: ({ data, target }) => {
              if (target !== this.ytPlayer) return;
              if      (data === YT.PlayerState.PLAYING) { this._setPlayState(true);  this._startYTProgress(); }
              else if (data === YT.PlayerState.PAUSED)  { this._setPlayState(false); this._stopProgress(); }
              else if (data === YT.PlayerState.ENDED)   { this._setPlayState(false); this._stopProgress(); this.playNext(); }
            },
            onError: (e) => {
              clearTimeout(timer);
              this._stopProgress();
              console.warn('[AVP] YouTube error code:', e.data);
              if (!resolved) { resolved = true; reject(new Error(`YT error ${e.data}`)); }
            },
          },
        });
      });
    }

    _loadYTApi() {
      if (window.YT?.Player) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
        if (existing) {
          const prev = window.onYouTubeIframeAPIReady;
          window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
          return;
        }
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement('script');
        s.src     = 'https://www.youtube.com/iframe_api';
        s.onerror = () => reject(new Error('Failed to load YT API'));
        document.head.appendChild(s);
      });
    }

    _startYTProgress() {
      this._stopProgress();
      this._progressTimer = setInterval(() => {
        if (!this.ytPlayer) return;
        try {
          this._updateProgress(this.ytPlayer.getCurrentTime(), this.ytPlayer.getDuration());
        } catch (_) {}
      }, 500);
    }

    // â”€â”€ TikTok â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async _playTikTok(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      const embedUrl = this._tikTokEmbedUrl(item.sourceUrl);
      if (!embedUrl) {
        console.warn('[AVP] Could not build TikTok embed URL for:', item.sourceUrl);
        return;
      }

      const iframe = document.createElement('iframe');
      iframe.src = embedUrl;
      iframe.allow = 'autoplay; fullscreen';
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
      iframe.style.cssText = 'width:100%;height:100%;border:none;pointer-events:auto;';
      if (mediaEl) { mediaEl.innerHTML = ''; mediaEl.appendChild(iframe); }
      this.tiktokIframe = iframe;
      this._setPlayState(false);
      this._updateProgress(0, 0);
    }

    // â”€â”€ Facebook Video / Reel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /**
     * Embeds any Facebook video or reel URL using Facebook's official
     * plugins/video endpoint. Works for:
     *  - facebook.com/reel/1234567890
     *  - facebook.com/watch/?v=1234567890
     *  - facebook.com/video/1234567890
     *  - fb.watch/XXXXX short links
     *
     * Note: Facebook's embed player has its own play button â€” we show the
     * iframe and let the customer press play inside it (FB's autoplay is
     * blocked by most browsers and requires domain registration).
     */
    async _playFacebook(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      // Facebook's official oembed/plugin iframe â€” accepts any FB video URL
      const embedUrl =
        `https://www.facebook.com/plugins/video.php` +
        `?href=${encodeURIComponent(item.sourceUrl)}` +
        `&show_text=false` +
        `&autoplay=false` +
        `&mute=false` +
        `&width=auto`;

      const iframe = document.createElement('iframe');
      iframe.src   = embedUrl;
      iframe.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share';
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('scrolling', 'no');
      iframe.style.cssText = 'width:100%;height:100%;border:none;overflow:hidden;pointer-events:auto;';

      if (mediaEl) {
        mediaEl.innerHTML = '';
        mediaEl.appendChild(iframe);
      }

      this.tiktokIframe = iframe; // reuse the same teardown handle
      this._setPlayState(false);
      this._updateProgress(0, 0);
    }

    // â”€â”€ Instagram Reels / Videos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /**
     * Embeds any Instagram reel or video URL using Instagram's oEmbed iframe.
     *
     * Supported formats:
     *  - instagram.com/reel/SHORTCODE/
     *  - instagram.com/p/SHORTCODE/
     *  - instagram.com/tv/SHORTCODE/
     *
     * Instagram's embed iframe requires the page to load the Instagram embed.js
     * script OR uses the direct /embed/ URL. We use the direct embed URL so no
     * external script injection is needed.
     *
     * Note: Instagram restricts embeds to domains registered in Meta for
     * Developers. On unregistered domains the iframe shows a login prompt.
     * This is a Meta platform limitation â€” not something the app can bypass.
     */
    async _playInstagram(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      // Extract the shortcode from any Instagram reel/post/tv URL
      const shortcode = this._igShortcode(item.sourceUrl);
      if (!shortcode) {
        console.warn('[AVP] Could not parse Instagram shortcode from:', item.sourceUrl);
        return;
      }

      // Direct embed URL â€” works without the Instagram JS SDK
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

      const iframe = document.createElement('iframe');
      iframe.src   = embedUrl;
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('scrolling', 'no');
      // Instagram embeds are designed for a 400px+ width; scale to fit our panel
      iframe.style.cssText = 'width:100%;height:100%;border:none;overflow:hidden;pointer-events:auto;';

      if (mediaEl) {
        mediaEl.innerHTML = '';
        mediaEl.appendChild(iframe);
      }

      this.tiktokIframe = iframe; // reuse the same teardown handle
      this._setPlayState(false);
      this._updateProgress(0, 0);
    }

    /** Extract the shortcode from any Instagram URL variant */
    _igShortcode(url) {
      // Matches /reel/CODE, /p/CODE, /tv/CODE â€” with or without trailing slash
      const m = url.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i);
      return m ? m[1] : null;
    }

    /** Build a TikTok embed URL that handles ALL URL formats:
     *  - Short links:  tiktok.com/t/XXXXXXX
     *  - Long links:   tiktok.com/@user/video/1234567890
     *  - vm links:     vm.tiktok.com/XXXXXXX
     *
     *  TikTok's /embed/v2 endpoint accepts the full original URL as a ?url= param,
     *  which means it handles redirects itself â€” no browser-side resolution needed.
     */
    _tikTokEmbedUrl(url) {
      if (!url) return null;
      const clean = url.trim();

      // Try to extract a numeric video ID first (long-form URL)
      const idMatch = clean.match(/\/video\/(\d{10,})/);
      if (idMatch) {
        return `https://www.tiktok.com/embed/v2/${idMatch[1]}`;
      }

      // For short links (tiktok.com/t/XXX) and vm.tiktok.com/XXX:
      // Pass the full URL to TikTok's embed endpoint â€” it resolves the redirect itself
      if (/tiktok\.com/i.test(clean)) {
        return `https://www.tiktok.com/embed/v2?url=${encodeURIComponent(clean)}&referrer=${encodeURIComponent(window.location.origin)}`;
      }

      return null;
    }

    // â”€â”€ Progress â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Teardown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _teardown() {
      this._stopProgress();
      this.root.classList.remove('avp-root--provider-player');
      this._setPlayState(false);
      this._updateProgress(0, 0);

      if (this.nativeEl) {
        this.nativeEl.pause();
        this.nativeEl.removeAttribute('src');
        this.nativeEl.load();
        this.nativeEl.remove();
        this.nativeEl = null;
      }
      if (this.ytPlayer) {
        try { this.ytPlayer.stopVideo(); this.ytPlayer.destroy(); } catch (_) {}
        this.ytPlayer = null;
      }
      if (this.tiktokIframe) {
        this.tiktokIframe.remove();
        this.tiktokIframe = null;
      }

      this.$.stage.querySelectorAll('.avp-card__media').forEach((el) => {
        el.innerHTML = '';
        el.style.display = '';
      });
    }

    // â”€â”€ UI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _setPlayState(playing) {
      this.isPlaying = playing;
      this.$.play.querySelector('.avp-play-icon').style.display  = playing ? 'none' : '';
      this.$.play.querySelector('.avp-pause-icon').style.display = playing ? ''     : 'none';
      this.$.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    _updateMuteBtn() {
      this.$.mute.querySelector('.avp-vol-icon').style.display  = this.isMuted ? 'none' : '';
      this.$.mute.querySelector('.avp-mute-icon').style.display = this.isMuted ? ''     : 'none';
      this.$.mute.setAttribute('aria-pressed', String(this.isMuted));
      this.$.mute.setAttribute('aria-label', this.isMuted ? 'Unmute' : 'Mute');
    }

    // â”€â”€ Mute toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ URL helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _stageRatioForItem(item) {
      const url = item.sourceUrl;
      if (
        item.mediaType === 'audio' &&
        !this._isYouTube(url) &&
        !this._isTikTok(url) &&
        !this._isFacebook(url) &&
        !this._isInstagram(url)
      ) {
        return '1/1';
      }
      if (
        this._isTikTok(url) ||
        (this._isInstagram(url) && /\/reel\//i.test(url)) ||
        (this._isFacebook(url) && /\/reel\//i.test(url))
      ) {
        return '9/16';
      }
      return '16/9';
    }

    _isYouTube(url)   { return /youtube\.com|youtu\.be/i.test(url); }
    _isTikTok(url)    { return /tiktok\.com/i.test(url); }
    _isFacebook(url)  { return /facebook\.com|fb\.watch/i.test(url); }
    _isInstagram(url) { return /instagram\.com/i.test(url); }

    _ytId(url) {
      const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }

    _tikTokId(url) {
      // Legacy â€” kept for reference. Use _tikTokEmbedUrl() instead.
      const m = url.match(/\/video\/(\d+)/);
      return m ? m[1] : null;
    }

    _fmt(sec) {
      if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    }
  }

  window.AVPWidget = AVPWidget;
})();
