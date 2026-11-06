export function initTableEnhance(): void {
  const tables = document.querySelectorAll<HTMLTableElement>('table.sortable, table.filterable, table.sticky');
  tables.forEach(table => {
    const classes = table.classList;
    if (classes.contains('sortable')) initSortable(table);
    if (classes.contains('filterable')) initFilterable(table);
    if (classes.contains('sticky')) table.querySelector('thead')?.querySelectorAll('th').forEach(th => {
      th.style.position = 'sticky';
      th.style.top = '0';
    });
  });
}

function initSortable(table: HTMLTableElement): void {
  const thead = table.querySelector('thead');
  if (!thead) return;
  const ths = Array.from(thead.querySelectorAll('th'));
  ths.forEach((th, colIndex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = th.textContent ?? '';
    btn.setAttribute('aria-sort', 'none');
    th.textContent = '';
    th.appendChild(btn);
    btn.addEventListener('click', () => {
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const asc = btn.getAttribute('aria-sort') !== 'ascending';
      // Reset all buttons
      ths.forEach(t => t.querySelector('button')?.setAttribute('aria-sort', 'none'));
      btn.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
      rows.sort((a, b) => {
        const aText = a.cells[colIndex]?.textContent?.trim() ?? '';
        const bText = b.cells[colIndex]?.textContent?.trim() ?? '';
        const aNum = Number(aText);
        const bNum = Number(bText);
        const numeric = !isNaN(aNum) && !isNaN(bNum) && aText !== '' && bText !== '';
        const cmp = numeric ? aNum - bNum : aText.localeCompare(bText);
        return asc ? cmp : -cmp;
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

function initFilterable(table: HTMLTableElement): void {
  const thead = table.querySelector('thead');
  if (!thead) return;
  const input = document.createElement('input');
  input.type = 'search';
  input.setAttribute('aria-label', 'Filter table');
  if (table.id) input.setAttribute('aria-controls', table.id);
  input.placeholder = 'Filter…';
  table.parentNode?.insertBefore(input, table);
  input.addEventListener('input', () => {
    const val = input.value.toLowerCase();
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(row => {
      const text = row.textContent?.toLowerCase() ?? '';
      (row as HTMLElement).style.display = text.includes(val) ? '' : 'none';
    });
  });
}
