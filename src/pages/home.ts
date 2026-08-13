import { demos, type DemoEntry } from '../demos/registry';
import { HeroStage } from '../hero-stage';

const GITHUB_URL = 'https://github.com/hoainho/img2threejs';
const BASE = import.meta.env.BASE_URL;
const DONATE_URL = `${BASE}donate.html`;

/** Renders the home page and returns a cleanup function that tears down the hero stage. */
export function renderHome(mount: HTMLElement): () => void {
  const firstId = demos[0]?.id ?? '';

  const cards = demos
    .map(
      (demo, i) => `
      <a class="card" href="#/demo/${demo.id}" data-index="${i}" style="--i:${i}">
        <div class="card-media">
          <img class="card-thumb" src="${demo.referenceImage}" alt="${demo.title} reference"
               loading="lazy" onerror="this.classList.add('missing')" />
          <span class="card-status status-${demo.status}">${demo.status}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${demo.title}</div>
          <div class="card-author">by ${demo.author}</div>
          <div class="badges">
            <span class="badge badge-${demo.subjectClass}">${demo.subjectClass}</span>
            <span class="badge">${demo.generatedWith}</span>
          </div>
        </div>
      </a>`,
    )
    .join('');

  mount.innerHTML = `
    <div class="home">
      <div class="aurora" aria-hidden="true"></div>

      <header class="nav">
        <a class="brand" href="#/">
          <img class="brand-mark" src="${BASE}favicon.svg" alt="" width="30" height="30" />
          <span class="brand-name">img2threejs</span>
        </a>
        <div class="nav-actions">
          <a class="nav-donate" href="${DONATE_URL}" target="_blank" rel="noopener noreferrer">
            &#9829; Sponsor
          </a>
          <a class="nav-star" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
            &#9733; Star <span class="nav-label-long">on GitHub</span>
          </a>
        </div>
      </header>

      <section class="hero">
        <div class="hero-copy">
          <span class="hero-eyebrow">live demo gallery &middot; v1.5-beta</span>
          <h1 class="hero-title">
            One photo in.<br />
            A <span class="grad">procedural 3D</span> model out.
          </h1>
          <p class="hero-sub">
            img2threejs rebuilds the object or character in a single reference image as a
            quality-gated, animation-ready Three.js model &mdash; written entirely in code,
            no imported meshes. Everything below is running live in your browser.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" href="#/demo/${firstId}">Explore the demos</a>
            <a class="btn btn-star" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
              &#9733; Star img2threejs
            </a>
          </div>
          <ol class="pipeline" aria-label="how it works">
            <li><span class="pip-num">01</span> Reference photo</li>
            <li class="pip-arrow" aria-hidden="true">&rarr;</li>
            <li><span class="pip-num">02</span> Analyze &amp; spec</li>
            <li class="pip-arrow" aria-hidden="true">&rarr;</li>
            <li><span class="pip-num">03</span> Procedural Three.js</li>
          </ol>
        </div>

        <div class="hero-stage">
          <figure class="stage-input" id="stage-input">
            <img class="stage-photo" id="stage-photo" alt="current demo source reference"
                 onerror="this.closest('.stage-input').classList.add('no-photo')" />
            <figcaption>source photo</figcaption>
          </figure>
          <div class="stage-beam" aria-hidden="true"></div>
          <div class="stage-canvas" id="hero-canvas">
            <span class="stage-badge" id="stage-badge"></span>
            <span class="stage-hint">rebuilt in code</span>
          </div>
        </div>
      </section>

      <section class="gallery">
        <div class="gallery-head">
          <h2>Live reconstructions</h2>
          <p>Each model is generated TypeScript &mdash; orbit it, and read the source it was built from.</p>
        </div>
        <div class="grid">${cards}</div>
      </section>

      <footer class="footer">
        source &middot;
        <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">github.com/hoainho/img2threejs</a>
        &nbsp;&middot;&nbsp;
        <a href="${DONATE_URL}" target="_blank" rel="noopener noreferrer">&#9829; Sponsor this project</a>
      </footer>
    </div>
  `;

  // Entrance animation: reveal on next frame.
  const home = mount.querySelector('.home') as HTMLElement;
  requestAnimationFrame(() => home.classList.add('ready'));

  // Wire the hero 3D stage.
  const canvasMount = mount.querySelector('#hero-canvas') as HTMLElement;
  const photo = mount.querySelector('#stage-photo') as HTMLImageElement;
  const badge = mount.querySelector('#stage-badge') as HTMLElement;
  const cardEls = Array.from(mount.querySelectorAll<HTMLElement>('.card'));

  let stage: HeroStage | null = null;

  const onDemo = (demo: DemoEntry, index: number): void => {
    // Crossfade the source photo to match the demo currently materializing.
    const input = mount.querySelector('#stage-input') as HTMLElement;
    input.classList.remove('no-photo');
    input.classList.add('swapping');
    window.setTimeout(() => {
      photo.src = demo.referenceImage;
      input.classList.remove('swapping');
    }, 260);
    badge.textContent = demo.title;
    cardEls.forEach((el, i) => el.classList.toggle('active', i === index));
  };

  if (demos.length > 0) {
    stage = new HeroStage(canvasMount, demos, onDemo);
    stage.start();
    // Hovering a card jumps the turntable to that demo.
    cardEls.forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const idx = Number(el.dataset.index);
        if (!Number.isNaN(idx)) stage?.focus(idx);
      });
    });
  }

  return () => {
    stage?.dispose();
    stage = null;
  };
}
