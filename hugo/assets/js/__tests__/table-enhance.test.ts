// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
});

describe('table-enhance', () => {
  it('adds aria-sort button to sortable table headers', async () => {
    document.body.innerHTML = `
      <table class="sortable">
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>B</td><td>2</td></tr><tr><td>A</td><td>1</td></tr></tbody>
      </table>`;
    const { initTableEnhance } = await import('../table-enhance.js');
    initTableEnhance();
    const btn = document.querySelector('th button');
    expect(btn).not.toBeNull();
    expect(document.querySelector('[aria-sort]')).not.toBeNull();
  });

  it('adds filter input above filterable table', async () => {
    document.body.innerHTML = `
      <table class="filterable">
        <thead><tr><th>Item</th></tr></thead>
        <tbody><tr><td>HANA</td></tr><tr><td>BTP</td></tr></tbody>
      </table>`;
    const { initTableEnhance } = await import('../table-enhance.js');
    initTableEnhance();
    expect(document.querySelector('input[type="search"]')).not.toBeNull();
  });

  it('sorting numerically sorts rows', async () => {
    document.body.innerHTML = `
      <table class="sortable">
        <thead><tr><th>Num</th></tr></thead>
        <tbody>
          <tr><td>10</td></tr>
          <tr><td>2</td></tr>
          <tr><td>20</td></tr>
        </tbody>
      </table>`;
    const { initTableEnhance } = await import('../table-enhance.js');
    initTableEnhance();
    const btn = document.querySelector('th button') as HTMLButtonElement;
    btn.click();
    const cells = Array.from(document.querySelectorAll('tbody td')).map(td => td.textContent);
    expect(cells).toEqual(['2', '10', '20']);
  });

  it('does not touch tables without sortable/filterable class', async () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody><tr><td>A</td></tr></tbody>
      </table>`;
    const { initTableEnhance } = await import('../table-enhance.js');
    initTableEnhance();
    expect(document.querySelector('th button')).toBeNull();
  });
});
