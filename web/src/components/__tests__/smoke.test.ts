import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

const Hello = defineComponent({ render: () => h('div', `hello ${1 + 1}`) });

describe('web test chain', () => {
  it('mounts and renders', () => {
    const w = mount(Hello);
    expect(w.text()).toBe('hello 2');
  });
});
