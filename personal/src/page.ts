(() => {
  type RouteVersion = string | number;
  interface Piece {
    anchor: HTMLElement;
    typography: HTMLElement;
    text: string;
    literals: Map<HTMLElement, string>;
  }
  interface Result extends Piece {
    route: RouteVersion;
    node: HTMLSpanElement;
    observer?: MutationObserver;
    parent: Element | null;
    done: boolean;
    translation?: string;
    inlineStyles: Map<HTMLElement, HTMLElement>;
  }
  const scope = globalThis as typeof globalThis & {
    dualReadPersonalReady?: boolean;
    LLMTranslatorShared: { getTranslationPlacement(tag: string): 'inside' | 'after' };
  };
  if (scope.dualReadPersonalReady) return;
  scope.dualReadPersonalReady = true;

  const MAX_CHARS = 5000;
  const semantic = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dt,dd,td,th,pre,[role="paragraph"],[role="heading"]';
  const exclude = ['form', 'input', 'select', 'textarea', 'button', 'script', 'style', 'template',
    'noscript', 'iframe', 'svg', 'canvas', '[contenteditable]', '[role="textbox"]', '[role="combobox"]',
    'nav', 'menu', '[role="menu"]', '[role="menuitem"]', '[role="menubar"]', '[role="toolbar"]', '[role="button"]',
    '[hidden]', '[inert]', '[aria-hidden="true" i]', '.llm-bilingual-translation', '.llm-bilingual-page-notice',
    '.sr-only', '.visually-hidden', '.screen-reader-only'].join(',');
  const pageExclude = ['input', 'select', 'textarea', 'option', 'datalist', 'output', 'script', 'style', 'template',
    'noscript', 'iframe', 'svg', 'canvas', '[contenteditable]', '[role="textbox"]', '[role="searchbox"]',
    '[role="combobox"]', '[hidden]', '[inert]', '[aria-hidden="true" i]', '.llm-bilingual-translation',
    '.llm-bilingual-page-notice', '.sr-only', '.visually-hidden', '.screen-reader-only'].join(',');
  const inlineLabel = 'a,button,label,summary,[role="button"],[role="menuitem"],[role="tab"]';
  const phrasing = 'a,span,small,strong,b,em,i,cite,time,abbr,mark';
  const navigation = 'nav,menu,[role="navigation"],[role="menu"],[role="menubar"],[role="toolbar"]';
  const MAX_REQUESTS = 3;
  const BATCH_SIZE = 5;
  const CACHE_ITEMS = 256;
  const SCAN_BUDGET_MS = 10;
  const VIEWPORT_NEIGHBORS = 48;
  const results = new Map<HTMLElement, Result>();
  let notice: HTMLElement | undefined;
  let noticeTimer: number | undefined;
  let picking: RouteVersion | undefined;
  let running: symbol | undefined;
  let preserveSelection: ((piece: Piece) => void) | undefined;
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

  // Some publishers put a visually distinct title and its body on opposite sides of a <br>.
  const standaloneHeading = (element: HTMLElement): boolean => {
    const parent = element.parentElement;
    if (!parent || !element.matches('span,strong,b,em') || element.closest(inlineLabel)) return false;
    const neighbor = (next: boolean): ChildNode | null => {
      let node = next ? element.nextSibling : element.previousSibling;
      while (node && ((node instanceof Text && !node.data.trim()) ||
          (node instanceof Element && node.matches('.llm-bilingual-translation')))) {
        node = next ? node.nextSibling : node.previousSibling;
      }
      return node;
    };
    if (!(neighbor(true) instanceof HTMLBRElement)) return false;
    const before = neighbor(false);
    if (before && !(before instanceof HTMLBRElement)) return false;
    const style = getComputedStyle(element);
    const surrounding = getComputedStyle(parent);
    return parseFloat(style.fontSize) > parseFloat(surrounding.fontSize) ||
      parseFloat(style.fontWeight) > parseFloat(surrounding.fontWeight);
  };
  const anchorFor = (element: HTMLElement): HTMLElement | null => {
    for (let parent: HTMLElement | null = element; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.matches(semantic) || standaloneHeading(parent)) return parent;
      if (/^(block|flow-root|flex|grid|list-item|table-cell)$/.test(getComputedStyle(parent).display)) return parent;
    }
    return element.closest<HTMLElement>('a') ?? element;
  };

  // A link embedded in an unmarked sentence belongs to the same unit as its surrounding words.
  const hasInlineProse = (link: HTMLElement, block: HTMLElement): boolean => {
    if (block === document.body || link.closest(navigation) ||
        !getComputedStyle(link).display.startsWith('inline')) return false;
    for (let part = link; part !== block && part.parentElement; part = part.parentElement) {
      for (const direction of ['previousSibling', 'nextSibling'] as const) {
        let neighbor = part[direction];
        while (neighbor && (neighbor.nodeType === Node.COMMENT_NODE ||
            (neighbor instanceof Text && !neighbor.data.trim()) ||
            (neighbor instanceof HTMLElement && neighbor.matches('.llm-bilingual-translation')))) {
          neighbor = neighbor[direction];
        }
        if (neighbor instanceof Text && /[\p{L}\p{N}]/u.test(neighbor.data)) return true;
        if (neighbor instanceof HTMLElement && !neighbor.matches(inlineLabel + ',' + pageExclude) &&
            getComputedStyle(neighbor).display.startsWith('inline') && !neighbor.querySelector(inlineLabel) &&
            /[\p{L}\p{N}]/u.test(neighbor.textContent ?? '')) return true;
      }
    }
    return false;
  };

  // In a horizontal flex credit, CSS turns each inline word, link or punctuation mark into a block.
  const inlineFlexGroup = (element: HTMLElement): HTMLElement | null => {
    for (let item = element; item.matches(phrasing) && item.parentElement; item = item.parentElement) {
      const row = item.parentElement;
      const css = getComputedStyle(row);
      if (!css.display.endsWith('flex') || !css.flexDirection.startsWith('row') ||
          row.matches(inlineLabel) || row.closest(navigation)) continue;
      let containsItem = false;
      let hasLink = false;
      let hasWords = false;
      for (const child of row.childNodes) {
        if (child instanceof Text) { hasWords ||= /\p{L}/u.test(child.data); continue; }
        if (!(child instanceof HTMLElement) || child.matches('.llm-bilingual-translation')) continue;
        // An icon or a separate control commonly marks the start of a second item, such as a view count.
        if (!child.matches(phrasing) || child.matches(pageExclude) ||
            child.querySelector('svg,img,button,input') || child.matches('[role="button"],[role="tab"]')) break;
        containsItem ||= child === item;
        if (child.matches('a') || child.querySelector('a')) hasLink = true;
        else hasWords ||= /\p{L}/u.test(child.textContent ?? '');
      }
      if (containsItem && hasLink && hasWords) return row;
    }
    return null;
  };

  const pageAnchor = (parent: HTMLElement): HTMLElement | null => {
    const group = inlineFlexGroup(parent);
    if (group) return group;
    const label = parent.closest<HTMLElement>(inlineLabel);
    if (!label) return anchorFor(parent);
    if (!label.matches('a')) return label;
    const block = anchorFor(parent);
    // Cards can wrap headings and standfirsts in a single link. Keep each child block separate.
    if (block && block !== label && label.contains(block)) return block;
    if (parent.closest(semantic)?.contains(label)) return block;
    const surrounding = label.parentElement && anchorFor(label.parentElement);
    return surrounding && surrounding.contains(label) && hasInlineProse(label, surrounding) ? surrounding : label;
  };

  const isPainted = (range: Range, parent: HTMLElement, anchor: HTMLElement, page: boolean): boolean => {
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
      const xScrollable = page && /^(auto|scroll|overlay)$/.test(style.overflowX);
      const yScrollable = page && /^(auto|scroll|overlay)$/.test(style.overflowY);
      if (xScrollable) { left -= Math.abs(el.scrollLeft); right += el.scrollWidth - el.clientWidth; }
      if (yScrollable) { top -= el.scrollTop; bottom += el.scrollHeight - el.clientHeight; }
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const rect = el.getBoundingClientRect();
      if (!xScrollable && style.overflowX !== 'visible') { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
      if (!yScrollable && style.overflowY !== 'visible') { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    return Array.from(range.getClientRects()).some((rect) =>
      Math.min(rect.right, right) > Math.max(rect.left, left) &&
      Math.min(rect.bottom, bottom) > Math.max(rect.top, top));
  };

  // The click path walks one block. The selection path prunes everything outside the explicit range.
  const extract = (range: Range, picked?: HTMLElement, page = false): Piece[] => {
    const excluded = page ? pageExclude : exclude;
    const root = range.commonAncestorContainer;
    if (!document.body?.contains(root) || document.designMode === 'on') return [];
    const parts = new Map<HTMLElement, Piece>();
    const ends = new Map<HTMLElement, { node: Text; offset: number }>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element && node.matches(excluded)) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element && picked && node.matches(semantic) && node !== picked) return NodeFilter.FILTER_REJECT;
        if (page && picked && node instanceof HTMLElement && pageAnchor(node) !== picked) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const segment = document.createRange();
    let node: Node | null = root instanceof Text ? root : walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest(excluded) && (node instanceof Text || node instanceof HTMLBRElement)) {
        const anchor = page ? pageAnchor(parent) : anchorFor(parent);
        if (anchor && (!picked || anchor === picked)) {
          const prior = parts.get(anchor);
          if (node instanceof HTMLBRElement && prior && node.checkVisibility({ checkVisibilityCSS: true })) {
            const collapse = getComputedStyle(parent).whiteSpaceCollapse;
            if (collapse === 'collapse' || collapse === 'preserve-breaks') prior.text = prior.text.replace(/ $/, '');
            prior.text += '\n';
          } else if (node instanceof Text) {
            const begin = range.startContainer === node ? range.startOffset : 0;
            const end = range.endContainer === node ? range.endOffset : node.length;
            segment.setStart(node, begin);
            segment.setEnd(node, end);
            if (isPainted(segment, parent, anchor, page)) {
              const collapse = getComputedStyle(parent).whiteSpaceCollapse;
              let text = node.data.slice(begin, end);
              if (collapse === 'collapse') text = text.replace(/[\t\n\f\r ]+/g, ' ');
              if (collapse === 'preserve-breaks') text = text.replace(/[\t\f ]+/g, ' ').replace(/ ?\n ?/g, '\n');
              if (text.trim() || prior) {
                const piece = prior ?? { anchor, typography: parent, text: '', literals: new Map<HTMLElement, string>() };
                if (text.trim()) {
                  while (!piece.typography.contains(parent) && piece.typography.parentElement) {
                    piece.typography = piece.typography.parentElement;
                  }
                }
                const literal = parent.closest<HTMLElement>('code,kbd,samp,em,strong,i,b,mark');
                if (literal && anchor.contains(literal)) piece.literals.set(literal, (piece.literals.get(literal) ?? '') + text);
                if ((collapse === 'collapse' || collapse === 'preserve-breaks') && /[ \n]$/.test(piece.text)) {
                  text = text.replace(/^ /, '');
                }
                // CSS can separate adjacent words with a margin or flex gap instead of a space.
                const last = ends.get(anchor);
                if (collapse === 'collapse' && last && last.node.parentElement !== parent &&
                    /[\p{L}\p{N}]$/u.test(piece.text) && /^[\p{L}\p{N}]/u.test(text)) {
                  const caret = document.createRange();
                  caret.setStart(last.node, last.offset);
                  caret.collapse(true);
                  const left = caret.getBoundingClientRect();
                  caret.setStart(node, begin);
                  caret.collapse(true);
                  const right = caret.getBoundingClientRect();
                  if (left.bottom > right.top && right.bottom > left.top &&
                      Math.abs(left.x - right.x) > Math.min(left.height, right.height) * 0.12) {
                    piece.text += ' ';
                  }
                }
                piece.text += text;
                ends.set(anchor, { node, offset: end });
                parts.set(anchor, piece);
              }
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return Array.from(parts.values()).filter((piece) => {
      if (getComputedStyle(piece.typography).whiteSpaceCollapse === 'collapse') piece.text = piece.text.trim();
      return piece.text.trim();
    });
  };

  const selectionPieces = (): Piece[] => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.closest(pageExclude)) return [];
    return extract(selection.getRangeAt(0), undefined, true);
  };

  const copyInlineStyle = (element: HTMLElement, original: HTMLElement): void => {
    const style = getComputedStyle(original);
    Object.assign(element.style, {
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      fontStyle: style.fontStyle, color: style.color, backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius, padding: style.padding,
    });
  };
  const styleResult = (item: Result, inside: boolean): void => {
    const { anchor, node } = item;
    const source = getComputedStyle(anchor);
    const type = item.typography === anchor ? source : getComputedStyle(item.typography);
    const blockLink = anchor instanceof HTMLAnchorElement && !source.display.startsWith('inline') && source.display !== 'contents';
    const inline = (anchor.matches(inlineLabel) && !blockLink) ||
      (source.display === 'inline' && !anchor.matches('[role="heading"]') && !standaloneHeading(anchor));
    const preserveSpaces = /^(preserve|break-spaces)$/.test(type.whiteSpaceCollapse);
    const fontSize = parseFloat(type.fontSize);
    const marginEnd = Math.max(0, parseFloat(source.marginBlockEnd) || 0);
    const pairGap = 0.16 * fontSize;
    const inset = Math.min(fontSize * 0.45, inside ? 6 : 9);
    const leftAligned = source.textAlign === 'left' || (source.textAlign === 'start' && source.direction === 'ltr');
    const compact = leftAligned && !preserveSpaces && source.writingMode === 'horizontal-tb';
    const widthLimit = !inside && source.inlineSize.endsWith('px') ? `min(100%, ${source.inlineSize})` : '100%';
    Object.assign(node.style, {
      display: inline ? 'inline' : 'block',
      whiteSpace: preserveSpaces ? type.whiteSpace : item.text.includes('\n') ? 'pre-line' : 'normal',
      wordBreak: !preserveSpaces && type.wordBreak === 'normal' ? 'keep-all' : type.wordBreak,
      overflowWrap: preserveSpaces ? type.overflowWrap : 'anywhere', fontFamily: type.fontFamily, fontSize: type.fontSize,
      fontStyle: type.fontStyle, fontWeight: type.fontWeight, fontStretch: type.fontStretch,
      fontVariationSettings: type.fontVariationSettings, lineHeight: type.lineHeight,
      letterSpacing: type.letterSpacing, wordSpacing: type.wordSpacing, textAlign: source.textAlign,
      textIndent: inline ? '0' : source.textIndent, writingMode: source.writingMode,
      boxSizing: 'border-box', inlineSize: inline ? 'auto' : compact ? 'fit-content' : inside ? 'auto' : source.inlineSize,
      maxInlineSize: inline ? 'none' : widthLimit, borderRadius: inline ? '0' : '4px',
      color: `color-mix(in srgb, ${type.color} 94%, transparent)`,
      backgroundColor: inline ? 'transparent' : `color-mix(in srgb, ${type.color} 5%, transparent)`,
      marginInlineStart: inline ? '0.32em' : inside ? '0' : source.marginInlineStart,
      marginInlineEnd: inline || inside ? '0' : source.marginInlineEnd,
      paddingBlock: inline ? '0' : 'min(0.2em, 6px)',
      paddingInlineStart: inline ? '0' : `calc(${inside ? '0px' : source.paddingInlineStart} + ${inset}px)`,
      paddingInlineEnd: inline ? '0' : `calc(${inside ? '0px' : source.paddingInlineEnd} + ${inset}px)`,
      // A sibling otherwise inherits the full original paragraph break before its translation.
      marginBlockStart: inline ? '0' : `${inside || marginEnd <= pairGap ? pairGap : pairGap - marginEnd}px`,
      marginBlockEnd: inline || inside ? '0' : `${Math.max(fontSize * 0.5, Math.min(marginEnd, fontSize))}px`,
    });
    item.inlineStyles.forEach((original, element) => copyInlineStyle(element, original));
  };

  const rankedLayouts = new Map<HTMLElement, () => void>();
  const rankMarker = 'data-dualread-ranked-list';
  let rankLayoutId = 0;
  // A live ranking can position fixed-height cards over each other while drawing the
  // numbers in a separate column. Give both columns the same intrinsic grid tracks.
  const fitRankedList = (anchor: HTMLElement): void => {
    for (let row: HTMLElement | null = anchor; row?.parentElement; row = row.parentElement) {
      const articles = row.parentElement;
      const list = articles.parentElement;
      if (!list || rankedLayouts.has(list)) return;
      if (!row.style.transform.startsWith('translateY(') || getComputedStyle(row).position !== 'absolute' ||
          list.hasAttribute(rankMarker) || list.children.length !== 2 || list.lastElementChild !== articles) continue;
      const ranks = list.firstElementChild!;
      if (ranks.children.length < 2 || !Array.from(ranks.children).every((rank, index) =>
        rank.textContent?.trim().replace(/\.$/, '') === String(index + 1))) continue;
      const marker = String(++rankLayoutId);
      const selector = `[${rankMarker}="${marker}"]`;
      const sheet = new CSSStyleSheet();
      const gap = getComputedStyle(ranks).rowGap;
      const trackRows = (): void => {
        const entries = Array.from(articles.children);
        const shifts = entries.map((entry) => entry instanceof HTMLElement ?
          /^translateY\((-?[\d.]+)px\)$/.exec(entry.style.transform) : null);
        if (shifts.some((match) => !match)) return;
        const offsets = shifts.map((match) => Number(match![1]));
        const positions = [...new Set(offsets)].sort((a, b) => a - b);
        const count = Math.max(ranks.children.length, positions.length);
        const cards = selector + ' > :nth-child(2)';
        sheet.replaceSync(`
          ${selector} { display:grid!important; grid-template-columns:max-content minmax(0,1fr)!important;
            grid-auto-rows:max-content!important; align-content:start!important; gap:${gap} 0!important; overflow:auto!important; }
          ${selector} > * { display:grid!important; grid-template-rows:subgrid!important; grid-row:1/span ${count}!important;
            row-gap:inherit!important; height:auto!important; min-height:0!important; }
          ${selector} > :first-child { grid-column:1!important; }
          ${cards} { grid-column:2!important; min-width:0!important; }
          ${cards} > * { position:relative!important; inset:auto!important; height:auto!important; transform:none!important;
            grid-column:1!important; }
          ${offsets.map((offset, index) => `${cards} > :nth-child(${index + 1}) { grid-row:${positions.indexOf(offset) + 1}!important; }`).join('\n')}
        `);
      };
      trackRows();
      if (!sheet.cssRules.length) return;
      list.setAttribute(rankMarker, marker);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const watch = new MutationObserver((records) => {
        if (!list.isConnected || list.firstElementChild !== ranks || list.lastElementChild !== articles ||
            !list.querySelector('.llm-bilingual-translation')) { release(); return; }
        if (records.some(({ target, type }) => target === ranks || target === articles ||
            (type === 'attributes' && target.parentElement === articles))) trackRows();
      });
      watch.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      const release = (): void => {
        watch.disconnect();
        list.removeAttribute(rankMarker);
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((active) => active !== sheet);
        rankedLayouts.delete(list);
      };
      rankedLayouts.set(list, release);
      return;
    }
  };

  // Keep DualRead's inside/after contract. A child also stays with its source in a row or grid.
  const place = (item: Result): void => {
    const { anchor, node } = item;
    if (!anchor.isConnected) {
      item.observer?.disconnect();
      node.remove();
      results.delete(anchor);
      return;
    }
    const parent = anchor.parentElement;
    // An image and its single text heading often share one link. Place the translation
    // outside that link without cloning the URL or expanding its click target.
    const singleTextLink = parent instanceof HTMLAnchorElement && Array.from(parent.childNodes)
      .every((child) => child === anchor || child === node || !child.textContent?.trim());
    const after = singleTextLink ? parent : anchor;
    const container = after.parentElement;
    const css = container && getComputedStyle(container);
    const horizontal = css && (css.display.includes('grid') || (css.display.includes('flex') && css.flexDirection.startsWith('row')));
    const inside = anchor === document.body || scope.LLMTranslatorShared.getTranslationPlacement(anchor.tagName) === 'inside' || horizontal;
    if (inside && node.parentElement !== anchor) anchor.append(node);
    if (!inside && after.nextElementSibling !== node) after.after(node);
    fitRankedList(anchor);
    styleResult(item, Boolean(inside));
    if (item.observer && parent && parent !== item.parent) {
      item.observer?.disconnect();
      for (let el: HTMLElement | null = anchor; el; el = el.parentElement) {
        item.observer.observe(el, { attributes: true, childList: el !== anchor, subtree: el === anchor,
          attributeFilter: ['class', 'style', 'dir', 'lang', 'theme', 'data-theme', 'data-color-mode'] });
      }
      item.parent = parent;
    }
  };
  let styleFrame: number | undefined;
  const refreshStyles = (): void => {
    if (!results.size || styleFrame !== undefined) return;
    styleFrame = requestAnimationFrame(() => {
      styleFrame = undefined;
      for (const item of results.values()) place(item);
    });
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshStyles);
  window.addEventListener('resize', refreshStyles);
  const resultFor = (piece: Piece, route: RouteVersion, page = false): Result => {
    const previous = results.get(piece.anchor);
    if (previous) {
      previous.text = piece.text;
      previous.literals = piece.literals;
      previous.typography = piece.typography;
      previous.route = route;
      previous.done = false;
      place(previous);
      return previous;
    }
    const node = document.createElement('span');
    node.className = 'llm-bilingual-translation';
    node.lang = 'ko';
    node.dir = 'auto';
    node.setAttribute('role', 'status');
    const item: Result = { ...piece, route, node, done: false, parent: null, inlineStyles: new Map() };
    if (!page) item.observer = new MutationObserver((changes) => {
      const moved = changes.some((change) => Array.from(change.removedNodes).some((removed) => removed.contains(item.anchor)));
      if (moved) item.parent = null;
      const restyled = changes.some((change) => change.type === 'attributes' && change.target instanceof Element &&
        !change.target.closest('.llm-bilingual-translation,.llm-bilingual-page-notice'));
      if (moved || restyled) place(item);
    });
    results.set(piece.anchor, item);
    place(item);
    return item;
  };

  // Match only literals read from visible formatting in this source or selection. Model output is always text.
  const showTranslation = (item: Result, translation: string): void => {
    const matches: { start: number; end: number; original: HTMLElement }[] = [];
    const seen = new Set<string>();
    const identifier = /[a-zA-Z0-9_]/;
    for (const [original, text] of item.literals) {
      const literal = text.trim();
      if (!literal || seen.has(literal) || !item.text.includes(literal)) continue;
      seen.add(literal);
      let start = translation.indexOf(literal);
      while (start !== -1) {
        const end = start + literal.length;
        if (!(identifier.test(literal[0]) && identifier.test(translation.charAt(start - 1))) &&
            !(identifier.test(literal.at(-1)!) && identifier.test(translation.charAt(end)))) {
          matches.push({ start, end, original });
        }
        start = translation.indexOf(literal, end);
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const content = document.createDocumentFragment();
    let offset = 0;
    item.inlineStyles.clear();
    for (const { start, end, original } of matches) {
      if (start < offset) continue;
      content.append(translation.slice(offset, start));
      const element = document.createElement(original.localName);
      element.textContent = translation.slice(start, end);
      item.inlineStyles.set(element, original);
      copyInlineStyle(element, original);
      content.append(element);
      offset = end;
    }
    content.append(translation.slice(offset));
    item.node.className = 'llm-bilingual-translation is-done';
    item.node.removeAttribute('aria-busy');
    item.node.replaceChildren(content);
    item.translation = translation;
    item.done = true;
  };

  const chunksFor = (text: string): string[] => {
    const chunks: string[] = [];
    let start = 0;
    while (text.length - start > MAX_CHARS) {
      const limit = start + MAX_CHARS;
      let end = limit;
      while (end > start + MAX_CHARS / 2 && !/\s/u.test(text[end - 1])) end--;
      if (end <= start + MAX_CHARS / 2) end = limit;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(start, end));
      start = end;
    }
    chunks.push(text.slice(start));
    return chunks;
  };

  interface SingleReply { ok?: boolean; translation?: string; error?: string }
  const requestOne = async (text: string, route: RouteVersion, active: () => boolean,
    firstChunk?: (chunk: string) => Promise<SingleReply>): Promise<string> => {
    let output = '';
    for (const chunk of chunksFor(text)) {
      if (!active()) return '';
      if (!chunk.trim()) { output += chunk; continue; }
      const reply = firstChunk ? await firstChunk(chunk) :
        await chrome.runtime.sendMessage({ type: 'personal-translate', text: chunk, routeVersion: route });
      firstChunk = undefined;
      if (reply?.ok !== true || typeof reply.translation !== 'string' || !reply.translation.trim()) {
        throw new Error(typeof reply?.error === 'string' ? reply.error : '번역 응답이 비어 있습니다.');
      }
      output += chunk.match(/^\s*/u)![0] + reply.translation.trim() + chunk.match(/\s*$/u)![0];
    }
    return output;
  };

  const translate = async (pieces: Piece[], route: RouteVersion): Promise<number> => {
    if (!pieces.length) throw new Error('입력창 밖에서 번역할 문단이나 텍스트를 선택해 주세요.');
    if (running) throw new Error('번역 중입니다. 잠시 후 다시 시도해 주세요.');
    const token = Symbol();
    running = token;
    let count = 0;
    try {
      for (const piece of pieces) {
        if (token !== running) break;
        if (!piece.anchor.isConnected) continue;
        preserveSelection?.(piece);
        const prev = results.get(piece.anchor);
        if (prev?.done && prev.node.isConnected && prev.text === piece.text && prev.route === route) { place(prev); continue; }
        const cached = cachedRoute === route ? pageCache.get(piece.text) : undefined;
        const item = resultFor(piece, route);
        if (cached !== undefined) {
          showTranslation(item, cached);
          count++;
          continue;
        }
        item.node.className = 'llm-bilingual-translation is-loading';
        item.node.textContent = '번역 중…';
        try {
          const pending = cachedRoute === route ? pendingPage.get(piece.text) : undefined;
          if (pending) await pending;
          if (token !== running) break;
          const translated = (cachedRoute === route ? pageCache.get(piece.text) : undefined) ??
            await requestOne(piece.text, route, () => token === running);
          if (token !== running) break;
          place(item);
          if (!piece.anchor.isConnected) continue;
          showTranslation(item, translated);
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

  let stopPage: (() => void) | undefined;

  const elapsedUnits: Record<string, string> = {
    second: '초', minute: '분', hour: '시간', day: '일', week: '주', month: '개월', year: '년',
  };
  const elapsedLabel = (text: string): string | undefined => {
    const match = /^(\+)?(\d+) (second|minute|hour|day|week|month|year)s? ago$/i.exec(text);
    if (match) return match[2] + elapsedUnits[match[3].toLowerCase()] + (match[1] ? ' 이상 전' : ' 전');
  };

  const pageCache = new Map<string, string>();
  const pendingPage = new Map<string, Promise<void>>();
  let cachedRoute: RouteVersion | undefined;
  const remember = (text: string, translation: string): void => {
    if (text.length > MAX_CHARS || translation.length > MAX_CHARS * 4) return;
    pageCache.delete(text);
    pageCache.set(text, translation);
    if (pageCache.size > CACHE_ITEMS) pageCache.delete(pageCache.keys().next().value!);
  };
  const startPage = (route: RouteVersion): void => {
    if (route !== cachedRoute) { pageCache.clear(); cachedRoute = route; }
    const tracked = new Set<HTMLElement>();
    const nearby = new Set<HTMLElement>();
    const desired = new Map<HTMLElement, string>();
    const pieces = new WeakMap<HTMLElement, Piece>();
    const manualSources = new WeakMap<HTMLElement, string>();
    const subscribers = new Map<string, Set<HTMLElement>>();
    const waiting = new Set<string>();
    const dirty = new Set<HTMLElement>();
    const roots = new Set<HTMLElement>();
    let walker: TreeWalker | undefined;
    let scanTimer: number | undefined;
    let active = true;
    let failed = false;
    let started = false;
    let leadChosen = false;
    let leadAnchor: HTMLElement | undefined;
    let startingLead = false;
    const leadLifetime = new AbortController();
    const deferred = new Map<HTMLElement, { source: string; translation: string }>();
    let initialObservation: HTMLElement | undefined;
    let requests = 0;
    let singleOnly = false;
    let readingStreak = 0;
    let readingSincePrefetch = 0;
    let firstPrefetched: string | undefined;
    const MAX_READING_STREAK = 6;
    const LOOKAHEAD_VIEWPORTS = 2;
    const READING_TEXT_CHARS = 24;
    const COMPACT_LABEL_CHARS = 48;

    const onScreen = (anchor: HTMLElement): boolean => {
      const rect = anchor.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    };
    const removeResult = (anchor: HTMLElement): void => {
      const item = results.get(anchor);
      if (!item) return;
      item.observer?.disconnect();
      item.node.remove();
      results.delete(anchor);
    };
    const unsubscribe = (anchor: HTMLElement): void => {
      const old = desired.get(anchor);
      desired.delete(anchor);
      if (!old) return;
      const anchors = subscribers.get(old);
      anchors?.delete(anchor);
      if (!anchors?.size && waiting.delete(old)) subscribers.delete(old);
    };
    const render = (anchor: HTMLElement, source: string, translation: string): void => {
      if (!active || !anchor.isConnected || desired.get(anchor) !== source || anchor.closest(pageExclude)) return;
      const piece = pieces.get(anchor);
      if (piece?.text !== source) return;
      // An early title or byline can push the lead translation below the viewport.
      if (leadAnchor?.isConnected && onScreen(leadAnchor) &&
          (leadAnchor.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_PRECEDING)) {
        deferred.set(anchor, { source, translation });
        return;
      }
      showTranslation(resultFor(piece, route, true), translation);
    };
    const readSource = (anchor: HTMLElement): Piece | undefined => {
      if (!anchor.isConnected || anchor.closest(pageExclude)) return;
      const range = document.createRange();
      range.selectNodeContents(anchor);
      return extract(range, anchor, true)[0];
    };
    // A pending full-block reply must not overwrite a user's partial selection.
    preserveSelection = ({ anchor }) => {
      manualSources.set(anchor, desired.get(anchor) ?? readSource(anchor)?.text ?? '');
      unsubscribe(anchor);
    };
    const refresh = (anchor: HTMLElement): void => {
      const piece = readSource(anchor);
      const text = piece?.text ?? '';
      if (manualSources.get(anchor) === text) return;
      manualSources.delete(anchor);
      if (piece) pieces.set(anchor, piece);
      if (desired.get(anchor) === text && text) {
        const item = results.get(anchor);
        if (piece && item?.done && item.text === text) {
          item.typography = piece.typography;
          place(item);
          if (item.translation !== undefined && (item.literals.size !== piece.literals.size ||
              Array.from(piece.literals).some(([element, literal]) => item.literals.get(element) !== literal))) {
            item.literals = piece.literals;
            showTranslation(item, item.translation);
          }
        }
        return;
      }
      unsubscribe(anchor);
      if (!text || /^(?:\d{1,4}[.)]?|[,.;:|•·…–—-]+)$/.test(text)) { removeResult(anchor); return; }
      desired.set(anchor, text);
      const current = results.get(anchor);
      if (current?.done && current.text === text && current.route === route) {
        remember(text, current.translation ?? '');
        place(current);
        return;
      }
      removeResult(anchor);
      const elapsed = elapsedLabel(text);
      if (elapsed !== undefined) { render(anchor, text, elapsed); return; }
      const cached = pageCache.get(text);
      if (cached !== undefined) { render(anchor, text, cached); return; }
      const anchors = subscribers.get(text);
      if (anchors) anchors.add(anchor);
      else { subscribers.set(text, new Set([anchor])); waiting.add(text); }
    };
    const isReadingText = (anchor: HTMLElement, text: string): boolean => {
      if (anchor.closest('nav,menu,footer,aside,button,time,[role="navigation"],[role="toolbar"],[role="button"],[role="tab"]')) return false;
      if (anchor.closest('h1')) return true;
      // A one-word section link often shares the heading tag with the actual stories below it.
      if (!/\s/u.test(text) && (anchor.closest('a') || anchor.querySelector('a'))) return false;
      if (anchor.closest('h2,h3,h4,h5,h6,p,blockquote,pre,[role="heading"],[role="paragraph"]')) return true;
      // Many news cards use an ordinary link for the headline.
      return text.length >= READING_TEXT_CHARS && /\s/u.test(text) && Boolean(anchor.closest('main,article,[role="main"]'));
    };
    const bodyParagraph = 'p,blockquote,[role="paragraph"]';
    const isBodyParagraph = (anchor: HTMLElement): boolean => anchor.matches(bodyParagraph) &&
      !anchor.closest('header,aside,footer,' + navigation + ',[role="banner"],[itemprop="author"]') &&
      !anchor.querySelector('time,[rel~="author"]');
    const nearbySources = () => {
      const queues = { reading: new Set<string>(), other: new Set<string>(), ahead: new Set<string>(), behind: new Set<string>() };
      const entries: { text: string; anchor: HTMLElement; queue: keyof typeof queues }[] = [];
      const margin = innerHeight * LOOKAHEAD_VIEWPORTS;
      for (const text of waiting) {
        for (const anchor of subscribers.get(text) ?? []) {
          if (!nearby.has(anchor)) continue;
          const { top, bottom, left, right } = anchor.getBoundingClientRect();
          if (right <= 0 || left >= innerWidth || top >= innerHeight + margin || bottom <= -margin) continue;
          const queue = top >= innerHeight ? 'ahead' : bottom <= 0 ? 'behind' : isReadingText(anchor, text) ? 'reading' : 'other';
          entries.push({ text, anchor, queue });
        }
      }
      entries.sort((a, b) => a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
      let lead: { text: string; anchor: HTMLElement } | undefined;
      for (const entry of entries) {
        const { text, anchor, queue } = entry;
        queues[queue].add(text);
        if (!leadChosen && !lead && queue === 'reading' && isBodyParagraph(anchor) && /\p{L}/u.test(text)) lead = entry;
      }
      if (!leadChosen && !lead) {
        lead = entries.find(({ queue, anchor, text }) => queue === 'reading' && text.length >= COMPACT_LABEL_CHARS &&
          anchor.closest('article,main,[role="main"]') && !anchor.closest('header,a,h1,h2,h3,h4,h5,h6,[role="heading"]') &&
          !anchor.querySelector('a,time') && !anchor.matches('pre'));
      }
      for (const text of queues.reading) queues.other.delete(text);
      for (const text of [...queues.reading, ...queues.other]) queues.ahead.delete(text);
      return { ...queues, lead };
    };
    const streamLead = (source: string, chunk: string): Promise<SingleReply> => new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'personal-body-stream' });
      const anchor = leadAnchor!;
      const signal = leadLifetime.signal;
      const unblock = (): void => {
        if (!startingLead) return;
        startingLead = false;
        pump();
      };
      const close = (): void => {
        signal.removeEventListener('abort', cancel);
        port.disconnect();
      };
      const cancel = (): void => {
        close();
        reject(new Error('본문 번역이 취소됐습니다.'));
      };
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        signal.removeEventListener('abort', cancel);
        reject(new Error(error?.message || '본문 번역 연결이 종료됐습니다.'));
      });
      port.onMessage.addListener((reply) => {
        if (reply?.event === 'started') { unblock(); return; }
        if (reply?.event === 'delta' && typeof reply.text === 'string') {
          unblock();
          const piece = pieces.get(anchor);
          if (!reply.text || !active || failed || !anchor.isConnected || anchor.closest(pageExclude) ||
              desired.get(anchor) !== source || piece?.text !== source) return;
          let item = results.get(anchor);
          if (!item?.node.classList.contains('is-streaming')) {
            item = resultFor(piece, route, true);
            item.node.className = 'llm-bilingual-translation is-streaming';
            item.node.setAttribute('aria-busy', 'true');
            item.node.replaceChildren(document.createTextNode(''));
          }
          (item.node.firstChild as Text).appendData(reply.text);
          return;
        }
        close();
        resolve(reply);
      });
      signal.addEventListener('abort', cancel, { once: true });
      port.postMessage({ text: chunk, routeVersion: route });
    });
    const fetchGroup = async (texts: string[], lead: boolean): Promise<void> => {
      let translations: string[];
      if (texts.length === 1) translations = [await requestOne(texts[0], route, () => active && !failed,
        lead ? (chunk) => streamLead(texts[0], chunk) : undefined)];
      else {
        const reply = await chrome.runtime.sendMessage({ type: 'personal-translate-batch', texts, routeVersion: route });
        const malformed = reply?.code === 'INVALID_BATCH_OUTPUT' || (reply?.ok === true &&
          (!Array.isArray(reply.translations) || reply.translations.length !== texts.length ||
            !reply.translations.every((value: unknown) => typeof value === 'string' && value.trim())));
        if (malformed) {
          singleOnly = true;
          if (active && !failed) for (const text of texts) if (subscribers.get(text)?.size) waiting.add(text);
          return;
        }
        if (!reply?.ok) throw new Error(typeof reply?.error === 'string' ? reply.error : '서버에서 문단별 번역을 받지 못했습니다.');
        translations = reply.translations;
      }
      if (!active) return;
      texts.forEach((text, index) => {
        remember(text, translations[index]);
        for (const anchor of subscribers.get(text) ?? []) render(anchor, text, translations[index]);
        subscribers.delete(text);
      });
    };
    const pump = (): void => {
      while (active && !failed && !startingLead && requests < MAX_REQUESTS && waiting.size) {
        const { reading, other, ahead, behind, lead } = nearbySources();
        const visible = reading.size > 0 || other.size > 0;
        // Wait for observed sources before using free slots on look-ahead batches.
        if (!reading.size && dirty.size && (!visible || !started)) return;
        if (!visible && !started && (walker || roots.size || initialObservation)) return;
        const forwardBusy = firstPrefetched !== undefined && pendingPage.has(firstPrefetched);
        const prioritizeReading = reading.size > 0 && (!other.size || readingStreak < MAX_READING_STREAK);
        // After each wave of visible pieces, one free slot can prepare the next screen.
        const reserveForward = !lead && prioritizeReading && ahead.size > 0 && !forwardBusy && requests > 0 && readingSincePrefetch >= MAX_REQUESTS;
        const foreground = visible && !reserveForward;
        if (!foreground && forwardBusy && Array.from(pendingPage.keys()).some((text) =>
          Array.from(subscribers.get(text) ?? []).some(onScreen))) return;
        const candidates = lead ? new Set([lead.text]) : foreground ? (prioritizeReading ? reading : other) : ahead.size ? ahead : behind;
        if (!candidates.size) return;
        const texts: string[] = [];
        let length = 0;
        for (const text of candidates) {
          if (texts.length && (length + text.length > MAX_CHARS || (foreground && text.length > COMPACT_LABEL_CHARS))) break;
          waiting.delete(text);
          texts.push(text);
          length += text.length;
          if (singleOnly || texts.length >= BATCH_SIZE || (foreground && (prioritizeReading || text.length > COMPACT_LABEL_CHARS))) break;
        }
        if (foreground) {
          readingStreak = prioritizeReading ? readingStreak + 1 : 0;
          if (prioritizeReading) readingSincePrefetch++;
        } else if (candidates === ahead) {
          firstPrefetched = texts[0];
          readingSincePrefetch = 0;
        }
        started = true;
        requests++;
        if (lead) {
          leadAnchor = lead.anchor;
          leadChosen = true;
          startingLead = true;
        }
        const task = fetchGroup(texts, Boolean(lead));
        for (const text of texts) pendingPage.set(text, task);
        void task.catch((error: unknown) => {
          if (!active || failed) return;
          failed = true;
          notify(error instanceof Error ? error.message : '페이지를 번역하지 못했습니다.');
        }).finally(() => {
          for (const text of texts) if (pendingPage.get(text) === task) pendingPage.delete(text);
          if (lead) {
            const item = results.get(lead.anchor);
            if (active && item?.node.classList.contains('is-streaming')) removeResult(lead.anchor);
            leadAnchor = undefined;
            startingLead = false;
            if (active && deferred.size) {
              const node = item?.done && item.node.isConnected ? item.node : undefined;
              const before = node?.getBoundingClientRect();
              const preceding = Array.from(deferred.keys());
              for (const [anchor, value] of deferred) render(anchor, value.source, value.translation);
              if (node && before && before.bottom > 0 && before.top < innerHeight) {
                // Keep the line being read in place as earlier translations expand the page.
                for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                  const shift = node.getBoundingClientRect().top - before.top;
                  if (shift <= 1) break;
                  if (parent === document.scrollingElement ||
                      (parent.scrollHeight > parent.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY) &&
                        preceding.some((anchor) => parent!.contains(anchor)))) {
                    parent.scrollBy({ top: shift, behavior: 'instant' });
                  }
                }
              }
              deferred.clear();
            }
          }
          requests--;
          pump();
        });
      }
    };
    const schedule = (): void => {
      if (active && scanTimer === undefined) scanTimer = window.setTimeout(scan, 0);
    };
    const visibility = new IntersectionObserver((entries) => {
      if (!active) return;
      const visibleFirst = entries.filter((entry) => entry.isIntersecting && onScreen(entry.target as HTMLElement));
      for (const { target, isIntersecting } of [...visibleFirst, ...entries]) {
        const anchor = target as HTMLElement;
        if (anchor === initialObservation) initialObservation = undefined;
        if (isIntersecting) { nearby.add(anchor); dirty.add(anchor); }
        else nearby.delete(anchor);
      }
      schedule();
    }, { rootMargin: innerHeight * LOOKAHEAD_VIEWPORTS + 'px 0px' });
    const track = (element: HTMLElement): void => {
      const anchor = pageAnchor(element);
      if (!anchor || anchor === document.documentElement) return;
      if (!tracked.has(anchor)) {
        tracked.add(anchor);
        if (!started) initialObservation = anchor;
        visibility.observe(anchor);
      }
    };
    const makeWalker = (root: HTMLElement): TreeWalker => document.createTreeWalker(root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node instanceof Element) return node.matches(pageExclude) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
    // Discovery and layout reads yield between slices, even on a very long document.
    function scan(): void {
      scanTimer = undefined;
      if (!active || failed) return;
      const deadline = performance.now() + SCAN_BUDGET_MS;
      do {
        const anchor = dirty.values().next().value;
        if (anchor) {
          dirty.delete(anchor);
          if (nearby.has(anchor)) refresh(anchor);
          continue;
        }
        if (!walker) {
          const root = roots.values().next().value;
          if (!root) break;
          roots.delete(root);
          if (!root.isConnected || root.closest(pageExclude)) continue;
          walker = makeWalker(root);
        }
        const text = walker.nextNode();
        if (!text) walker = undefined;
        else if (text.parentElement) track(text.parentElement);
      } while (performance.now() < deadline);
      pump();
      if (walker || roots.size || dirty.size) schedule();
    }
    const forget = (anchor: HTMLElement): void => {
      if (anchor === initialObservation) initialObservation = undefined;
      tracked.delete(anchor);
      visibility.unobserve(anchor);
      nearby.delete(anchor);
      dirty.delete(anchor);
      unsubscribe(anchor);
      removeResult(anchor);
    };
    const changed = new MutationObserver((records) => {
      if (!active || failed) return;
      let removals = false;
      for (const record of records) {
        const element = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
        if (!element || element.closest('.llm-bilingual-translation,.llm-bilingual-page-notice')) continue;
        if (record.type === 'attributes') {
          roots.add(element);
          // A visibility or editable-state change can affect old results anywhere in this branch.
          for (const anchor of tracked) {
            if (element === anchor || element.contains(anchor)) {
              if (anchor.closest(pageExclude)) forget(anchor);
              else if (nearby.has(anchor)) dirty.add(anchor);
            }
          }
        } else if (record.type === 'childList') {
          const ours = (node: Node): boolean => node instanceof Element &&
            node.matches('.llm-bilingual-translation,.llm-bilingual-page-notice');
          const added = Array.from(record.addedNodes).filter((node) => !ours(node));
          const removed = Array.from(record.removedNodes).filter((node) => !ours(node));
          if (!added.length && !removed.length) continue;
          if (removed.length) removals = true;
          for (const node of added) {
            if (node instanceof HTMLElement) roots.add(node);
            else if (node instanceof Text && node.data.trim() && !element.closest(pageExclude)) track(element);
          }
        } else if (!element.closest(pageExclude)) track(element);
        const anchor = pageAnchor(element);
        if (anchor && nearby.has(anchor)) dirty.add(anchor);
      }
      if (removals) for (const anchor of tracked) if (!anchor.isConnected) forget(anchor);
      if (dirty.size || roots.size) schedule();
    });
    changed.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-hidden', 'contenteditable', 'class', 'style', 'open',
        'role', 'dir', 'lang', 'theme', 'data-theme', 'data-color-mode'] });
    const body = document.body;
    if (body && document.designMode !== 'on') {
      // At a deep scroll position, observe a small reading-order window before scanning from the top.
      // Include preceding text so a point inside a paragraph doesn't jump ahead of its heading.
      if (scrollY > innerHeight) {
        const hit = document.caretRangeFromPoint(innerWidth / 2, Math.min(16, innerHeight / 2))?.startContainer;
        if (hit instanceof Text && body.contains(hit) && !hit.parentElement?.closest(pageExclude)) {
          const local = makeWalker(body);
          local.currentNode = hit;
          for (let i = 0; i < VIEWPORT_NEIGHBORS; i++) {
            if (!local.previousNode()) break;
          }
          let node: Node | null = local.currentNode;
          for (let i = 0; node && i <= VIEWPORT_NEIGHBORS * 2; i++, node = local.nextNode()) {
            if (node instanceof Text && node.parentElement) track(node.parentElement);
          }
        }
      }
      // A long header can span several scan slices before the observer discovers the visible body.
      const main = body.querySelector('main,[role="main"]') ?? body;
      const candidates = scrollY > innerHeight ? tracked : main.querySelectorAll<HTMLElement>(bodyParagraph);
      let inspected = 0;
      for (const anchor of candidates) {
        if (++inspected > VIEWPORT_NEIGHBORS * 2) break;
        if (!isBodyParagraph(anchor) || !onScreen(anchor) || anchor.closest(pageExclude) || pageAnchor(anchor) !== anchor) continue;
        track(anchor);
        nearby.add(anchor);
        refresh(anchor);
        if (waiting.size) break;
      }
      roots.add(body);
      schedule();
    }
    stopPage = () => {
      active = false;
      leadLifetime.abort();
      deferred.clear();
      window.clearTimeout(scanTimer);
      visibility.disconnect();
      changed.disconnect();
      waiting.clear();
      subscribers.clear();
      pendingPage.clear();
      preserveSelection = undefined;
      stopPage = undefined;
    };
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

  const clearTranslations = (clearCache: boolean): number => {
    stopPage?.();
    if (clearCache) pageCache.clear();
    generation++;
    stopPick();
    running = undefined;
    const count = results.size;
    for (const item of results.values()) { item.observer?.disconnect(); item.node.remove(); }
    results.clear();
    for (const release of rankedLayouts.values()) release();
    return count;
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.route) clearTranslations(true);
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['personal-pick', 'personal-selected', 'personal-all', 'personal-clear'].includes(message?.type)) return;
    if (message.type === 'personal-clear' || (message.type === 'personal-all' && stopPage)) {
      const count = clearTranslations(message.type === 'personal-clear');
      respond({ ok: true, count, active: false });
      return;
    }
    const route = message.routeVersion;
    if (!(typeof route === 'string' && route.length > 0) && !(typeof route === 'number' && Number.isFinite(route))) {
      respond({ ok: false, error: '설정을 확인하고 다시 시도해 주세요.' });
      return;
    }
    if (message.type === 'personal-all') {
      stopPick();
      generation++;
      running = undefined;
      startPage(route);
      respond({ ok: true, active: true });
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
