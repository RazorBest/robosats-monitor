/**
 * 2005 Vaporwave Winamp Audio Player Controller
 * Pure native HTML5 Audio playback (zero external APIs / zero dependencies).
 * Loads static local MP3 files on-demand only when the user clicks Play.
 */

(function () {
    const PLAYLIST = [
        { file: '/audio/track1.mp3', title: '01. Street Lights Passing Me By - HolzinaCC0' },
        { file: '/audio/track2.mp3', title: '02. A Night Of Dizzy Spells - Eric Skiff' },
        { file: '/audio/track3.mp3', title: '03. Underclocked - Eric Skiff' }
    ];

    let currentTrackIndex = 0;
    let audio = null;

    function getCurrentTrack() {
        return PLAYLIST[currentTrackIndex];
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function updateTimer(timeStr) {
        const timerEl = document.getElementById('winampTimer');
        if (timerEl) {
            timerEl.textContent = timeStr;
        }
    }

    function updateTitle(text) {
        const titleEl = document.getElementById('winampTitle');
        const wrapperEl = document.getElementById('winampTitleWrapper');
        if (!titleEl) return;

        titleEl.textContent = text;
        titleEl.classList.remove('is-overflowing');

        // Check if text content width exceeds wrapper container
        if (wrapperEl && titleEl.scrollWidth > wrapperEl.clientWidth + 2) {
            titleEl.classList.add('is-overflowing');
        }
    }

    function setEqualizerState(isPlaying) {
        const eqEl = document.getElementById('winampEq');
        const boxEl = document.getElementById('winampBox');
        if (eqEl) {
            eqEl.classList.toggle('is-playing', isPlaying);
        }
        if (boxEl) {
            boxEl.classList.toggle('is-playing', isPlaying);
        }
    }

    function updateButtons(activeState) {
        const playBtn = document.getElementById('winampPlayBtn');
        const pauseBtn = document.getElementById('winampPauseBtn');
        const stopBtn = document.getElementById('winampStopBtn');

        if (playBtn) playBtn.classList.toggle('active', activeState === 'play');
        if (pauseBtn) pauseBtn.classList.toggle('active', activeState === 'pause');
        if (stopBtn) stopBtn.classList.toggle('active', activeState === 'stop');
    }

    function getOrCreateAudio() {
        if (!audio) {
            audio = new Audio();
            audio.preload = 'none';

            audio.addEventListener('timeupdate', () => {
                updateTimer(formatTime(audio.currentTime));
            });

            audio.addEventListener('play', () => {
                setEqualizerState(true);
                updateTitle(getCurrentTrack().title);
                updateButtons('play');
            });

            audio.addEventListener('pause', () => {
                setEqualizerState(false);
                if (audio.currentTime > 0 && !audio.ended) {
                    updateTitle(`[PAUSED] ${getCurrentTrack().title}`);
                    updateButtons('pause');
                }
            });

            audio.addEventListener('ended', () => {
                nextTrack();
            });

            audio.addEventListener('error', () => {
                setEqualizerState(false);
                updateTitle(`[FILE NOT FOUND] Place MP3 in /public/audio/`);
                updateButtons('stop');
            });
        }
        return audio;
    }

    function playTrackIndex(index) {
        currentTrackIndex = (index + PLAYLIST.length) % PLAYLIST.length;
        const track = getCurrentTrack();
        const player = getOrCreateAudio();

        player.src = track.file;
        updateTimer('00:00');
        updateTitle(`LOADING: ${track.title}`);

        player.play().catch(() => {
            updateTitle(`[CLICK PLAY] ${track.title}`);
            updateButtons('pause');
        });
    }

    function play() {
        const player = getOrCreateAudio();
        if (!player.src || player.src.endsWith('#') || player.ended) {
            playTrackIndex(currentTrackIndex);
        } else {
            player.play().catch(() => {});
        }
    }

    function pause() {
        if (audio) {
            audio.pause();
        }
    }

    function stop() {
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
        setEqualizerState(false);
        updateTimer('00:00');
        updateTitle('CLICK > TO PLAY');
        updateButtons('stop');
    }

    function nextTrack() {
        playTrackIndex(currentTrackIndex + 1);
    }

    function prevTrack() {
        if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        } else {
            playTrackIndex(currentTrackIndex - 1);
        }
    }

    function bindEvents() {
        const playBtn = document.getElementById('winampPlayBtn');
        const pauseBtn = document.getElementById('winampPauseBtn');
        const stopBtn = document.getElementById('winampStopBtn');
        const prevBtn = document.getElementById('winampPrevBtn');
        const nextBtn = document.getElementById('winampNextBtn');
        const display = document.getElementById('winampDisplay');

        if (playBtn) playBtn.addEventListener('click', play);
        if (pauseBtn) pauseBtn.addEventListener('click', pause);
        if (stopBtn) stopBtn.addEventListener('click', stop);
        if (prevBtn) prevBtn.addEventListener('click', prevTrack);
        if (nextBtn) nextBtn.addEventListener('click', nextTrack);
        if (display) display.addEventListener('click', play);

        updateTitle('CLICK > TO PLAY');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEvents);
    } else {
        bindEvents();
    }
})();
