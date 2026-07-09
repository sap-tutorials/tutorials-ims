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

  // Vue's `createApp(...).mount(el)` REPLACES el.innerHTML with the
  // component's render output. The SSR-emitted <h2>Featured missions</h2>
  // and Browse-all link live inside the <section>, so a direct mount on
  // the section wiped them from the DOM on hydration. Mount instead into
  // a dedicated [data-vue-root] child so the header survives.
  //
  // We also drop the SSR viewport + controls (Vue re-renders them) but
  // keep the header intact.
  const header = root.querySelector('.hp-featured-carousel__header');
  const viewport = root.querySelector('.hp-featured-carousel__viewport');
  const controls = root.querySelector('.hp-featured-carousel__controls');
  if (viewport) viewport.remove();
  if (controls) controls.remove();

  let target = root.querySelector<HTMLElement>('[data-vue-root]');
  if (!target) {
    target = document.createElement('div');
    target.setAttribute('data-vue-root', '');
    // Insert AFTER the header so the visual order matches the SSR paint.
    if (header && header.parentElement === root) {
      header.insertAdjacentElement('afterend', target);
    } else {
      root.appendChild(target);
    }
  }

  createApp(Carousel, { root, initialEtag: etag, initialSlides }).mount(target);
});
