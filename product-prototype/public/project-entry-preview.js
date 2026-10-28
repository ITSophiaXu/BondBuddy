// Synthetic interactive reference. No API, model, persistence or billing calls.
const view = new URLSearchParams(location.search).get('view') ?? 'generate';
const variants = {
  review: { title: '复核募集书', english: 'PROSPECTUS REVIEW', description: '先选择项目，复用募集书和核验材料，生成带修订痕迹的复核成果。', steps: ['选择项目', '材料与要求', '复核结果'], action: '下一步：材料与要求' },
  qa: { title: '项目问答', english: 'PROJECT Q&A', description: '先确认本项目募集说明书，再上传问题清单。结合项目资料逐题回答，缺少的材料会逐项列明。', steps: ['确认项目资料', '确认问题', '回答与补件'], action: '下一步：确认项目资料' },
  update: { title: '更新募集书', english: 'PROSPECTUS WORKSPACE', description: '有原稿可更新，没有原稿也可根据发行人材料编制首稿。', steps: [], action: '进入更新募集书' },
};
const variant = variants[view];
if (variant) {
  const page = document.querySelector('.project-entry-page');
  const heading = page.querySelector('.page-head');
  heading.querySelector('h1').textContent = variant.title;
  heading.querySelector('.eyebrow').textContent = variant.english;
  heading.querySelector('p:not(.eyebrow)').textContent = variant.description;
  document.querySelector('.breadcrumb span:last-child').textContent = variant.title;
  document.querySelectorAll('.nav-item').forEach(link => link.classList.toggle('active', link.textContent.trim() === variant.title));
  page.querySelector('#continue-review').textContent = variant.action;
  if (variant.steps.length) {
    const stepper = document.createElement('nav');
    stepper.className = 'stepper'; stepper.setAttribute('aria-label', variant.title + '流程');
    stepper.innerHTML = variant.steps.map((label, i) => (i ? '<span class="step-line"></span>' : '') + '<span class="step ' + (i ? '' : 'current') + '"' + (i ? '' : ' aria-current="step"') + '><b>' + (i + 1) + '</b>' + label + '</span>').join('');
    heading.after(stepper);
  }
  if (view === 'update') {
    page.classList.add('project-entry-update');
    heading.querySelector('#project-entry-new').remove();
    const primary = document.createElement('section'); primary.className = 'update-entry-primary';
    primary.innerHTML = '<div class="update-entry-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H5v20h14V7h-5ZM12 11v6M9 14h6"></path></svg></div><div><p class="eyebrow">开始新一期工作</p><h2>新建项目，准备募集书</h2><p>先保存项目，再添加材料和要求。各轮成果保留，后续可在同一项目继续修改。</p><a href="#" class="btn primary">＋ 新建项目</a></div>';
    heading.after(primary);
    const picker = page.querySelector('.project-picker');
    picker.classList.remove('update-entry-existing', 'review-panel'); picker.querySelector('h2').remove();
    const details = document.createElement('details'); details.className = 'update-entry-existing';
    details.innerHTML = '<summary>继续已有项目 <span>已有项目的材料与填写内容可继续使用</span></summary>';
    picker.replaceWith(details); details.append(picker);
  }
}
const list = document.querySelector('#review-project-list');
const rows = [...list.children];
const action = document.querySelector('#continue-review');
const summary = document.querySelector('#project-entry-selection');
const status = document.querySelector('#review-entry-status');
const more = document.querySelector('#review-project-more');
const scroll = document.querySelector('.project-picker-scroll');
rows.forEach(row => row.querySelector('input').checked = false);
action.disabled = true;
summary.textContent = '请选择一个项目';
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
action.addEventListener('click', () => status.textContent = '设计预览：将打开所选项目的' + (variant?.title ?? '文件生成') + '页面。');
document.querySelector('#project-entry-new')?.addEventListener('click', () => status.textContent = '设计预览：将进入新建项目页面。');
document.querySelector('#toggle-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.add('mobile-open'));
document.querySelector('#close-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.remove('mobile-open'));
document.querySelectorAll('a, #logout, .ba-dock').forEach(el => el.addEventListener('click', event => {
  event.preventDefault(); status.textContent = '当前为项目选择设计预览。';
}));
