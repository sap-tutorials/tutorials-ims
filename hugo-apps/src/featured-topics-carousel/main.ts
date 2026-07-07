import { createApp } from 'vue';
import Carousel from './Carousel.vue';

interface SlideData {
  conceptSlug: string;
  displayTitle: string;
  missionsHtml: string;
}

function readInitialFromDom(root: HTMLElement): SlideData[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.hp-featured-carousel__slide')).map((el) => ({
    conceptSlug: el.id.replace(/^featured-/, ''),
    displayTitle: el.querySelector('.hp-featured-carousel__topic')?.textContent?.trim() || '',
    missionsHtml: el.querySelector('.hp-featured-carousel__grid')?.innerHTML || '',
  }));
}

const roots = document.querySelectorAll<HTMLElement>('[data-app="featured-topics-carousel"]');
roots.forEach((root) => {
  const etag = root.getAttribute('data-etag') || '';
  const initialSlides = readInitialFromDom(root);
  // Clear SSR inner content before Vue mounts to avoid double-rendering.
  // Vue will re-render the same DOM structure reactively.
  const viewport = root.querySelector('.hp-featured-carousel__viewport');
  const controls = root.querySelector('.hp-featured-carousel__controls');
  if (viewport) viewport.innerHTML = '';
  if (controls) controls.innerHTML = '';
  createApp(Carousel, { root, initialEtag: etag, initialSlides }).mount(root);
});
