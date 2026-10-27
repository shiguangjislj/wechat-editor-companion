/* Generic, conservative editor adapter. No WeChat private API dependency. */
(function (root, factory) {
  const api = factory();
  root.WXHAdapter = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, function () {
  'use strict';

  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,div,section';
  const EXPLICIT_HEADING = /^H[1-6]$/;
  const MARKDOWN_HEADING = /^#{1,6}\s+\S/;

  function documents(start) {
    const found = [start];
    const walk = (doc) => {
      for (const frame of doc.querySelectorAll('iframe')) {
        try {
          const child = frame.contentDocument;
          if (child && !found.includes(child)) {
            found.push(child);
            walk(child);
          }
        } catch (_) { /* Cross-origin frames are intentionally ignored. */ }
      }
    };
    walk(start);
    return found;
  }

  function visible(node) {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    return rect.width > 1 && rect.height > 1 && style?.display !== 'none' && style?.visibility !== 'hidden';
  }

  function findEditor(start = document) {
    const candidates = [];
    for (const doc of documents(start)) {
      for (const node of doc.querySelectorAll('[contenteditable="true"],body[contenteditable="true"]')) {
        if (!visible(node)) continue;
        if (node.closest?.('[data-wxh-ui]')) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 40) continue;
        const textLength = (node.textContent || '').trim().length;
        const blockCount = node.querySelectorAll('p,div,section,h1,h2,h3,h4,h5,h6').length;
        const imageCount = node.querySelectorAll('img').length;
        const score = Math.min(textLength, 3000) + blockCount * 24 + imageCount * 70 + Math.min(rect.width, 900) / 6 + Math.min(rect.height, 1200) / 10;
        candidates.push({ node, score, textLength });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.node || null;
  }

  function isLeafBlock(node) {
    const nested = node.querySelector(BLOCK_SELECTOR);
    return !nested || /^(P|LI|BLOCKQUOTE|H[1-6])$/.test(node.tagName);
  }

  function collectBlocks(editor) {
    if (!editor) return [];
    const all = [...editor.querySelectorAll(BLOCK_SELECTOR)].filter(node => {
      if (!visible(node) || !isLeafBlock(node)) return false;
      if (node.closest('figure,figcaption')) return false;
      const text = (node.textContent || '').trim();
      return text.length > 0;
    });
    if (all.length) return all.map((node, index) => ({
      node,
      index,
      text: (node.textContent || '').trim(),
      heading: EXPLICIT_HEADING.test(node.tagName) || node.dataset.wxhHeading === '1' || MARKDOWN_HEADING.test((node.textContent || '').trim()),
      markdownHeading: MARKDOWN_HEADING.test((node.textContent || '').trim())
    }));
    const text = (editor.textContent || '').trim();
    return text ? [{ node: editor, index: 0, text, heading: false, markdownHeading: false }] : [];
  }

  function collectImages(editor) {
    if (!editor) return [];
    return [...editor.querySelectorAll('img')].filter(img => {
      const rect = img.getBoundingClientRect();
      return visible(img) && rect.width >= 50 && rect.height >= 35;
    });
  }

  function audit(editor) {
    if (!editor) return null;
    return JSON.stringify({
      text: editor.textContent,
      links: [...editor.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
      images: [...editor.querySelectorAll('img')].map(img => img.getAttribute('src')),
      media: editor.querySelectorAll('video,iframe,.video_iframe,[data-type="video"]').length
    });
  }

  // Route formatting through the browser's contenteditable edit command. A
  // synthetic input event after changing DOM attributes does not update many
  // editor history/models. The command also gives the host editor its normal
  // beforeinput/input path. Refuse to claim success if that path is absent.
  function replaceNative(node, html, contents = true) {
    const doc = node.ownerDocument;
    const selection = doc.getSelection();
    if (!selection || typeof doc.execCommand !== 'function') return false;
    const range = doc.createRange();
    if (contents) range.selectNodeContents(node);
    else range.selectNode(node);
    const editor = node.closest('[contenteditable="true"]');
    editor?.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    try { return doc.execCommand('insertHTML', false, html) === true; }
    catch (_) { return false; }
    finally { selection.removeAllRanges(); }
  }

  function restoreImageNative(target, html, editor) {
    // Chromium may collapse selectNode(frame) into the image inside a styled
    // span. The command then replaces only that image and leaves our frame.
    // Edit the nearest non-root parent contents so the frame is removed by
    // the same native transaction that restores the original markup.
    const parent = target.parentElement;
    if (!parent || parent === editor) return replaceNative(target, html, false);
    const index = [...parent.childNodes].indexOf(target);
    if (index < 0) return false;
    const copy = parent.cloneNode(true);
    const replacement = parent.ownerDocument.createElement('template');
    replacement.innerHTML = html;
    copy.childNodes[index].replaceWith(...replacement.content.childNodes);
    return replaceNative(parent, copy.innerHTML, true);
  }

  function styleHtmlForBlock(block, options) {
    const doc = block.node.ownerDocument;
    const wrapper = doc.createElement('span');
    wrapper.dataset.wxhTextFrame = '1';
    const heading = block.heading;
    const color = heading ? options.headingColor : options.bodyColor;
    const size = heading ? options.headingSize : options.bodySize;
    const bg = heading ? options.headingBg : options.bodyBg;
    const ink = heading ? doc.createElement('span') : wrapper;
    if (heading) {
      ink.dataset.wxhHeadingInk = '1';
      ink.style.setProperty('background-color', bg, 'important');
      ink.style.setProperty('padding', '0 6px', 'important');
      ink.style.setProperty('box-decoration-break', 'clone', 'important');
      ink.style.setProperty('-webkit-box-decoration-break', 'clone', 'important');
      wrapper.append(ink);
    } else wrapper.style.setProperty('background-color', bg, 'important');
    // A previously styled heading can contain an old black ink span and a
    // later native highlight span (the red patch in the reported screenshot).
    // Flatten only our own frames, then clear descendant backgrounds so the
    // newly selected heading/background color is the sole ink layer. Preserve
    // links, emphasis, line breaks and all text in their original order.
    const source = doc.createElement('span');
    for (const child of [...block.node.childNodes]) source.append(child.cloneNode(true));
    for (const old of [...source.querySelectorAll('[data-wxh-text-frame],[data-wxh-heading-ink]')].reverse())
      old.replaceWith(...old.childNodes);
    for (const element of source.querySelectorAll('*')) {
      element.style.removeProperty('background');
      element.style.removeProperty('background-color');
      element.style.removeProperty('background-image');
    }
    while (source.firstChild) ink.append(source.firstChild);
    for (const element of [wrapper, ...wrapper.querySelectorAll('*')]) {
      if (/^(IMG|VIDEO|IFRAME|BR|SVG|PATH)$/.test(element.tagName)) continue;
      element.style.setProperty('font-size', `${size}px`, 'important');
      element.style.setProperty('color', color, 'important');
      element.style.setProperty('-webkit-text-fill-color', color, 'important');
    }
    return wrapper.outerHTML;
  }

  function nativeSnapshot(editor, entries, initialAudit) {
    return { restore() {
      if (!editor.isConnected || audit(editor) !== initialAudit)
        return { ok: false, reason: '文章内容已变化，无法安全撤销。' };
      if (entries.some(entry => collectBlocks(editor)[entry.index]?.text !== entry.text))
        return { ok: false, reason: '段落已变化，无法安全撤销。' };
      for (const entry of [...entries].reverse()) {
        const block = collectBlocks(editor)[entry.index]?.node;
        if (!block || !replaceNative(block, entry.html))
          return { ok: false, reason: '原生编辑器未接受撤销；请使用公众号编辑器的撤销按钮。' };
        if (entry.aligned) applyNativeAlignment(collectBlocks(editor)[entry.index].node,
          /^(center|right)$/.test(entry.originalAlign) ? entry.originalAlign : 'left');
      }
      return { ok: true };
    } };
  }

  function applyNativeAlignment(block, alignment) {
    const command = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight' }[alignment];
    if (!command) return false;
    const doc = block.ownerDocument;
    const selection = doc.getSelection();
    if (!selection || typeof doc.execCommand !== 'function') return false;
    const range = doc.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
    try { return doc.execCommand(command, false, null) === true; }
    catch (_) { return false; }
    finally { selection.removeAllRanges(); }
  }

  function applyTypography(editor, blocks, options) {
    if (!editor || !blocks?.length) return { ok: false, reason: '未识别到可排版的正文。' };
    const before = audit(editor);
    const targets = blocks.filter(block => !block.node.querySelector('img,video,iframe'));
    if (!targets.length) return { ok: false, reason: '识别到的段落包含媒体，无法安全改写文字。' };
    const entries = targets.map(block => ({
      index: block.index, text: block.text, html: block.node.innerHTML,
      heading: block.heading, align: block.heading ? options.headingAlign || options.align : options.align,
      originalAlign: (block.node.ownerDocument.defaultView?.getComputedStyle(block.node).textAlign || 'left')
    }));
    let changed = 0;
    for (const entry of entries) {
      const current = collectBlocks(editor)[entry.index];
      if (!current || current.text !== entry.text || !replaceNative(current.node, styleHtmlForBlock(current, options))) {
        return { ok: false, reason: '公众号编辑器未接受文字插入事务；已停止，避免继续改写其他段落。', changed };
      }
      changed++;
      const updated = collectBlocks(editor)[entry.index];
      if (!updated || updated.text !== entry.text || audit(editor) !== before)
        return { ok: false, reason: '编辑器改变了文章内容或段落结构，已停止排版，请检查当前文章。', changed };
      // Native justification is a separate editing transaction. Some host
      // editors reject it; the text style remains applied and the UI reports
      // the alignment limitation instead of silently claiming it worked.
      entry.aligned = applyNativeAlignment(updated.node, entry.align);
      if (audit(editor) !== before)
        return { ok: false, reason: '对齐操作改变了文章内容，已停止排版，请检查当前文章。', changed };
    }
    const snapshot = nativeSnapshot(editor, entries, before);
    function reconcile() {
      if (!editor.isConnected || audit(editor) !== before)
        return { ok: false, reason: '文章内容或编辑区已变化，请重新识别。', visibleCount: 0 };
      const current = collectBlocks(editor);
      let visibleCount = 0;
      for (const entry of entries) {
        const block = current[entry.index];
        if (!block || block.text !== entry.text) continue;
        const expectedColor = entry.heading ? options.headingColor : options.bodyColor;
        const expectedBackground = entry.heading ? options.headingBg : options.bodyBg;
        const expectedSize = `${entry.heading ? options.headingSize : options.bodySize}px`;
        const colorProbe = editor.ownerDocument.createElement('span');
        colorProbe.style.color = expectedColor;
        const normalized = colorProbe.style.color;
        const styled = [...block.node.querySelectorAll('span,a,strong,em,b,i,u')].filter(node => (node.textContent || '').trim());
        const backgroundNode = entry.heading ?
          block.node.querySelector('[data-wxh-heading-ink="1"]') :
          block.node.querySelector('[data-wxh-text-frame="1"]');
        const backgroundProbe = editor.ownerDocument.createElement('span');
        backgroundProbe.style.backgroundColor = expectedBackground;
        const backgroundMatches = backgroundNode &&
          backgroundNode.ownerDocument.defaultView?.getComputedStyle(backgroundNode).backgroundColor === backgroundProbe.style.backgroundColor;
        const noOldHeadingBackground = !entry.heading || (backgroundNode &&
          [...backgroundNode.querySelectorAll('*')].every(node => {
            const background = node.ownerDocument.defaultView?.getComputedStyle(node).backgroundColor;
            return !background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)';
          }));
        if (backgroundMatches && noOldHeadingBackground && styled.length && styled.every(node => {
          const css = node.ownerDocument.defaultView?.getComputedStyle(node);
          return css?.color === normalized && css?.fontSize === expectedSize;
        })) visibleCount++;
      }
      return { ok: true, visibleCount, alignmentCount: entries.filter(e => e.aligned).length };
    }
    const checked = reconcile();
    return { ok: true, changed, visibleCount: checked.visibleCount,
      alignmentCount: checked.alignmentCount, snapshot, reconcile, platformSaved: false };
  }

  function imageFrameHtml(image, options, assetKey) {
    const doc = image.ownerDocument;
    const frame = doc.createElement('span');
    frame.dataset.wxhImageFrame = '1';
    const img = image.cloneNode(true);
    frame.dataset.wxhAssetKey = assetKey;
    img.dataset.wxhAssetKey = assetKey;
    const radius = `${Math.max(0, Number(options.radius) || 0)}px`;
    const shadow = options.shadow === 'strong' ? '0 12px 26px rgba(30,60,42,.26)' :
      options.shadow === 'soft' ? '0 7px 18px rgba(30,60,42,.16)' : 'none';
    const border = options.border === 'dark' ? '2px solid #405a49' :
      options.border === 'light' ? '1px solid #d1ded5' : '0';
    for (const [key, value] of Object.entries({
      display: 'block', width: 'fit-content', 'max-width': '100%', overflow: 'hidden',
      'border-radius': radius, 'box-shadow': shadow, border,
      'margin-left': options.align === 'left' ? '0' : 'auto',
      'margin-right': options.align === 'right' ? '0' : 'auto'
    })) frame.style.setProperty(key, value, 'important');
    img.style.setProperty('display', 'block', 'important');
    img.style.setProperty('max-width', '100%', 'important');
    img.style.setProperty('border-radius', radius, 'important');
    frame.append(img);
    return frame.outerHTML;
  }

  function imageContentState(editor) {
    return {
      // Native editors can add zero-width caret placeholders without changing
      // the author's actual article text.
      text: (editor.textContent || '').replace(/[\u200b\ufeff]/g, ''),
      links: [...editor.querySelectorAll('a[href]')].map(node => node.getAttribute('href')),
      media: editor.querySelectorAll('video,iframe,.video_iframe,[data-type="video"]').length,
      images: [...editor.querySelectorAll('img')].map(image => ({
        src: image.getAttribute('src') || '',
        stable: image.getAttribute('data-src') || image.getAttribute('data-original') ||
          image.getAttribute('data-original-src') || image.getAttribute('_src') || '',
        key: image.dataset.wxhAssetKey || '',
        alt: image.getAttribute('alt') || '',
        width: image.getAttribute('data-w') || image.getAttribute('width') || ''
      }))
    };
  }

  function sourceIdentity(source, base) {
    if (!source) return '';
    try {
      const url = new URL(source, base);
      // WeChat's CDN may swap the rendition size or query string while
      // retaining the same media ID in the second path segment.
      if (/^mmbiz\.qpic\.cn$/i.test(url.hostname))
        return `${url.hostname}/${url.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}`;
      return `${url.origin}${url.pathname}`;
    } catch (_) { return source.split('?')[0]; }
  }

  function sameImageSource(before, after, base) {
    if (before.key && after.key && before.key === after.key) return true;
    const oldSources = [before.stable, before.src].filter(Boolean).map(value => sourceIdentity(value, base));
    const newSources = [after.stable, after.src].filter(Boolean).map(value => sourceIdentity(value, base));
    return oldSources.some(value => newSources.includes(value));
  }

  function imageStateProblem(before, after) {
    if (before.text !== after.text) return '文章文字发生变化';
    if (JSON.stringify(before.links) !== JSON.stringify(after.links)) return '文章链接发生变化';
    if (before.media !== after.media) return '文章视频或嵌入内容发生变化';
    // WeChat resolves lazy images and rewrites CDN URLs independently of the
    // edit transaction. Other images may also be added by the host while a
    // batch runs. Check the selected target itself instead of a global count.
    return '';
  }

  function imageAppearance(image) {
    const frame = image?.closest('[data-wxh-image-frame="1"]');
    const properties = ['border-radius', 'box-shadow', 'border', 'margin-left',
      'margin-right', 'display', 'max-width', 'width', 'height'];
    const styleValues = node => node ? properties.map(property =>
      [node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]) : null;
    return JSON.stringify({ frame: styleValues(frame), image: styleValues(image) });
  }

  function applyImageStyle(editor, images, options) {
    if (!editor || !images?.length) return { ok: false, reason: '未选择图片。' };
    const base = editor.ownerDocument.baseURI;
    let baseline = imageContentState(editor);
    const all = [...editor.querySelectorAll('img')];
    const entries = images.map(image => ({
      index: all.indexOf(image), source: baseline.images[all.indexOf(image)],
      node: image,
      originalAppearance: imageAppearance(image),
      html: (image.closest('[data-wxh-image-frame="1"]') || image).outerHTML
    }));
    if (entries.some(entry => entry.index < 0))
      return { ok: false, reason: '图片已变化，请重新识别。' };
    let changed = 0;
    for (const entry of entries) {
      const image = editor.querySelectorAll('img')[entry.index];
      const currentState = imageContentState(editor);
      const preflight = imageStateProblem(baseline, currentState);
      if (preflight) return { ok: false, reason: `${preflight}；已处理${changed}张，请检查当前文章。`, changed };
      const target = image?.closest('[data-wxh-image-frame="1"]') || image;
      // A selected image may receive a new src while keeping the same DOM
      // node. If WeChat replaced the node, require its stable source/key.
      if (!image || (image !== entry.node &&
          !sameImageSource(entry.source, currentState.images[entry.index], base)))
        return { ok: false, reason: `第${entry.index + 1}张图片已变化，已停止处理。`, changed };
      entry.assetKey = image.dataset.wxhAssetKey ||
        `wxh-${Date.now().toString(36)}-${entry.index}-${Math.random().toString(36).slice(2, 8)}`;
      if (!replaceNative(target, imageFrameHtml(image, options, entry.assetKey), false))
        return { ok: false, reason: `第${entry.index + 1}张图片未被公众号编辑器接受；已处理${changed}张。`, changed };
      changed++;
      const after = imageContentState(editor);
      const problem = imageStateProblem(baseline, after);
      if (problem) return { ok: false, reason: `${problem}；已处理${changed}张，请检查当前文章。`, changed };
      const beforeCopies = baseline.images.filter(candidate => sameImageSource(entry.source, candidate, base)).length;
      const afterCopies = after.images.filter(candidate => sameImageSource(entry.source, candidate, base)).length;
      if (afterCopies > beforeCopies)
        return { ok: false, reason: `第${entry.index + 1}张图片出现重复副本；已处理${changed}张，请检查当前文章。`, changed };
      const submitted = editor.querySelectorAll('img')[entry.index];
      const submittedFrame = submitted?.closest('[data-wxh-image-frame="1"]');
      if (!submittedFrame || (submittedFrame.dataset.wxhAssetKey !== entry.assetKey &&
          submitted?.dataset.wxhAssetKey !== entry.assetKey &&
          !sameImageSource(entry.source, after.images[entry.index], base) &&
          !(entry.source.alt === after.images[entry.index]?.alt &&
            entry.source.width === after.images[entry.index]?.width)))
        return { ok: false, reason: `第${entry.index + 1}张图片未保留新样式；已处理${changed}张。`, changed };
      entry.finalSource = after.images[entry.index];
      entry.finalNode = submitted;
      baseline = after;
    }
    const completedState = baseline;
    const snapshot = { restore() {
      if (!editor.isConnected || imageStateProblem(completedState, imageContentState(editor)))
        return { ok: false, reason: '文章内容已变化，无法安全撤销。' };
      for (const entry of [...entries].reverse()) {
        const image = editor.querySelectorAll('img')[entry.index];
        if (!image || (image !== entry.finalNode &&
            image.dataset.wxhAssetKey !== entry.assetKey &&
            image.closest('[data-wxh-image-frame="1"]')?.dataset.wxhAssetKey !== entry.assetKey &&
            !sameImageSource(entry.finalSource, imageContentState(editor).images[entry.index], base)))
          return { ok: false, reason: '图片顺序已变化，无法安全撤销。' };
        const target = image.closest('[data-wxh-image-frame="1"]') || image;
        if (!restoreImageNative(target, entry.html, editor))
          return { ok: false, reason: '原生编辑器未接受撤销；请使用公众号编辑器的撤销按钮。' };
      }
      return { ok: true };
    }, verifyRestored() {
      if (!editor.isConnected || imageStateProblem(completedState, imageContentState(editor))) return false;
      return entries.every(entry => imageAppearance(editor.querySelectorAll('img')[entry.index]) ===
        entry.originalAppearance);
    } };
    function reconcile() {
      const currentState = editor.isConnected ? imageContentState(editor) : null;
      if (!currentState || imageStateProblem(completedState, currentState))
        return { ok: false, reason: '文章内容或编辑区已变化，请重新识别。', visibleCount: 0 };
      let visibleCount = 0;
      for (const entry of entries) {
        const image = editor.querySelectorAll('img')[entry.index];
        const frame = image?.closest('[data-wxh-image-frame="1"]');
        const css = frame && frame.ownerDocument.defaultView?.getComputedStyle(frame);
        const shadowMatches = options.shadow === 'none' ? css?.boxShadow === 'none' :
          Boolean(css?.boxShadow && css.boxShadow !== 'none');
        const borderMatches = options.border === 'none' ? !css?.borderTopWidth || css.borderTopWidth === '0px' :
          css?.borderTopWidth === (options.border === 'dark' ? '2px' : '1px');
        const recognized = frame?.dataset.wxhAssetKey === entry.assetKey ||
          image?.dataset.wxhAssetKey === entry.assetKey ||
          sameImageSource(entry.finalSource, currentState.images[entry.index], base);
        if (image && frame && recognized && css?.borderRadius ===
          `${Math.max(0, Number(options.radius) || 0)}px` && shadowMatches && borderMatches) visibleCount++;
      }
      return { ok: true, visibleCount };
    }
    const checked = reconcile();
    return { ok: true, changed, visibleCount: checked.visibleCount, snapshot, reconcile,
      assetKeys: entries.map(entry => entry.assetKey),
      platformSaved: false };
  }

  function waitForImageEditorSettled(editor) {
    // Native input handlers can schedule a later model redraw. Give each
    // transaction its own quiet period before starting the next image.
    return new Promise(resolve => {
      const start = Date.now();
      let lastMutation = start;
      const observer = new MutationObserver(() => { lastMutation = Date.now(); });
      observer.observe(editor, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setInterval(() => {
        const now = Date.now();
        if ((now - start >= 450 && now - lastMutation >= 250) || now - start >= 2500) {
          clearInterval(timer);
          observer.disconnect();
          resolve();
        }
      }, 50);
    });
  }

  async function applyImageStyleBatch(editor, images, options, onProgress = () => {}) {
    if (!editor || !images?.length) return { ok: false, reason: '未选择图片。', changed: 0 };
    const base = editor.ownerDocument.baseURI;
    const initialState = imageContentState(editor);
    const initialImages = [...editor.querySelectorAll('img')];
    const plans = images.map(node => ({
      node, index: initialImages.indexOf(node), source: initialState.images[initialImages.indexOf(node)],
      html: (node.closest('[data-wxh-image-frame="1"]') || node).outerHTML,
      appearance: imageAppearance(node)
    }));
    if (plans.some(plan => plan.index < 0))
      return { ok: false, reason: '图片已变化，请重新识别。', changed: 0 };
    const completed = [];
    const used = new Set();
    for (const plan of plans) {
      if (!editor.isConnected) return { ok: false, reason: '编辑区已关闭，批量处理已停止。', changed: completed.length };
      const structureProblem = imageStateProblem(initialState, imageContentState(editor));
      if (structureProblem) return { ok: false, reason: `${structureProblem}；已处理${completed.length}张。`, changed: completed.length };
      const currentImages = [...editor.querySelectorAll('img')];
      let target = plan.node.isConnected && editor.contains(plan.node) ? plan.node : currentImages[plan.index];
      if (!target || used.has(target) || (target !== plan.node && !sameImageSource(plan.source,
          imageContentState(editor).images[currentImages.indexOf(target)], base))) {
        target = currentImages.find((node, index) => !used.has(node) &&
          sameImageSource(plan.source, imageContentState(editor).images[index], base));
      }
      if (!target) return { ok: false,
        reason: `第${plan.index + 1}张所选图片已被编辑器替换，已处理${completed.length}张。`,
        changed: completed.length };
      const result = applyImageStyle(editor, [target], options);
      if (!result.ok) return { ok: false, reason: result.reason, changed: completed.length + (result.changed || 0) };
      await waitForImageEditorSettled(editor);
      const checked = result.reconcile();
      if (!checked.ok || checked.visibleCount !== 1)
        return { ok: false, reason: checked.reason || `第${plan.index + 1}张图片在编辑器重绘后未保留样式；已处理${completed.length}张。`,
          changed: completed.length };
      completed.push(result);
      plan.assetKey = result.assetKeys[0];
      used.add(target);
      onProgress(completed.length, plans.length);
    }
    function reconcile() {
      const checks = completed.map(result => result.reconcile());
      const failed = checks.find(check => !check.ok);
      return failed || { ok: true, visibleCount: checks.reduce((sum, check) => sum + check.visibleCount, 0) };
    }
    const checked = reconcile();
    if (!checked.ok || checked.visibleCount !== completed.length)
      return { ok: false, reason: checked.reason || '部分图片样式在批量处理后被编辑器清除。', changed: completed.length };
    return { ok: true, changed: completed.length, visibleCount: checked.visibleCount, reconcile,
      snapshot: { async restore(onProgress = () => {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!editor.isConnected) return { ok: false, reason: '编辑区已关闭，无法撤销。' };
          const before = imageContentState(editor);
          const copy = editor.cloneNode(true);
          const copiedImages = [...copy.querySelectorAll('img')];
          const restoredIndexes = new Map();
          for (let index = plans.length - 1; index >= 0; index--) {
            const plan = plans[index];
            const current = copiedImages.find(image => image.dataset.wxhAssetKey === plan.assetKey ||
              image.closest('[data-wxh-image-frame="1"]')?.dataset.wxhAssetKey === plan.assetKey) ||
              copiedImages[plan.index];
            const currentIndex = copiedImages.indexOf(current);
            if (!current || (!sameImageSource(plan.source, before.images[currentIndex], base) &&
                !current.closest('[data-wxh-image-frame="1"]')))
              return { ok: false, reason: `第${plan.index + 1}张图片已变化，无法安全撤销。` };
            restoredIndexes.set(plan, currentIndex);
            const target = current.closest('[data-wxh-image-frame="1"]') || current;
            const replacement = editor.ownerDocument.createElement('template');
            replacement.innerHTML = plan.html;
            const originalImage = replacement.content.querySelector('img');
            if (!originalImage) return { ok: false, reason: '原图片备份不完整，无法撤销。' };
            // Keep WeChat's current media URL when it has normalized a lazy
            // image; only restore the image's presentation markup.
            for (const attribute of ['src', 'data-src', 'data-original', 'data-original-src', '_src']) {
              if (current.hasAttribute(attribute)) originalImage.setAttribute(attribute, current.getAttribute(attribute));
            }
            target.replaceWith(...replacement.content.childNodes);
          }
          if (!replaceNative(editor, copy.innerHTML, true))
            return { ok: false, reason: '公众号编辑器未接受图片样式撤销。' };
          await waitForImageEditorSettled(editor);
          const after = imageContentState(editor);
          const safe = !imageStateProblem(before, after) && before.images.length === after.images.length;
          const restored = safe && plans.every(plan => imageAppearance(editor.querySelectorAll('img')[restoredIndexes.get(plan)]) ===
            plan.appearance);
          if (restored) {
            onProgress(plans.length, plans.length);
            return { ok: true, restored: plans.length };
          }
        }
        return { ok: false, reason: '公众号编辑器重绘后仍保留了部分图片样式；撤销未完成，请检查正文。' };
      } }, platformSaved: false };
  }

  function findNativeVideoInput(start = document) {
    const candidates = documents(start).flatMap(doc => [...doc.querySelectorAll('input[type="file"]')]);
    return candidates.find(input => {
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      return accept.includes('video') || accept.includes('.mp4') || accept.includes('.mov');
    }) || null;
  }

  function findNativeVideoButton(start = document, label = '本地上传') {
    const matches = documents(start).flatMap(doc => [...doc.querySelectorAll('button,a,[role="button"],label')]);
    return matches.find(node => !node.closest('[data-wxh-ui]') && visible(node) && (node.textContent || '').trim() === label) || null;
  }

  // Locate only the editor's visible top toolbar entry. Clicking its text node
  // bubbles to WeChat's own handler; article text and the extension are excluded.
  function findNativeToolbarVideoButton(start = document) {
    const matches = documents(start).flatMap(doc => [...doc.querySelectorAll('button,a,[role="button"],span,div,li')]);
    return matches.filter(node => {
      if (node.closest('[data-wxh-ui],[contenteditable="true"]') || !visible(node)) return false;
      if ((node.textContent || '').trim() !== '视频') return false;
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.top < Math.min(330, (node.ownerDocument.defaultView?.innerHeight || 800) / 2);
    }).sort((a, b) => {
      const aRect = a.getBoundingClientRect(), bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.width - bRect.width;
    })[0] || null;
  }

  // The 素材库 tab is identified by the neighboring 视频链接 tab, so a sidebar
  // entry with the same label will not be treated as the video picker.
  function findNativeVideoLibraryTab(start = document) {
    const matches = documents(start).flatMap(doc => [...doc.querySelectorAll('button,a,[role="tab"],[role="button"],span,div,li')]);
    return matches.find(node => {
      if (node.closest('[data-wxh-ui]') || !visible(node) || (node.textContent || '').trim() !== '素材库') return false;
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        if ((parent.textContent || '').includes('视频链接')) return true;
      }
      return false;
    }) || null;
  }

  function transferVideoFile(input, file) {
    if (!input || !file) return { ok: false, reason: '请先在微信中打开本地视频上传窗口。' };
    const win = input.ownerDocument.defaultView || window;
    try {
      const data = new win.DataTransfer();
      data.items.add(file);
      input.files = data.files;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { ok: input.files?.[0] === file, reason: input.files?.[0] === file ? null : '平台上传控件未接受文件。' };
    } catch (error) {
      return { ok: false, reason: `当前上传控件无法接收文件：${error.message}` };
    }
  }

  function findNativeVideoTitleInput(start = document) {
    const inputs = documents(start).flatMap(doc => [...doc.querySelectorAll('input[type="text"],input:not([type]),textarea')]);
    const candidates = inputs.filter(input => !input.closest('[data-wxh-ui]') && visible(input));
    return candidates.find(input => /标题/.test(`${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''}`)) ||
      candidates.find(input => input.maxLength === 64 && /标题/.test(input.parentElement?.parentElement?.textContent || '')) || null;
  }

  function fillNativeVideoTitle(start, title) {
    const input = findNativeVideoTitleInput(start);
    if (!input) return { ok: false, reason: '未识别到微信原生标题框，请手动粘贴标题。' };
    const value = String(title || '').trim().slice(0, input.maxLength > 0 ? input.maxLength : 64);
    const prototype = input.tagName === 'TEXTAREA' ? input.ownerDocument.defaultView.HTMLTextAreaElement.prototype : input.ownerDocument.defaultView.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return { ok: false, reason: '当前标题框不支持自动填写。' };
    setter.call(input, value);
    const win = input.ownerDocument.defaultView;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    return { ok: input.value === value, reason: input.value === value ? null : '微信标题框未接受输入，请手动粘贴。' };
  }

  function eligibleOriginality(duration) {
    return Number.isFinite(duration) && duration >= 10;
  }

  return { findEditor, collectBlocks, collectImages, audit, applyTypography, applyImageStyle, applyImageStyleBatch, findNativeVideoInput, findNativeVideoButton, findNativeToolbarVideoButton, findNativeVideoLibraryTab, findNativeVideoTitleInput, fillNativeVideoTitle, transferVideoFile, eligibleOriginality };
});
