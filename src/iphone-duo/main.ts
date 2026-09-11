import {
  createIphoneDuoScene,
  type IphoneDuoFinish,
  type IphoneDuoScreen,
  type IphoneDuoProvider,
  type IphoneDuoSceneController,
  type IphoneDuoSceneDiagnostics,
  type IphoneDuoSceneState,
  type IphoneDuoView,
} from './scene';
import type { IphoneDuoReleaseSequence, IphoneDuoAnimationState } from './scene';
import { IPHONE_DUO_FINISH_PALETTES, isIphoneDuoFinish } from './palette';

declare global {
  interface Window {
    __iphoneDuo?: {
      inspect: () => IphoneDuoSceneDiagnostics;
      setFold: (degrees: number) => void;
      setFinish: (finish: IphoneDuoFinish) => void;
      setScreen: (screen: IphoneDuoScreen) => void;
      setProvider: (provider: IphoneDuoProvider) => Promise<void>;
      play: () => void;
      pause: () => void;
      replay: () => void;
      seek: (time: number) => void;
      setSequence: (sequence: IphoneDuoReleaseSequence) => void;
      setLoop: (loop: boolean) => void;
      setVfx: (enabled: boolean) => void;
    };
  }
}

const PROVIDER_COPY: Record<IphoneDuoProvider, { loading: string; ready: string; caption: string }> = {
  articulated: {
    loading: 'Loading the Apple reference model…',
    ready: 'img2threejs showcase ready · play the release sequence or drag to inspect',
    caption: 'img2threejs interactive study · Apple source geometry',
  },
  hyper3d: {
    loading: 'Loading the Hyper3D study…',
    ready: 'Hyper3D study ready · not approved for fidelity',
    caption: 'Hyper3D / Rodin · multiview generation · reference mismatch. Screen and rear-camera details are mixed.',
  },
};

const unavailableDiagnostics = (): IphoneDuoSceneDiagnostics => ({
  fold: 0,
  finish: 'white',
  screen: 'desert',
  provider: 'articulated',
  ready: false,
  articulated: false,
  loading: false,
  error: 'The interactive study has not initialized.',
  finishMix: 0,
  finishWeights: {
    white: 1,
    night: 0,
    sage: 0,
    sand: 0,
    coral: 0,
    lavender: 0,
  },
  finishPalette: {
    label: IPHONE_DUO_FINISH_PALETTES.white.label,
    hex: IPHONE_DUO_FINISH_PALETTES.white.hex,
    study: IPHONE_DUO_FINISH_PALETTES.white.study,
  },
  finishTransitioning: false,
  animation: {
    sequence: 'display',
    time: 0,
    duration: 3,
    playing: false,
    loop: false,
    vfxEnabled: true,
  },
  contextLost: false,
  renderer: {
    available: false,
    info: { triangles: 0, calls: 0, points: 0, lines: 0 },
    triangles: 0,
    width: 0,
    height: 0,
    pixelRatio: 1,
  },
  errors: ['The interactive study has not initialized.'],
});

function isProvider(value: string | undefined): value is IphoneDuoProvider {
  return value === 'articulated' || value === 'hyper3d';
}

function isView(value: string | undefined): value is IphoneDuoView {
  return value === 'reset' || value === 'front' || value === 'back' || value === 'orbit';
}

function isScreen(value: string | undefined): value is IphoneDuoScreen {
  return value === 'desert' || value === 'architecture';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function boot(): void {
  const stage = document.querySelector<HTMLElement>('#duo-stage');
  const loading = document.querySelector<HTMLElement>('#stage-loading');
  const error = document.querySelector<HTMLElement>('#stage-error');
  const errorMessage = document.querySelector<HTMLElement>('#stage-error-message');
  const retry = document.querySelector<HTMLButtonElement>('#stage-retry');
  const stageState = document.querySelector<HTMLElement>('#stage-state');
  const stageCaption = document.querySelector<HTMLElement>('#stage-caption');
  const studyNote = document.querySelector<HTMLElement>('#study-note');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
  const finishButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-finish]'));
  const screenButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-screen]'));
  const providerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-provider]'));
  const sequenceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sequence]'));
  const releasePlay = document.querySelector<HTMLButtonElement>('#release-play');
  const releaseReplay = document.querySelector<HTMLButtonElement>('#release-replay');
  const releaseSeek = document.querySelector<HTMLInputElement>('#release-seek');
  const releaseLoop = document.querySelector<HTMLInputElement>('#release-loop');
  const releaseVfx = document.querySelector<HTMLButtonElement>('#release-vfx');
  const releaseTime = document.querySelector<HTMLOutputElement>('#release-time');
  const releaseGroup = document.querySelector<HTMLElement>('.release-group');
  const filmVideos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));

  if (!stage || !loading || !error || !errorMessage || !retry || !stageState || !stageCaption || !studyNote) return;

  const sequenceDurations: Record<IphoneDuoReleaseSequence, number> = { display: 3, hinge: 3.133 };
  const formatTime = (value: number): string => {
    const safe = Math.max(0, Number.isFinite(value) ? value : 0);
    const minutes = Math.floor(safe / 60);
    const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  };

  let controller: IphoneDuoSceneController | null = null;
  let currentState: IphoneDuoSceneState = {
    fold: 0,
    finish: 'white',
    screen: 'desert',
    provider: 'articulated',
    ready: false,
    articulated: false,
    loading: true,
    error: null,
  };

  const updateAnimationControls = (animation: IphoneDuoAnimationState): void => {
    const enabled = currentState.provider === 'articulated' && currentState.articulated && currentState.ready && !currentState.loading;
    if (releaseGroup) releaseGroup.dataset.disabled = String(!enabled);
    [releasePlay, releaseReplay, releaseSeek, releaseLoop, releaseVfx].forEach((control) => {
      if (control) control.disabled = !enabled;
    });
    sequenceButtons.forEach((button) => {
      const active = button.dataset.sequence === animation.sequence;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !enabled;
    });
    if (releasePlay) {
      releasePlay.textContent = animation.playing ? 'Pause' : 'Play';
      releasePlay.setAttribute('aria-label', animation.playing ? 'Pause release sequence' : 'Play release sequence');
    }
    if (releaseSeek) {
      releaseSeek.max = String(animation.duration);
      releaseSeek.value = String(animation.time);
      releaseSeek.disabled = !enabled;
    }
    if (releaseLoop) releaseLoop.checked = animation.loop;
    if (releaseVfx) {
      releaseVfx.textContent = animation.vfxEnabled ? 'VFX on' : 'VFX off';
      releaseVfx.classList.toggle('is-active', animation.vfxEnabled);
      releaseVfx.setAttribute('aria-pressed', String(animation.vfxEnabled));
    }
    if (releaseTime) releaseTime.value = `${formatTime(animation.time)} / ${formatTime(animation.duration)}`;
  };

  const setStudyNote = (state: IphoneDuoSceneState): void => {
    if (state.loading) {
      studyNote.innerHTML = `<span class="study-note-mark" aria-hidden="true"></span><span>${PROVIDER_COPY[state.provider].loading}</span><a href="#explore">Return to canvas <span aria-hidden="true">↑</span></a>`;
    } else if (state.error) {
      studyNote.innerHTML = `<span class="study-note-mark is-error" aria-hidden="true"></span><span>Study unavailable · ${escapeHtml(state.error)}</span><a href="#explore">Return to canvas <span aria-hidden="true">↑</span></a>`;
    } else if (state.provider === 'articulated') {
      const palette = IPHONE_DUO_FINISH_PALETTES[state.finish];
      const finishLabel = palette.study
        ? `${palette.label} · ${palette.hex} · local color study`
        : `${palette.label} finish`;
      studyNote.innerHTML = `<span class="study-note-mark" aria-hidden="true"></span><span>img2threejs showcase active · ${escapeHtml(finishLabel)}.</span><a href="#explore">Return to canvas <span aria-hidden="true">↑</span></a>`;
    } else {
      studyNote.innerHTML = `<span class="study-note-mark" aria-hidden="true"></span><span>${PROVIDER_COPY[state.provider].ready} · Static model for inspection only.</span><a href="#explore">Return to canvas <span aria-hidden="true">↑</span></a>`;
    }
  };

  const updateControls = (state: IphoneDuoSceneState): void => {
    const finishEnabled = state.provider === 'articulated' && state.articulated && state.ready && !state.loading;
    finishButtons.forEach((button) => {
      const active = button.dataset.finish === state.finish;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
      button.disabled = !finishEnabled;
    });
    screenButtons.forEach((button) => {
      const active = button.dataset.screen === state.screen;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
      button.disabled = !finishEnabled;
    });
    providerButtons.forEach((button) => {
      const active = button.dataset.provider === state.provider;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
      button.disabled = state.loading;
    });
    stage.dataset.provider = state.provider;
    stage.dataset.ready = String(state.ready);
    stage.dataset.articulated = String(state.articulated);
    stage.dataset.finishPreset = state.finish;
    stage.dataset.screenPreset = state.screen;
    stageCaption.textContent = PROVIDER_COPY[state.provider].caption;
  };

  const onStateChange = (state: IphoneDuoSceneState): void => {
    currentState = state;
    updateControls(state);
    updateAnimationControls(controller?.inspect().animation ?? {
      sequence: 'display',
      time: 0,
      duration: sequenceDurations.display,
      playing: false,
      loop: false,
      vfxEnabled: true,
    });
    setStudyNote(state);
    if (state.loading) {
      loading.hidden = false;
      error.hidden = true;
      stageState.textContent = PROVIDER_COPY[state.provider].loading;
    } else if (state.error) {
      loading.hidden = true;
      error.hidden = false;
      errorMessage.textContent = state.error;
      stageState.textContent = 'The requested study could not be displayed.';
    } else if (state.ready) {
      loading.hidden = true;
      error.hidden = true;
      stageState.textContent = PROVIDER_COPY[state.provider].ready;
    }
  };

  const debugApi = {
    inspect: (): IphoneDuoSceneDiagnostics => controller?.inspect() ?? unavailableDiagnostics(),
      setFold: (degrees: number): void => controller?.setFold(degrees),
      setFinish: (finish: IphoneDuoFinish): void => controller?.setFinish(finish),
      setScreen: (screen: IphoneDuoScreen): void => controller?.setScreen(screen),
      setProvider: (provider: IphoneDuoProvider): Promise<void> => controller?.setProvider(provider) ?? Promise.resolve(),
      play: (): void => controller?.play(),
      pause: (): void => controller?.pause(),
      replay: (): void => controller?.replay(),
      seek: (time: number): void => controller?.seek(time),
      setSequence: (sequence: IphoneDuoReleaseSequence): void => controller?.setSequence(sequence),
      setLoop: (loop: boolean): void => controller?.setLoop(loop),
      setVfx: (enabled: boolean): void => controller?.setVfx(enabled),
    };
  window.__iphoneDuo = debugApi;

  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (isView(view)) controller?.setView(view);
    });
  });

  finishButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const finish = button.dataset.finish;
      if (isIphoneDuoFinish(finish)) controller?.setFinish(finish);
    });
  });

  screenButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const screen = button.dataset.screen;
      if (isScreen(screen)) controller?.setScreen(screen);
    });
  });

  providerButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const provider = button.dataset.provider;
      if (!isProvider(provider)) return;
      void controller?.setProvider(provider);
    });
  });

  retry.addEventListener('click', () => {
    void controller?.retry();
  });

  releasePlay?.addEventListener('click', () => {
    const animation = controller?.inspect().animation;
    if (animation?.playing) controller?.pause();
    else controller?.play();
  });
  releaseReplay?.addEventListener('click', () => controller?.replay());
  releaseSeek?.addEventListener('input', () => {
    const time = Number(releaseSeek.value);
    if (Number.isFinite(time)) controller?.seek(time);
  });
  releaseLoop?.addEventListener('change', () => controller?.setLoop(releaseLoop.checked));
  releaseVfx?.addEventListener('click', () => {
    const enabled = !(controller?.inspect().animation.vfxEnabled ?? true);
    controller?.setVfx(enabled);
  });
  sequenceButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const sequence = button.dataset.sequence;
      if (sequence === 'display' || sequence === 'hinge') controller?.setSequence(sequence);
    });
  });

  const applyMotionPreference = (): void => {
    controller?.setReducedMotion(motionQuery.matches);
    document.documentElement.dataset.motion = motionQuery.matches ? 'reduced' : 'full';
    filmVideos.forEach((video) => {
      if (motionQuery.matches) {
        if (!video.paused) {
          video.dataset.pausedByMotion = 'true';
          video.pause();
        }
      } else if (video.dataset.pausedByMotion === 'true') {
        delete video.dataset.pausedByMotion;
        void video.play().catch(() => undefined);
      }
    });
  };
  motionQuery.addEventListener?.('change', applyMotionPreference);

  try {
    controller = createIphoneDuoScene({
      container: stage,
      reducedMotion: motionQuery.matches,
      onLoading: (provider) => {
        stageState.textContent = PROVIDER_COPY[provider].loading;
      },
      onReady: onStateChange,
      onStateChange,
      onAnimationChange: updateAnimationControls,
      onError: (message) => {
        errorMessage.textContent = message;
      },
    });
    applyMotionPreference();
  } catch (sceneError) {
    const message = sceneError instanceof Error ? sceneError.message : 'The interactive study could not be initialized.';
    onStateChange({ ...currentState, loading: false, error: message });
    errorMessage.textContent = message;
  }

  window.addEventListener('pagehide', () => controller?.dispose(), { once: true });
}

boot();
