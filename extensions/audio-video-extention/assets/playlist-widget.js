/**
 * Audio & Video Playlist Widget — Storefront Player
 *
 * Behaviour:
 *  - Panel opens automatically on page load
 *  - First track plays automatically, unmuted
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

  // ── Boot ──────────────────────────────────────────────────────────────────

  function boot() {
    const root = document.getElementById('avp-root');
    if (!root || root._avpInstance) return;
    root._avpInstance = new AVPWidget(root);
  }

  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

  // ── Widget class ───────────────────────────────────────────────────────────

  class AVPWidget {
    constructor(root) {
      this.root        = root;
      this.shop        = (root.dataset.shop || '').trim();
      this.loop        = root.dataset.loop !== 'false';
      this.accentColor = root.dataset.accent || '#667eea';

      this.playlist       = [];
      this.currentIndex   = -1;
      this.isPlaying      = false;
      this.isMuted        = false;   // always start unmuted
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

      // Open panel on page load — unless the user already closed it this session
      this.$.panel.style.transition = 'none';
      const closedThisSession = sessionStorage.getItem('avp-panel-closed') === '1';
      if (!closedThisSession) {
        this._togglePanel();   // open by default
      }
      requestAnimationFrame(() => { this.$.panel.style.transition = ''; });

      this._loadPlaylist();
    }

    // ── Accent ────────────────────────────────────────────────────────────────
    _applyAccent() {
      this.root.style.setProperty('--avp-accent', this.accentColor);
    }

    // ── UI bindings ───────────────────────────────────────────────────────────
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
      }, { passive: true });
    }

    // ── Panel toggle ──────────────────────────────────────────────────────────
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
      // closed → don't auto-open on next page navigation
      // opened → clear the flag so future sessions open by default
      if (!this.panelOpen) {
        try { sessionStorage.setItem('avp-panel-closed', '1'); } catch (_) {}
      } else {
        try { sessionStorage.removeItem('avp-panel-closed'); } catch (_) {}
      }
    }

    // ── Load playlist then autoplay unmuted ───────────────────────────────────
    async _loadPlaylist() {
      try {
        const res = await fetch('/apps/playlist/api/media', {
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${body.slice(0, 120)}`);
        }
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'API error');

        this.playlist = json.items || [];
        this._renderCards();
        this._renderTrackList();
        this._setTransportEnabled(this.playlist.length > 0);

        // Always autoplay the first track, unmuted
        if (this.playlist.length > 0) {
          this.playAt(0);
        }
      } catch (err) {
        console.error('[AVP] Could not load playlist:', err.message);
        this._showEmpty('Could not load playlist.');
      }
    }

    // ── Cards ─────────────────────────────────────────────────────────────────
    _renderCards() {
      this.$.stage.querySelectorAll('.avp-card').forEach((c) => c.remove());

      if (this.playlist.length === 0) {
        this._showEmpty('No items in playlist.');
        return;
      }
      this._hideEmpty();

      // Set initial ratio from the first item before any track plays
      const first = this.playlist[0];
      const firstIsAudio = first.mediaType === 'audio' && !this._isYouTube(first.sourceUrl) && !this._isTikTok(first.sourceUrl);
      this.$.stage.style.setProperty('--avp-stage-ratio', firstIsAudio ? '1/1' : '16/9');

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
          card.style.cssText += ';transform:translateX(0) rotate(0deg) scale(1);z-index:10;opacity:1;';
        } else if (rel > 0 && rel <= STACK_DEPTH) {
          card.classList.add('avp-card--behind');
          const ox = rel * CARD_OFFSET_X, oy = rel * CARD_OFFSET_Y;
          const rot = rel % 2 === 0 ? rel * 1.5 : -rel * 1.5;
          card.style.cssText += `;transform:translate(${ox}px,${oy}px) rotate(${rot}deg) scale(${1 - rel * 0.03});z-index:${10 - rel};opacity:${1 - rel * 0.15};`;
        } else {
          card.classList.add('avp-card--hidden');
          card.style.cssText += ';transform:translateX(60px) scale(0.85);z-index:0;opacity:0;';
        }
      });
    }

    // ── Track list ────────────────────────────────────────────────────────────
    _renderTrackList() {
      const ul = this.$.trackList;
      ul.innerHTML = '';
      this.playlist.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'avp-track';
        li.dataset.index = String(idx);

        const type = document.createElement('span');
        type.className = `avp-track__type avp-track__type--${item.mediaType}`;
        type.textContent = item.mediaType === 'audio' ? '🎵' : '🎬';

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

    // ── Core playback ─────────────────────────────────────────────────────────
    async playAt(idx) {
      if (idx < 0 || idx >= this.playlist.length) return;

      this._teardown();
      this.currentIndex = idx;
      const item = this.playlist[idx];

      // Set stage aspect ratio to match media type BEFORE rendering
      // video / YouTube / TikTok → 16:9   |   audio → 1:1 (square cover art)
      const isAudio = item.mediaType === 'audio' && !this._isYouTube(item.sourceUrl) && !this._isTikTok(item.sourceUrl);
      this.$.stage.style.setProperty('--avp-stage-ratio', isAudio ? '1/1' : '16/9');

      this._stackCards();
      this._highlightTrack();
      this._setTransportEnabled(true);

      // Update overlay info strip
      if (this.$.overlayInfo) {
        this.$.overlayInfo.style.display = 'flex';
        this.$.overlayBadge.textContent  = (item.mediaType === 'audio' ? '🎵 ' : '🎬 ') + item.mediaType.toUpperCase();
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
        if      (this._isYouTube(item.sourceUrl)) await this._playYT(item, activeCard);
        else if (this._isTikTok(item.sourceUrl))  await this._playTikTok(item, activeCard);
        else if (item.mediaType === 'video')       await this._playVideo(item, activeCard);
        else                                       await this._playAudio(item);
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

    // ── Native audio ──────────────────────────────────────────────────────────
    async _playAudio(item) {
      const audio = new Audio();
      audio.preload     = 'auto';
      audio.muted       = false;    // always start unmuted
      audio.crossOrigin = 'anonymous';
      this.nativeEl     = audio;

      audio.addEventListener('timeupdate', () => this._tickNative());
      audio.addEventListener('ended',      () => this.playNext());
      audio.addEventListener('play',       () => this._setPlayState(true));
      audio.addEventListener('pause',      () => this._setPlayState(false));
      audio.addEventListener('error',      (e) => console.warn('[AVP] audio error', e));

      audio.src = item.sourceUrl;

      try {
        await audio.play();
        // Success — ensure UI reflects unmuted
        this.isMuted = false;
        this._updateMuteBtn();
        this._hideMuteToast();
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          // Browser blocked unmuted autoplay — retry muted
          console.info('[AVP] Unmuted autoplay blocked, retrying muted');
          audio.muted  = true;
          this.isMuted = true;
          this._updateMuteBtn();
          try {
            await audio.play();
            this._showMuteToast();  // playing muted — tell the user
          } catch (err2) {
            // All autoplay blocked — show play button, keep unmuted preference
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

    // ── Native video ──────────────────────────────────────────────────────────
    async _playVideo(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      const video = document.createElement('video');
      video.muted       = false;    // always start unmuted
      video.preload     = 'auto';
      video.playsInline = true;
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      this.nativeEl = video;

      video.addEventListener('timeupdate', () => this._tickNative());
      video.addEventListener('ended',      () => this.playNext());
      video.addEventListener('play',       () => this._setPlayState(true));
      video.addEventListener('pause',      () => this._setPlayState(false));
      video.addEventListener('error',      (e) => console.warn('[AVP] video error', e));

      if (mediaEl) {
        mediaEl.innerHTML = '';
        mediaEl.appendChild(video);
      }

      video.src = item.sourceUrl;

      try {
        await video.play();
        // Success — ensure UI reflects unmuted
        this.isMuted = false;
        this._updateMuteBtn();
        this._hideMuteToast();
      } catch (err) {
        if (err.name === 'NotAllowedError') {
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

    // ── YouTube ───────────────────────────────────────────────────────────────
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
      div.style.cssText = 'width:100%;height:100%;';
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
            controls:       1,
            modestbranding: 1,
            rel:            0,
            playsinline:    1,
            enablejsapi:    1,
            origin:         window.location.origin,
            mute:           0,   // always start unmuted
          },
          events: {
            onReady: (e) => {
              clearTimeout(timer);
              resolved = true;
              // Ensure unmuted — YouTube sometimes ignores mute:0
              try { e.target.unMute(); e.target.setVolume(100); } catch (_) {}
              this.isMuted = false;
              this._updateMuteBtn();
              e.target.playVideo();
              this._setPlayState(true);
              this._startYTProgress();
              resolve();
            },
            onStateChange: ({ data }) => {
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

    // ── TikTok ────────────────────────────────────────────────────────────────
    async _playTikTok(item, cardEl) {
      const mediaEl = cardEl?.querySelector('.avp-card__media') ?? null;
      if (mediaEl) mediaEl.style.display = 'block';

      let embedUrl = '';
      try {
        const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(item.sourceUrl)}`);
        const j = await r.json();
        const m = j.html?.match(/src="([^"]+)"/);
        if (m) embedUrl = m[1];
      } catch (_) {}

      if (!embedUrl) {
        const id = this._tikTokId(item.sourceUrl);
        if (id) embedUrl = `https://www.tiktok.com/embed/v2/${id}`;
      }
      if (!embedUrl) return;

      const iframe = document.createElement('iframe');
      iframe.src   = embedUrl;
      iframe.allow = 'autoplay; fullscreen';
      iframe.setAttribute('allowfullscreen', '');
      iframe.style.cssText = 'width:100%;height:100%;border:none;';
      if (mediaEl) { mediaEl.innerHTML = ''; mediaEl.appendChild(iframe); }
      this.tiktokIframe = iframe;
      this._setPlayState(true);
      this._updateProgress(0, 0);
    }

    // ── Progress ──────────────────────────────────────────────────────────────
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

    // ── Teardown ──────────────────────────────────────────────────────────────
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

    // ── UI helpers ────────────────────────────────────────────────────────────
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

    // ── Mute toast ────────────────────────────────────────────────────────────
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

    // ── URL helpers ───────────────────────────────────────────────────────────
    _isYouTube(url) { return /youtube\.com|youtu\.be/i.test(url); }
    _isTikTok(url)  { return /tiktok\.com/i.test(url); }

    _ytId(url) {
      const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }

    _tikTokId(url) {
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
