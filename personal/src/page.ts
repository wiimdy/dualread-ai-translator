(() => {
  type RouteVersion = string | number;
  interface Piece { anchor: HTMLElement; text: string }
  interface Result extends Piece {
    route: RouteVersion;
    node: HTMLSpanElement;
    observer: MutationObserver;
    parent: Element | null;
    done: boolean;
  }
  const scope = globalThis as typeof globalThis & {
    dualReadPersonalReady?: boolean;
    LLMTranslatorShared: { getTranslationPlacement(tag: string): 'inside' | 'after' };
  };
  if (scope.dualReadPersonalReady) return;
  scope.dualReadPersonalReady = true;

  const MAX_PIECES = 12;
  const MAX_CHARS = 5000;
  const semantic = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dt,dd,td,th,pre,[role="paragraph"]';
  const exclude = ['form', 'input', 'select', 'textarea', 'button', 'script', 'style', 'template',
    'noscript', 'iframe', 'svg', 'canvas', '[contenteditable]', '[role="textbox"]', '[role="combobox"]',
    'nav', 'menu', '[role="menu"]', '[role="menuitem"]', '[role="menubar"]', '[role="toolbar"]', '[role="button"]',
    '[hidden]', '[inert]', '[aria-hidden="true" i]', '.llm-bilingual-translation', '.llm-bilingual-page-notice',
    '.sr-only', '.visually-hidden', '.screen-reader-only'].join(',');
  const results = new Map<HTMLElement, Result>();
  let notice: HTMLElement | undefined;
  let noticeTimer: number | undefined;
  let picking: RouteVersion | undefined;
  let running: symbol | undefined;
  let generation = 0;

  const dismissNotice = (): void => {
    window.clearTimeout(noticeTimer);
    notice?.remove();
    notice = undefined;
  };
  const notify = (text: string, persistent = false): void => {
    dismissNotice();
    notice = document.createElement('div');
    notice.className = 'llm-bilingual-page-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = text;
    Object.assign(notice.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', padding: '10px 16px', borderRadius: '8px', pointerEvents: 'none',
      background: '#172630', color: 'white', font: '500 14px/1.5 system-ui',
      maxWidth: 'min(90vw, 36rem)', width: 'max-content', boxShadow: '0 3px 18px #0004',
    });
    document.documentElement.append(notice);
    if (!persistent) noticeTimer = window.setTimeout(dismissNotice, 4500);
  };

  const anchorFor = (element: HTMLElement): HTMLElement | null => {
    for (let parent: HTMLElement | null = element; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.matches(semantic)) return parent;
      if (/^(block|flow-root|flex|grid|list-item|table-cell)$/.test(getComputedStyle(parent).display)) return parent;
    }
    return element.closest<HTMLElement>('a') ?? element;
  };

  const isPainted = (range: Range, parent: HTMLElement, anchor: HTMLElement): boolean => {
    let box = parent;
    while (box.parentElement && getComputedStyle(box).display === 'contents') box = box.parentElement;
    if (!box.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    let left = -window.scrollX;
    let top = -window.scrollY;
    let right = Math.max(document.documentElement.scrollWidth, innerWidth) - window.scrollX;
    let bottom = Math.max(document.documentElement.scrollHeight, innerHeight) - window.scrollY;
    const block = anchor.getBoundingClientRect();
    if (block.width && block.height) {
      left = Math.max(left, block.left);
      right = Math.min(right, block.right);
      top = Math.max(top, block.top);
      bottom = Math.min(bottom, block.bottom);
    }
    for (let el: HTMLElement | null = parent; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.clip !== 'auto' || style.clipPath !== 'none') return false;
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const rect = el.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
      if (style.overflowY !== 'visible') { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    return Array.from(range.getClientRects()).some((rect) =>
      Math.min(rect.right, right) > Math.max(rect.left, left) &&
      Math.min(rect.bottom, bottom) > Math.max(rect.top, top));
  };

  // The click path walks one block. The selection path prunes everything outside the explicit range.
  const extract = (range: Range, picked?: HTMLElement): Piece[] => {
    const root = range.commonAncestorContainer;
    if (!document.body?.contains(root) || document.designMode === 'on') return [];
    const parts = new Map<HTMLElement, string>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element && node.matches(exclude)) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element && picked && node.matches(semantic) && node !== picked) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const segment = document.createRange();
    let node: Node | null = root instanceof Text ? root : walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest(exclude) && (node instanceof Text || node instanceof HTMLBRElement)) {
        const anchor = anchorFor(parent);
        if (anchor && (!picked || anchor === picked)) {
          if (node instanceof HTMLBRElement && parts.has(anchor)) {
            parts.set(anchor, parts.get(anchor) + '\n');
          } else if (node instanceof Text) {
            const begin = range.startContainer === node ? range.startOffset : 0;
            const end = range.endContainer === node ? range.endOffset : node.length;
            segment.setStart(node, begin);
            segment.setEnd(node, end);
            if (isPainted(segment, parent, anchor)) {
              const piece = node.data.slice(begin, end);
              if (piece.trim() || parts.has(anchor)) {
                const text = (parts.get(anchor) ?? '') + piece;
                if (text.trim().length > MAX_CHARS) throw new Error('문단당 5,000자까지 번역합니다. 원하는 부분만 드래그해 주세요.');
                parts.set(anchor, text);
                if (parts.size > MAX_PIECES) throw new Error('한 번에 12개 문단까지 선택해 주세요.');
              }
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return Array.from(parts, ([anchor, text]) => ({ anchor, text: text.trim() })).filter((part) => part.text);
  };

  const selectionPieces = (): Piece[] => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.closest(exclude)) return [];
    return extract(selection.getRangeAt(0));
  };

  // Keep DualRead's inside/after contract. A child also stays below its source in a row or grid.
  const place = (item: Result): void => {
    const { anchor, node } = item;
    if (!anchor.isConnected) {
      item.observer.disconnect();
      node.remove();
      results.delete(anchor);
      return;
    }
    const parent = anchor.parentElement;
    const css = parent && getComputedStyle(parent);
    const horizontal = css && (css.display.includes('grid') || (css.display.includes('flex') && css.flexDirection.startsWith('row')));
    const inside = anchor === document.body || scope.LLMTranslatorShared.getTranslationPlacement(anchor.tagName) === 'inside' || horizontal;
    if (inside && node.parentElement !== anchor) anchor.append(node);
    if (!inside && anchor.nextElementSibling !== node) anchor.after(node);
    if (parent && parent !== item.parent) {
      item.observer.disconnect();
      item.observer.observe(parent, { childList: true });
      item.parent = parent;
    }
  };
  const resultFor = (piece: Piece, route: RouteVersion): Result => {
    const previous = results.get(piece.anchor);
    if (previous) {
      previous.text = piece.text;
      previous.route = route;
      previous.done = false;
      place(previous);
      return previous;
    }
    const node = document.createElement('span');
    node.dir = 'auto';
    node.setAttribute('role', 'status');
    Object.assign(node.style, {
      display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'normal 1rem/1.55 system-ui',
      margin: '0.3em 0 0.7em', paddingInlineStart: '0.7em', borderInlineStart: '2px solid #409684',
    });
    const item: Result = { ...piece, route, node, done: false, parent: null, observer: new MutationObserver((changes) => {
      if (changes.some((change) => Array.from(change.removedNodes).includes(piece.anchor))) place(item);
    }) };
    results.set(piece.anchor, item);
    place(item);
    return item;
  };

  const translate = async (pieces: Piece[], route: RouteVersion): Promise<number> => {
    if (!pieces.length) throw new Error('입력창 밖에서 번역할 문단이나 텍스트를 선택해 주세요.');
    if (running) throw new Error('번역 중입니다. 잠시 후 다시 시도해 주세요.');
    const token = Symbol();
    running = token;
    let count = 0;
    try {
      for (const piece of pieces) {
        if (token !== running || !piece.anchor.isConnected) break;
        const prev = results.get(piece.anchor);
        if (prev?.done && prev.node.isConnected && prev.text === piece.text && prev.route === route) { place(prev); continue; }
        const item = resultFor(piece, route);
        item.node.className = 'llm-bilingual-translation is-loading';
        item.node.textContent = '번역 중…';
        try {
          const reply = await chrome.runtime.sendMessage({ type: 'personal-translate', text: piece.text, routeVersion: route });
          if (token !== running) break;
          if (reply?.ok !== true || typeof reply.translation !== 'string' || !reply.translation.trim()) {
            throw new Error(typeof reply?.error === 'string' ? reply.error : '번역 응답이 비어 있습니다.');
          }
          place(item);
          if (!piece.anchor.isConnected) continue;
          item.node.className = 'llm-bilingual-translation is-done';
          item.node.textContent = reply.translation;
          item.done = true;
          count++;
        } catch (error: unknown) {
          if (token !== running) break;
          const message = error instanceof Error ? error.message : '번역에 실패했습니다.';
          item.node.className = 'llm-bilingual-translation is-error';
          item.node.textContent = message;
          throw new Error(count ? `${count}개 문단 번역 후 중단했습니다. ${message}` : message);
        }
      }
      return count;
    } finally {
      if (running === token) running = undefined;
    }
  };

  const stopPick = (): void => {
    picking = undefined;
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    dismissNotice();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.isTrusted && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopPick();
    }
  };
  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted || event.button !== 0 || picking === undefined) return;
    const route = picking;
    const target = event.composedPath()[0];
    if (!(target instanceof HTMLElement) || target.closest(exclude) || !document.body.contains(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPick();
    const originalGeneration = generation;
    try {
      const anchor = anchorFor(target);
      if (!anchor || anchor === document.body || anchor === document.documentElement) throw new Error('글이 있는 문단 안을 클릭해 주세요.');
      const range = document.createRange();
      range.selectNodeContents(anchor);
      const pieces = extract(range, anchor);
      if (pieces.some((piece) => /\n[\t ]*\n/.test(piece.text))) {
        throw new Error('이 글 영역에는 문단이 여러 개 있습니다. 원하는 문단만 드래그해서 번역해 주세요.');
      }
      void translate(pieces, route).then((count) => {
        if (originalGeneration === generation) notify(count ? '선택한 문단을 번역했습니다.' : '이미 번역한 문단입니다.');
      }, (error: unknown) => {
        if (originalGeneration === generation) notify(error instanceof Error ? error.message : '번역에 실패했습니다.');
      });
    } catch (error: unknown) { notify(error instanceof Error ? error.message : '문단을 읽을 수 없습니다.'); }
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['personal-pick', 'personal-selected', 'personal-clear'].includes(message?.type)) return;
    if (message.type === 'personal-clear') {
      generation++;
      stopPick();
      running = undefined;
      const count = results.size;
      for (const item of results.values()) { item.observer.disconnect(); item.node.remove(); }
      results.clear();
      respond({ ok: true, count });
      return;
    }
    const route = message.routeVersion;
    if (!(typeof route === 'string' && route.length > 0) && !(typeof route === 'number' && Number.isFinite(route))) {
      respond({ ok: false, error: '설정을 확인하고 다시 시도해 주세요.' });
      return;
    }
    if (message.type === 'personal-pick') {
      if (running) {
        respond({ ok: false, error: '번역 중입니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      if (picking !== undefined) stopPick();
      else {
        picking = route;
        notify('번역할 문단 하나를 클릭하세요. Esc로 취소할 수 있습니다.', true);
        window.addEventListener('click', onClick, true);
        window.addEventListener('keydown', onKey, true);
      }
      respond({ ok: true, picking: picking !== undefined });
      return;
    }
    stopPick();
    const originalGeneration = generation;
    void (async () => {
      try {
        const count = await translate(selectionPieces(), route);
        if (originalGeneration === generation) notify(count ? `${count}개 문단을 번역했습니다.` : '이미 번역한 선택 영역입니다.');
        respond({ ok: true, count });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : '선택 영역을 번역할 수 없습니다.';
        if (originalGeneration === generation) notify(detail);
        respond({ ok: false, error: detail });
      }
    })();
    return true;
  });
})();
