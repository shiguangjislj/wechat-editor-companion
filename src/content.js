(function () {
  'use strict';
  const testMode = Boolean(window.__WXH_TEST__);
  const query = new URLSearchParams(location.search);
  const videoPage = query.get('action') === 'video_edit' || (query.get('t') || '').includes('videomsg_edit') || Boolean(window.__WXH_VIDEO_TEST__);
  const targetPage = location.hostname === 'mp.weixin.qq.com' && location.pathname.includes('/cgi-bin/appmsg') && (location.search.includes('appmsg_edit') || query.get('action') === 'edit' || videoPage);
  if (!testMode && !targetPage) return;
  if (document.querySelector('[data-wxh-ui="root"]')) return;

  const adapter = globalThis.WXHAdapter;
  if (!adapter) return;
  const KEY = 'wxh_v1_settings';
  const initialStyle = { bodySize: 16, headingSize: 20, bodyColor: '#3f4a4c', headingColor: '#ffffff', bodyBg: '#ffffff', headingBg: '#141917', align: 'left', headingAlign: 'left' };
  const initialImage = { radius: 12, shadow: 'soft', border: 'none', align: 'center' };
  const state = {
    view: 'home', open: false, editor: null, blocks: [], images: [],
    style: { ...initialStyle }, imageStyle: { ...initialImage },
    templates: [{ name: '常用黑白标题', style: { ...initialStyle } }],
    imageSelection: new Set(), imagesInitialized: false, videoQueue: [], batchState: null,
    layout: null, textSnapshot: null, imageSnapshot: null, textMonitorStop: null, imageMonitorStop: null,
    imageApplying: false, imageUndoing: false,
    notice: '', noticeTone: 'neutral'
  };
  const storage = {
    async get() {
      if (globalThis.chrome?.storage?.local && !testMode) return (await chrome.storage.local.get(KEY))[KEY] || {};
      try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; }
    },
    async set(value) {
      if (globalThis.chrome?.storage?.local && !testMode) return chrome.storage.local.set({ [KEY]: value });
      localStorage.setItem(KEY, JSON.stringify(value));
    }
  };

  const root = document.createElement('div');
  root.dataset.wxhUi = 'root';
  document.documentElement.appendChild(root);
  const shadow = root.attachShadow({ mode: 'open' });
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = testMode ? '../src/panel.css' : chrome.runtime.getURL('src/panel.css');
  shadow.appendChild(css);
  if (!testMode && 'adoptedStyleSheets' in shadow) {
    fetch(css.href).then(response => response.text()).then(source => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(source);
      shadow.adoptedStyleSheets = [sheet];
      css.remove();
    }).catch(() => { /* Keep the linked stylesheet as a fallback. */ });
  }
  const ball = document.createElement('button');
  ball.className = 'ball';
  ball.type = 'button';
  ball.setAttribute('aria-label', '打开公众号排版助手，拖动可移动');
  ball.innerHTML = '<span class="spark">✦</span><span class="ball-label">排版助手</span>';
  shadow.appendChild(ball);
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('aria-label', '公众号排版助手面板');
  panel.innerHTML = '<header class="panel-bar" id="dragBar"><span class="brand">✦</span><span><span class="brand-name">排版助手</span><span class="brand-sub" style="display:block">拖动顶部可移动面板</span></span><span class="grip" aria-hidden="true">⋮⋮</span><button class="icon-button" type="button" data-action="close" aria-label="关闭面板">×</button></header><div class="panel-body" id="body"></div><footer class="panel-footer" id="footer"></footer><div class="resize" id="resize" role="separator" aria-label="拖动调整面板大小" tabindex="0"></div>';
  shadow.appendChild(panel);
  const body = shadow.querySelector('#body');
  const footer = shadow.querySelector('#footer');
  let openingNativeVideoPage = false;

  function defaultLayout() {
    return {
      ball: { x: Math.max(8, innerWidth - 82), y: Math.max(8, innerHeight - 82) },
      panel: { x: Math.max(8, innerWidth - 418), y: 36, w: 390, h: Math.min(620, Math.max(390, innerHeight - 72)) }
    };
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(value, Math.max(min, max))); }
  function normalizeLayout() {
    const layout = state.layout || defaultLayout();
    layout.panel.w = clamp(Number(layout.panel.w) || 390, 340, Math.max(340, innerWidth - 16));
    layout.panel.h = clamp(Number(layout.panel.h) || 600, 390, Math.max(390, innerHeight - 16));
    layout.panel.x = clamp(Number(layout.panel.x) || 8, 8, innerWidth - layout.panel.w - 8);
    layout.panel.y = clamp(Number(layout.panel.y) || 8, 8, innerHeight - layout.panel.h - 8);
    layout.ball.x = clamp(Number(layout.ball.x) || 8, 8, innerWidth - 66);
    layout.ball.y = clamp(Number(layout.ball.y) || 8, 8, innerHeight - 66);
    state.layout = layout;
    ball.style.left = `${layout.ball.x}px`;
    ball.style.top = `${layout.ball.y}px`;
    panel.style.left = `${layout.panel.x}px`;
    panel.style.top = `${layout.panel.y}px`;
    panel.style.width = `${layout.panel.w}px`;
    panel.style.height = `${layout.panel.h}px`;
  }
  function persist() {
    return storage.set({ layout: state.layout, templates: state.templates })
      .catch(() => notice('本地设置保存失败，请检查浏览器存储权限。', 'error'));
  }
  function setOpen(value) {
    state.open = value;
    panel.classList.toggle('open', value);
    ball.classList.toggle('hidden', value);
    if (value) render();
  }
  function notice(message, tone = 'neutral') {
    state.notice = message;
    state.noticeTone = tone;
    const box = body.querySelector('#notice');
    if (box) { box.textContent = message; box.className = `status ${tone}`; }
  }
  function scan() {
    state.editor = adapter.findEditor(document);
    state.blocks = adapter.collectBlocks(state.editor);
    state.images = adapter.collectImages(state.editor);
    state.imageSelection = new Set([...state.imageSelection].filter(index => index < state.images.length));
    if (!state.imagesInitialized) { state.images.forEach((_, index) => state.imageSelection.add(index)); state.imagesInitialized = true; }
    return Boolean(state.editor);
  }
  function pageTitle() {
    const input = document.querySelector('input[placeholder*="标题"],textarea[placeholder*="标题"]');
    return input?.value?.trim() || '当前图文草稿';
  }
  function button(label, action, cls = 'ghost', disabled = false) { return `<button type="button" class="btn ${cls}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`; }
  function back() { return '<button type="button" class="back" data-action="home">← 返回功能首页</button>'; }
  function field(label, key, type, min, max) { return `<div class="field"><label for="wxh-${key}">${label}</label><input id="wxh-${key}" data-style="${key}" type="${type}" ${min !== undefined ? `min="${min}" max="${max}"` : ''}></div>`; }
  function waitForNativeControl(find, timeoutMs = 4500) {
    return new Promise(resolve => {
      const end = Date.now() + timeoutMs;
      const check = () => {
        const node = find();
        if (node || Date.now() >= end) return resolve(node || null);
        setTimeout(check, 80);
      };
      check();
    });
  }
  async function openNativeVideoUpload() {
    if (videoPage || openingNativeVideoPage) return;
    openingNativeVideoPage = true;
    try {
      let upload = adapter.findNativeVideoButton(document, '本地上传');
      if (!upload) {
        let library = adapter.findNativeVideoLibraryTab(document);
        if (!library) {
          const toolbarVideo = adapter.findNativeToolbarVideoButton(document);
          if (!toolbarVideo) return notice('未找到正文工具栏的“视频”。请手动点击“视频→素材库→本地上传”。', 'warn');
          notice('正在打开视频素材库…', 'neutral');
          toolbarVideo.click();
          // WeChat may render the picker asynchronously after the toolbar click.
          const control = await waitForNativeControl(() =>
            adapter.findNativeVideoButton(document, '本地上传') || adapter.findNativeVideoLibraryTab(document));
          if (!control) return notice('未识别到视频素材库弹窗。请手动选择“视频→素材库→本地上传”。', 'warn');
          upload = adapter.findNativeVideoButton(document, '本地上传');
          library = adapter.findNativeVideoLibraryTab(document);
        }
        if (!upload && library) {
          library.click();
          upload = await waitForNativeControl(() => adapter.findNativeVideoButton(document, '本地上传'));
        }
      }
      if (!upload) return notice('未找到“本地上传”按钮。请在视频弹窗中手动切到“素材库”并点击“本地上传”。', 'warn');
      // Use WeChat's own click handler to open its upload page; never infer a URL.
      void persist();
      upload.click();
      notice('已点击“本地上传”；请在打开的页面继续操作。', 'neutral');
    } catch (error) {
      notice(`进入本地上传失败：${error.message}`, 'error');
    } finally {
      openingNativeVideoPage = false;
    }
  }
  function render() {
    scan();
    body.replaceChildren();
    footer.replaceChildren();
    if (state.view === 'home') renderHome();
    else if (state.view === 'text') renderText();
    else if (state.view === 'images') renderImages();
    else if (state.view === 'videos') renderVideos();
    body.scrollTop = 0;
  }
  function renderHome() {
    const headings = state.blocks.filter(block => block.heading).length;
    body.innerHTML = `<div class="eyebrow">WECHAT EDITOR COMPANION</div><h2 class="title">少做重复编辑</h2><p class="desc" id="draftName"></p><div class="status ${state.editor ? '' : 'warn'}" id="notice"></div><div class="counts"><div><b>${headings}</b><small>小标题</small></div><div><b>${Math.max(0, state.blocks.length - headings)}</b><small>正文</small></div><div><b>${state.images.length}</b><small>图片</small></div></div><button class="task green" data-action="text"><span class="task-icon">Aa</span><span><b>批量排版文字</b><small>字号、字色、背景和模板</small></span><span class="arrow">›</span></button><button class="task blue" data-action="images"><span class="task-icon">▧</span><span><b>统一处理图片</b><small>圆角、阴影、对齐与描边</small></span><span class="arrow">›</span></button><button class="task orange" data-action="videos"><span class="task-icon">▷</span><span><b>批量上传视频</b><small>一次选文件，逐条核验入库</small></span><span class="arrow">›</span></button><div class="tip">悬浮球和面板都可拖动；拖动面板右下角可改变大小。样式写入后仍需用公众号原生保存并重新打开核对。</div>`;
    body.querySelector('#draftName').textContent = videoPage ? '当前是公众号独立视频上传页' : `正在处理：${pageTitle()}`;
    if (videoPage) {
      body.querySelector('[data-action="text"]').disabled = true;
      body.querySelector('[data-action="images"]').disabled = true;
    }
    notice(videoPage ? '视频助手已在本地上传页启用；打开“批量上传视频”继续。' : state.editor ? (state.notice || '已识别编辑区，可直接选择下面的功能。') : '当前未识别到可编辑正文。请先在公众号编辑器中打开图文并粘贴文章。', videoPage || state.editor ? state.noticeTone : 'warn');
    footer.innerHTML = button('收起面板', 'close', 'ghost');
  }
  function renderText() {
    const headingCount = state.blocks.filter(block => block.heading).length;
    body.innerHTML = `${back()}<div class="eyebrow">01 / TYPOGRAPHY</div><h2 class="title">批量排版文字</h2><p class="desc">原位修改已粘贴文章中的文字节点，不重新生成整篇文章。</p><div id="notice" class="status"></div><div class="section-title">正文样式</div><div class="grid">${field('字号','bodySize','number',12,24)}${field('文字颜色','bodyColor','color')}${field('背景颜色','bodyBg','color')}<div class="field"><label for="wxh-align">对齐方式</label><select id="wxh-align" data-style="align"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></div></div><div class="section-title">小标题样式 <small>${headingCount}处已识别</small></div><div class="grid">${field('字号','headingSize','number',14,32)}${field('文字颜色','headingColor','color')}${field('文字背景颜色','headingBg','color')}<div class="field"><label for="wxh-headingAlign">对齐方式</label><select id="wxh-headingAlign" data-style="headingAlign"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></div></div><details><summary class="section-title" style="cursor:pointer">标记小标题 <small>普通段落需人工确认</small></summary><div class="check-list" id="blockList"></div></details><div class="section-title">我的模板</div><div class="pill-list" id="templateList"></div><div class="inline-input" style="margin-top:9px"><input id="templateName" placeholder="输入名称，保存或覆盖同名模板"><button class="btn soft" data-action="save-template">保存模板</button></div><div class="tip">小标题底色仅贴合文字；“应用”只代表样式已写入编辑区，公众号保存结果尚需核对。</div>`;
    for (const input of body.querySelectorAll('[data-style]')) input.value = state.style[input.dataset.style];
    const list = body.querySelector('#blockList');
    state.blocks.slice(0, 40).forEach(block => {
      const row = document.createElement('label'); row.className = 'check-row';
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.headingIndex = String(block.index); box.checked = block.heading;
      const span = document.createElement('span'); span.textContent = block.text.slice(0, 70);
      row.append(box, span); list.appendChild(row);
    });
    const saved = body.querySelector('#templateList');
    state.templates.forEach((template, index) => {
      const pill = document.createElement('span'); pill.className = 'pill';
      const load = document.createElement('button'); load.type = 'button'; load.className = 'pill'; load.dataset.action = 'load-template'; load.dataset.index = String(index); load.textContent = template.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.dataset.action = 'remove-template'; remove.dataset.index = String(index); remove.textContent = '×'; remove.title = `删除${template.name}`;
      pill.append(load, remove); saved.appendChild(pill);
    });
    notice(state.editor ? `已识别${state.blocks.length - headingCount}段正文、${headingCount}处小标题。` : '当前没有可编辑正文。', state.editor ? 'neutral' : 'warn');
    footer.innerHTML = button('撤销上次排版', 'undo-text', 'ghost', !state.textSnapshot) + button('应用到当前文章', 'apply-text', 'primary', !state.editor || !state.blocks.length);
  }
  function renderImages() {
    body.innerHTML = `${back()}<div class="eyebrow">02 / IMAGE STYLE</div><h2 class="title">统一处理图片</h2><p class="desc">只调整所选图片的展示样式，不主动更换图片；微信可能规范化地址。</p><div id="notice" class="status"></div><div class="section-title">选择图片 <small id="imageCount"></small></div><div class="button-row" style="margin-bottom:8px">${button('全选图片','select-all','line')}${button('全部取消','select-none','ghost')}</div><div class="check-list" id="imageList"></div><div class="section-title">图片格式</div><div class="grid">${field('圆角(px)','radius','number',0,40)}<div class="field"><label>阴影</label><select data-image-style="shadow"><option value="none">无</option><option value="soft">柔和</option><option value="strong">明显</option></select></div><div class="field"><label>对齐</label><select data-image-style="align"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></div><div class="field"><label>描边</label><select data-image-style="border"><option value="none">无</option><option value="light">浅色</option><option value="dark">深色</option></select></div></div><div class="tip">微信公众号可能清洗部分CSS。请原生保存、重新打开，并检查圆角、阴影及描边是否保留。</div>`;
    body.querySelector('[data-style="radius"]').value = state.imageStyle.radius;
    for (const input of body.querySelectorAll('[data-image-style]')) input.value = state.imageStyle[input.dataset.imageStyle];
    const list = body.querySelector('#imageList');
    state.images.forEach((image, index) => {
      const row = document.createElement('label'); row.className = 'check-row';
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.imageIndex = String(index); box.checked = state.imageSelection.has(index);
      const thumb = document.createElement('img'); thumb.src = image.currentSrc || image.src; thumb.alt = '';
      const label = document.createElement('span'); label.textContent = `图片${String(index + 1).padStart(2, '0')}`;
      row.append(box, thumb, label); list.appendChild(row);
    });
    body.querySelector('#imageCount').textContent = `${state.imageSelection.size}/${state.images.length}张已选`;
    notice(state.images.length ? `已识别${state.images.length}张图片。` : '当前文章没有可处理图片。', state.images.length ? 'neutral' : 'warn');
    footer.innerHTML = button(state.imageUndoing ? '正在逐张撤销…' : '撤销图片样式', 'undo-images', 'ghost', !state.imageSnapshot || state.imageApplying) +
      button(state.imageApplying ? '正在逐张处理…' : '应用到所选图片', 'apply-images', 'primary', !state.images.length || state.imageApplying);
  }
  function renderVideos() {
    const batch = state.batchState;
    const items = batch?.items || state.videoQueue;
    const busy = ['暂存中', '上传中', '等待首次协议', '等待微信保存'].includes(batch?.phase);
    const canChoose = videoPage && (!batch || ['待上传', '待核对', '已完成', '暂存失败'].includes(batch.phase));
    const canUpload = videoPage && ['待上传', '待核对', '已完成'].includes(batch?.phase);
    const chooser = canChoose ? `<div class="file-zone"><b>${batch ? '继续添加视频' : '选择视频'}</b><small>新视频会加入当前队列，已有视频保持不变。</small><label for="wxh-files">${batch ? '继续添加视频' : '选择视频'}<input id="wxh-files" type="file" accept="video/*" multiple></label></div>` : '';
    body.innerHTML = `${back()}<div class="eyebrow">03 / VIDEO QUEUE</div><h2 class="title">批量上传视频</h2><p class="desc">${videoPage ? '已选视频保留在此队列；微信素材库点“添加”后可继续处理。' : '先从“视频→素材库→本地上传”进入微信添加视频页。'}</p><div id="notice" class="status"></div>${chooser}<div class="section-title">上传队列 <small id="queueCount"></small></div><div id="videoList"></div>`;
    body.querySelector('#queueCount').textContent = `${items.length}个 · ${items.filter(item => item.status === '已上传').length}个已上传 · ${items.filter(item => item.status === '待核对').length}个待核对 · ${items.filter(item => item.status === '待上传').length}个待上传`;
    const list = body.querySelector('#videoList');
    items.forEach(item => {
      const row = document.createElement('div'); row.className = 'video-row';
      row.innerHTML = '<div class="video-top"><div class="cover">▷</div><div class="video-main"><input type="text" aria-label="视频标题"><small></small></div><span class="badge"></span></div><div class="video-actions"><span class="video-buttons"></span></div><div class="video-reason"></div>';
      row.dataset.videoId = item.id;
      const cover = row.querySelector('.cover');
      if (item.coverUrl) { const img = document.createElement('img'); img.src = item.coverUrl; img.alt = '视频封面'; cover.replaceChildren(img); }
      row.querySelector('.video-main input').value = item.title;
      row.querySelector('.video-main input').dataset.videoTitle = item.id;
      row.querySelector('.video-main small').textContent = `${item.fileName || '视频'}${item.fileSize ? ` · ${(item.fileSize / 1048576).toFixed(1)}MB` : ''}`;
      const badge = row.querySelector('.badge');
      badge.textContent = item.status;
      badge.dataset.state = item.status === '已上传' ? 'uploaded' : item.status === '待上传' ? 'pending' : item.status === '待核对' ? 'uncertain' : 'active';
      row.querySelector('.video-reason').textContent = item.reason || '';
      row.querySelector('.video-main input').disabled = item.status !== '待上传';
      if (batch?.activeItemId === item.id && ['已暂停', '结果待核对'].includes(batch.phase) && videoPage) {
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'safe';
        confirm.dataset.action = 'confirm-uploaded'; confirm.textContent = '已在素材库确认上传';
        row.querySelector('.video-buttons').appendChild(confirm);
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'danger';
        retry.dataset.action = 'confirm-not-uploaded'; retry.textContent = '素材库没有，重试';
        row.querySelector('.video-buttons').appendChild(retry);
      }
      if (item.status === '待上传' && videoPage) {
        const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'upload-inline';
        upload.dataset.action = 'upload-this'; upload.textContent = '上传此视频 →'; upload.disabled = !canUpload;
        row.querySelector('.video-buttons').appendChild(upload);
      }
      if (item.status === '待核对' && videoPage) {
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'safe';
        confirm.dataset.action = 'confirm-uploaded'; confirm.textContent = '在素材库确认已上传';
        row.querySelector('.video-buttons').appendChild(confirm);
      }
      if (['待核对', '已上传'].includes(item.status) && videoPage) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry-inline';
        retry.dataset.action = 'retry-upload'; retry.textContent = '重新上传此视频'; retry.disabled = !canUpload;
        row.querySelector('.video-buttons').appendChild(retry);
      }
      if (!row.querySelector('.video-buttons').children.length) row.querySelector('.video-actions').remove();
      list.appendChild(row);
    });
    notice(batch?.phase ? `批次状态：${batch.phase}${batch.reason ? `；${batch.reason}` : ''}` : '尚未选择视频。', ['结果待核对', '已暂停', '暂存失败', '待核对'].includes(batch?.phase) ? 'warn' : 'neutral');
    const next = items.find(item => item.status === '待上传');
    const activeStatus = items.find(item => item.id === batch?.activeItemId)?.status;
    const busyLabel = batch?.phase === '暂存中' ? '正在暂存视频' : batch?.phase === '等待首次协议' ? '等待确认服务规则' :
      batch?.phase === '等待微信保存' ? '等待在微信页面保存' : activeStatus === '保存已提交' ? '正在核验素材库' : '等待微信上传完成';
    footer.innerHTML = videoPage ? button(busy ? busyLabel : next && canUpload ? '上传下一条' : batch?.phase === '已完成' ? '全部已上传' : batch?.phase === '待核对' ? '可重传或继续添加视频' : '请先选择视频', 'upload-next', 'primary', testMode || !canUpload || !next) : button('打开微信本地上传', 'probe-video-input', 'line');
  }

  // Observe the host editor after native edit transactions. This is passive:
  // never reapply DOM styles behind its back or report success from attributes
  // that WeChat has already discarded during a redraw.
  function monitorStyleWrite(result, kind) {
    let stopped = false, latest = result.reconcile(), pending = null;
    const observer = new MutationObserver(() => {
      if (stopped || pending) return;
      pending = setTimeout(() => { pending = null; if (!stopped) latest = result.reconcile(); }, 40);
    });
    observer.observe((state.editor?.ownerDocument || document).documentElement,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    const checks = [350, 1200, 3000].map(delay => setTimeout(() => {
      if (!stopped) latest = result.reconcile();
    }, delay));
    const finish = setTimeout(() => {
      if (stopped) return;
      latest = result.reconcile();
      stop();
      const complete = latest.ok && latest.visibleCount === result.changed &&
        (kind !== '文字' || latest.alignmentCount === result.changed);
      notice(complete
        ? `已复核${latest.visibleCount}处${kind}样式；请用公众号原生保存并重新打开核对。`
        : latest.reason || `仅${latest.visibleCount || 0}/${result.changed}处${kind}样式可见${kind === '文字' ? `，${latest.alignmentCount || 0}/${result.changed}处对齐被接受` : ''}；请检查编辑区。`,
      complete ? 'warn' : 'error');
    }, 5000);
    function stop() {
      stopped = true; observer.disconnect();
      if (pending) clearTimeout(pending);
      checks.forEach(clearTimeout); clearTimeout(finish);
    }
    return stop;
  }

  function onAction(action, buttonElement) {
    if (action === 'close') return setOpen(false);
    if (['home', 'text', 'images', 'videos'].includes(action)) {
      state.view = action;
      render();
      if (action === 'videos' && !videoPage) void openNativeVideoUpload();
      return;
    }
    if (action === 'apply-text') {
      state.textMonitorStop?.();
      scan(); const result = adapter.applyTypography(state.editor, state.blocks, state.style);
      if (result.ok) state.textSnapshot = result.snapshot;
      render();
      if (result.ok) state.textMonitorStop = monitorStyleWrite(result, '文字');
      return notice(result.ok ? `已通过原生编辑命令写入${result.changed}处文字，正在复核。` : result.reason, result.ok ? 'warn' : 'error');
    }
    if (action === 'undo-text') {
      state.textMonitorStop?.(); state.textMonitorStop = null;
      const result = state.textSnapshot?.restore(); if (result?.ok) state.textSnapshot = null;
      render(); return notice(result?.ok ? '已恢复上次文字样式。' : result?.reason || '没有可撤销的操作。', result?.ok ? 'neutral' : 'warn');
    }
    if (action === 'apply-images') {
      if (state.imageApplying) return;
      state.imageMonitorStop?.();
      scan(); const selected = [...state.imageSelection].map(index => state.images[index]).filter(Boolean);
      state.imageApplying = true;
      buttonElement.disabled = true;
      buttonElement.textContent = '正在逐张处理…';
      void adapter.applyImageStyleBatch(state.editor, selected, state.imageStyle,
        (done, total) => notice(`已完成${done}/${total}张图片，正在继续。`, 'neutral'))
        .then(result => {
          if (result.ok) state.imageSnapshot = result.snapshot;
          state.imageApplying = false;
          render();
          if (result.ok) state.imageMonitorStop = monitorStyleWrite(result, '图片');
          notice(result.ok ? `已逐张处理${result.changed}张图片，正在复核。` : result.reason,
            result.ok ? 'warn' : 'error');
        }).catch(error => {
          state.imageApplying = false;
          render();
          notice(`图片处理失败：${error.message}`, 'error');
        });
      return;
    }
    if (action === 'undo-images') {
      if (state.imageApplying || !state.imageSnapshot) return;
      state.imageMonitorStop?.(); state.imageMonitorStop = null;
      state.imageApplying = true;
      state.imageUndoing = true;
      buttonElement.disabled = true;
      buttonElement.textContent = '正在逐张撤销…';
      void state.imageSnapshot.restore((done, total) =>
        notice(`已撤销${done}/${total}张图片，正在继续。`, 'neutral'))
        .then(result => {
          if (result.ok) state.imageSnapshot = null;
          state.imageApplying = false;
          state.imageUndoing = false;
          render();
          notice(result.ok ? `已复核恢复${result.restored}张图片的原样式。` : result.reason,
            result.ok ? 'neutral' : 'error');
        }).catch(error => {
          state.imageApplying = false;
          state.imageUndoing = false;
          render();
          notice(`撤销图片样式失败：${error.message}`, 'error');
        });
      return;
    }
    if (action === 'select-all' || action === 'select-none') { state.imageSelection = action === 'select-all' ? new Set(state.images.map((_, i) => i)) : new Set(); return render(); }
    if (action === 'save-template') {
      const name = body.querySelector('#templateName')?.value.trim();
      if (!name) return notice('请先填写模板名称。', 'warn');
      const existing = state.templates.find(t => t.name === name);
      if (existing) existing.style = { ...state.style };
      else state.templates.push({ name: name.slice(0, 30), style: { ...state.style } });
      persist(); render(); return notice(existing ? '模板已更新。' : '模板已保存到本机浏览器。', 'neutral');
    }
    if (action === 'load-template' || action === 'remove-template') {
      const index = Number(buttonElement.dataset.index);
      const template = state.templates[index]; if (!template) return;
      if (action === 'load-template') state.style = { ...initialStyle, ...template.style };
      else { state.templates.splice(index, 1); persist(); }
      render(); return notice(action === 'load-template' ? '模板已载入；点击应用才会改动文章。' : '模板已删除。', 'neutral');
    }
    if (action === 'upload-next' || action === 'upload-this' || action === 'retry-upload') {
      if (testMode) return notice('本地模拟页不能写入微信素材库。', 'warn');
      const itemId = action === 'upload-next' ? state.batchState?.items?.find(item => item.status === '待上传')?.id : buttonElement.closest('[data-video-id]')?.dataset.videoId;
      if (!itemId) return notice('没有可上传的视频。', 'warn');
      chrome.runtime.sendMessage({ type: 'wxh.batch.activate', itemId, retry: action === 'retry-upload' }).then(response => {
        if (!response?.ok) return notice(response?.error || '视频启动失败。', 'error');
        state.batchState = response.batch; render();
      }).catch(error => notice(error.message, 'error'));
      return notice('正在把暂存视频送入当前微信上传控件…', 'neutral');
    }
    if (action === 'confirm-uploaded' || action === 'confirm-not-uploaded') {
      const itemId = buttonElement.closest('[data-video-id]')?.dataset.videoId;
      if (!itemId) return;
      chrome.runtime.sendMessage({ type: `wxh.batch.${action}`, itemId }).then(response => {
        if (!response?.ok) return notice(response?.error || '状态更新失败。', 'error');
        state.batchState = response.batch; render();
      }).catch(error => notice(error.message, 'error'));
      return;
    }
    if (action === 'probe-video-input') {
      if (!videoPage) return void openNativeVideoUpload();
      return notice('你已在微信本地上传页。请在面板中一次选择全部视频并启动批次。', 'neutral');
    }
  }

  shadow.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) onAction(actionButton.dataset.action, actionButton);
  });
  shadow.addEventListener('input', event => {
    const target = event.target;
    if (target.dataset.style) {
      const key = target.dataset.style;
      const numeric = key === 'bodySize' || key === 'headingSize' || key === 'radius';
      const value = numeric ? Number(target.value) : target.value;
      if (key === 'radius') state.imageStyle.radius = clamp(value, 0, 40);
      else state.style[key] = numeric ? clamp(value, key === 'headingSize' ? 14 : 12, key === 'headingSize' ? 32 : 24) : value;
    }
  });
  shadow.addEventListener('change', async event => {
    const target = event.target;
    if (target.dataset.headingIndex !== undefined) {
      const block = state.blocks[Number(target.dataset.headingIndex)];
      if (block) { if (target.checked) block.node.dataset.wxhHeading = '1'; else delete block.node.dataset.wxhHeading; scan(); notice('标题标记已更新；点击应用后才会修改样式。', 'neutral'); }
    }
    if (target.dataset.imageIndex !== undefined) {
      const index = Number(target.dataset.imageIndex);
      if (target.checked) state.imageSelection.add(index); else state.imageSelection.delete(index);
      body.querySelector('#imageCount').textContent = `${state.imageSelection.size}/${state.images.length}张已选`;
    }
    if (target.dataset.imageStyle) state.imageStyle[target.dataset.imageStyle] = target.value;
    if (target.id === 'wxh-files') {
      const files = [...target.files];
      target.value = '';
      if (!files.length) return;
      if (testMode) {
        state.videoQueue.push(...files.map(file => ({ id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, ''),
          fileName: file.name, fileSize: file.size, status: '仅供预览' })));
        render(); return;
      }
      try { await stageSelectedVideos(files); }
      catch (error) { notice(error.message || '视频暂存失败。', 'error'); }
    }
    if (target.dataset.videoTitle) {
      const item = state.batchState?.items?.find(video => video.id === target.dataset.videoTitle);
      if (!item) return;
      const response = await chrome.runtime.sendMessage({ type: 'wxh.batch.update-item', itemId: item.id,
        title: target.value }).catch(error => ({ ok: false, error: error.message }));
      if (!response?.ok) return notice(response?.error || '标题保存失败。', 'error');
      state.batchState = response.batch; render();
    }
  });
  async function stageSelectedVideos(files) {
    // Persist bytes before any native upload begins. A later WeChat Add page
    // reconstructs its File from this extension-owned cache, not page memory.
    const unique = files.filter((file, index) => files.findIndex(other =>
      other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) === index);
    notice(`正在暂存${unique.length}个视频…`, 'neutral');
    const items = unique.map(file =>
      ({ id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, '').slice(0, 64),
        fileName: file.name, fileSize: file.size, fileModified: file.lastModified,
        fileType: file.type, file }));
    const appending = ['待上传', '待核对', '已完成'].includes(state.batchState?.phase);
    const begin = await chrome.runtime.sendMessage({ type: appending ? 'wxh.batch.append' : 'wxh.batch.begin',
      items: items.map(({ file, ...item }) => item) });
    if (!begin?.ok) throw new Error(begin?.error || '无法建立视频暂存批次。');
    state.batchState = begin.batch;
    render();
    let current = null;
    try {
      for (const item of items) {
        current = item;
        for (let offset = 0, index = 0; offset < item.file.size; offset += 4 * 1024 * 1024, index++) {
          const blob = item.file.slice(offset, Math.min(item.file.size, offset + 4 * 1024 * 1024));
          const result = await chrome.runtime.sendMessage({ type: 'wxh.batch.stage-chunk',
            batchId: begin.batch.id, itemId: item.id, index, blob });
          if (!result?.ok) throw new Error(result?.error || '视频分片暂存失败。');
          notice(`正在暂存：${item.fileName} · ${Math.round(Math.min(item.file.size, offset + blob.size) / item.file.size * 100)}%`, 'neutral');
        }
        const done = await chrome.runtime.sendMessage({ type: 'wxh.batch.stage-complete', batchId: begin.batch.id, itemId: item.id });
        if (!done?.ok) throw new Error(done?.error || '视频暂存完成校验失败。');
        state.batchState = done.batch;
        render();
      }
      notice(`${items.length}个视频已${appending ? '追加到队列' : '暂存'}。`, 'neutral');
    } catch (error) {
      await chrome.runtime.sendMessage({ type: 'wxh.batch.stage-failed', batchId: begin.batch.id,
        itemId: current?.id, reason: error.message }).catch(() => {});
      throw error;
    }
  }
  // Other WeChat pages receive only batch metadata; binary data stays in the
  // extension's IndexedDB and is served by the service worker to the uploader.
  if (!testMode && globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'wxh.batch.update') {
        state.batchState = message.batch;
        if (state.view === 'videos') render();
      }
    });
  }

  // Keep pointer coordinates separate from saved element coordinates.
  function draggable(handle, kind) {
    let down = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (kind === 'panel' && event.target.closest('button'))) return;
      event.preventDefault();
      down = { px: event.clientX, py: event.clientY, x: state.layout[kind].x, y: state.layout[kind].y };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!down) return;
      const item = state.layout[kind];
      item.x = clamp(down.x + event.clientX - down.px, 8, innerWidth - (kind === 'ball' ? 58 : item.w) - 8);
      item.y = clamp(down.y + event.clientY - down.py, 8, innerHeight - (kind === 'ball' ? 58 : item.h) - 8);
      normalizeLayout();
    });
    handle.addEventListener('pointerup', event => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.px, event.clientY - down.py);
      down = null; persist();
      if (kind === 'ball' && moved < 5) setOpen(true);
    });
    handle.addEventListener('pointercancel', () => { down = null; });
  }
  draggable(ball, 'ball');
  draggable(shadow.querySelector('#dragBar'), 'panel');
  ball.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true); }
    const directions = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -15], ArrowDown: [0, 15] };
    if (directions[event.key]) { event.preventDefault(); state.layout.ball.x += directions[event.key][0]; state.layout.ball.y += directions[event.key][1]; normalizeLayout(); persist(); }
  });
  const resize = shadow.querySelector('#resize');
  let resizeStart = null;
  resize.addEventListener('pointerdown', event => {
    event.preventDefault();
    resizeStart = { px: event.clientX, py: event.clientY, w: state.layout.panel.w, h: state.layout.panel.h };
    resize.setPointerCapture(event.pointerId);
  });
  resize.addEventListener('pointermove', event => {
    if (!resizeStart) return;
    state.layout.panel.w = clamp(resizeStart.w + event.clientX - resizeStart.px, 340, innerWidth - state.layout.panel.x - 8);
    state.layout.panel.h = clamp(resizeStart.h + event.clientY - resizeStart.py, 390, innerHeight - state.layout.panel.y - 8);
    normalizeLayout();
  });
  resize.addEventListener('pointerup', () => { if (resizeStart) { resizeStart = null; persist(); } });
  resize.addEventListener('pointercancel', () => { resizeStart = null; });
  resize.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') state.layout.panel.w += 20;
    else if (event.key === 'ArrowLeft') state.layout.panel.w -= 20;
    else if (event.key === 'ArrowDown') state.layout.panel.h += 20;
    else if (event.key === 'ArrowUp') state.layout.panel.h -= 20;
    else return;
    event.preventDefault(); normalizeLayout(); persist();
  });
  window.addEventListener('resize', normalizeLayout);

  (async () => {
    const saved = await storage.get();
    if (saved.layout?.ball && saved.layout?.panel) state.layout = saved.layout;
    if (Array.isArray(saved.templates)) state.templates = saved.templates.filter(t => t && typeof t.name === 'string' && t.style && typeof t.style === 'object');
    if (!testMode && globalThis.chrome?.runtime?.sendMessage) {
      const result = await chrome.runtime.sendMessage({ type: 'wxh.batch.state' }).catch(() => null);
      if (result?.ok) state.batchState = result.batch;
    }
    normalizeLayout();
    // The native local-upload page is the next step of the video flow even
    // before the user has selected any files, so open the queue immediately.
    if (videoPage) {
      state.view = 'videos';
      setOpen(true);
    }
    render();
  })();
})();
