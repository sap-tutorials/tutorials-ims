// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SkillTreeMap from '../components/SkillTreeMap.vue';

const twoLessonData = {
  units: [
    {
      id: 'core',
      title: 'Core TLAs',
      icon: '📚',
      order: 1,
      lessons: [
        { id: 'core-1', legacyId: 1, title: 'Lesson 1', acronyms: [], beats: [] },
        { id: 'core-2', legacyId: 2, title: 'Lesson 2', acronyms: [], beats: [] },
      ],
    },
  ],
};

describe('SkillTreeMap', () => {
  it('first lesson is selectable (not is-locked); second is is-locked when mastered=[]', () => {
    const w = mount(SkillTreeMap, {
      props: { lessons: twoLessonData, mastered: [] },
    });
    const node1 = w.find('[data-testid="ktt-node-core-1"]');
    const node2 = w.find('[data-testid="ktt-node-core-2"]');
    expect(node1.exists()).toBe(true);
    expect(node2.exists()).toBe(true);
    expect(node1.classes()).not.toContain('is-locked');
    expect(node2.classes()).toContain('is-locked');
  });

  it('clicking the unlocked first node emits select with its id', async () => {
    const w = mount(SkillTreeMap, {
      props: { lessons: twoLessonData, mastered: [] },
    });
    await w.find('[data-testid="ktt-node-core-1"]').trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0]).toEqual(['core-1']);
  });

  it('clicking a locked node does not emit select', async () => {
    const w = mount(SkillTreeMap, {
      props: { lessons: twoLessonData, mastered: [] },
    });
    await w.find('[data-testid="ktt-node-core-2"]').trigger('click');
    expect(w.emitted('select')).toBeFalsy();
  });

  it('core-2 is unlocked when mastered includes core-1', () => {
    const w = mount(SkillTreeMap, {
      props: { lessons: twoLessonData, mastered: ['core-1'] },
    });
    expect(w.find('[data-testid="ktt-node-core-2"]').classes()).not.toContain('is-locked');
  });

  it('mastered lessons get is-done class', () => {
    const w = mount(SkillTreeMap, {
      props: { lessons: twoLessonData, mastered: ['core-1'] },
    });
    expect(w.find('[data-testid="ktt-node-core-1"]').classes()).toContain('is-done');
  });
});
