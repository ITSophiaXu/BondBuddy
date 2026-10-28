// Synthetic interactive reference. No API, model, persistence or billing calls.
const list = document.querySelector('#review-project-list');
const rows = [...list.children];
const action = document.querySelector('#continue-review');
const summary = document.querySelector('#project-entry-selection');
const status = document.querySelector('#review-entry-status');
const more = document.querySelector('#review-project-more');
const scroll = document.querySelector('.project-picker-scroll');
list.addEventListener('change', event => {
  if (!event.target.matches('input[type=radio]')) return;
  summary.textContent = '已选：' + event.target.closest('label').querySelector('strong').textContent;
  action.disabled = false;
  status.textContent = '';
});
document.querySelector('#review-project-search').addEventListener('submit', event => {
  event.preventDefault();
  const q = document.querySelector('#review-project-query').value.trim();
  for (const row of rows) { row.hidden = !row.textContent.includes(q); row.querySelector('input').checked = false; }
  for (const row of [...list.children].slice(rows.length)) row.remove();
  summary.textContent = '请选择一个项目'; action.disabled = true;
  status.textContent = rows.every(row => row.hidden) ? '暂无匹配项目，可新建项目开始。' : '';
  more.hidden = !!q; scroll.scrollTop = 0;
});
more.addEventListener('click', () => {
  rows.forEach((row, i) => {
    const clone = row.cloneNode(true); clone.hidden = false;
    clone.querySelector('strong').textContent = `示例项目 ${i + 21}`;
    const input = clone.querySelector('input'); input.value = `synthetic-entry-${i + 21}`; input.checked = false;
    list.append(clone);
  });
  more.hidden = true;
});
action.addEventListener('click', () => status.textContent = '设计预览：将打开所选项目的文件生成页面。');
document.querySelector('#project-entry-new').addEventListener('click', () => status.textContent = '设计预览：将进入新建项目页面。');
document.querySelector('#toggle-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.add('mobile-open'));
document.querySelector('#close-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.remove('mobile-open'));
document.querySelectorAll('a, #logout, .ba-dock').forEach(el => el.addEventListener('click', event => {
  event.preventDefault(); status.textContent = '当前为项目选择设计预览。';
}));
