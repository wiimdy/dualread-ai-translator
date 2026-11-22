"use strict";
(() => {
    const scope = globalThis;
    if (scope.dualReadPersonalReady)
        return;
    scope.dualReadPersonalReady = true;
    const MAX_CHARS = 5000;
    const semantic = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dt,dd,td,th,pre,[role="paragraph"]';
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
    const MAX_REQUESTS = 3;
    const BATCH_SIZE = 5;
    const CACHE_ITEMS = 256;
    const SCAN_BUDGET_MS = 10;
    const results = new Map();
    let notice;
    let noticeTimer;
    let picking;
    let running;
    let generation = 0;
    const dismissNotice = () => {
        window.clearTimeout(noticeTimer);
        notice?.remove();
        notice = undefined;
    };
    const notify = (text, persistent = false) => {
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
        if (!persistent)
            noticeTimer = window.setTimeout(dismissNotice, 4500);
    };
    const anchorFor = (element) => {
        for (let parent = element; parent && parent !== document.body; parent = parent.parentElement) {
            if (parent.matches(semantic))
                return parent;
            if (/^(block|flow-root|flex|grid|list-item|table-cell)$/.test(getComputedStyle(parent).display))
                return parent;
        }
        return element.closest('a') ?? element;
    };
    const pageAnchor = (parent) => {
        const label = parent.closest(inlineLabel);
        const paragraph = parent.closest(semantic);
        if (label && (!paragraph || !paragraph.contains(label) || !label.matches('a')))
            return label;
        return anchorFor(parent);
    };
    const isPainted = (range, parent, anchor, page) => {
        let box = parent;
        while (box.parentElement && getComputedStyle(box).display === 'contents')
            box = box.parentElement;
        if (!box.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
            return false;
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
        for (let el = parent; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.clip !== 'auto' || style.clipPath !== 'none')
                return false;
            const xScrollable = page && /^(auto|scroll|overlay)$/.test(style.overflowX);
            const yScrollable = page && /^(auto|scroll|overlay)$/.test(style.overflowY);
            if (xScrollable) {
                left -= Math.abs(el.scrollLeft);
                right += el.scrollWidth - el.clientWidth;
            }
            if (yScrollable) {
                top -= el.scrollTop;
                bottom += el.scrollHeight - el.clientHeight;
            }
            if (style.overflowX === 'visible' && style.overflowY === 'visible')
                continue;
            const rect = el.getBoundingClientRect();
            if (!xScrollable && style.overflowX !== 'visible') {
                left = Math.max(left, rect.left);
                right = Math.min(right, rect.right);
            }
            if (!yScrollable && style.overflowY !== 'visible') {
                top = Math.max(top, rect.top);
                bottom = Math.min(bottom, rect.bottom);
            }
        }
        return Array.from(range.getClientRects()).some((rect) => Math.min(rect.right, right) > Math.max(rect.left, left) &&
            Math.min(rect.bottom, bottom) > Math.max(rect.top, top));
    };
    // The click path walks one block. The selection path prunes everything outside the explicit range.
    const extract = (range, picked, page = false) => {
        const excluded = page ? pageExclude : exclude;
        const root = range.commonAncestorContainer;
        if (!document.body?.contains(root) || document.designMode === 'on')
            return [];
        const parts = new Map();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!range.intersectsNode(node))
                    return NodeFilter.FILTER_REJECT;
                if (node instanceof Element && node.matches(excluded))
                    return NodeFilter.FILTER_REJECT;
                if (node instanceof Element && picked && node.matches(semantic) && node !== picked)
                    return NodeFilter.FILTER_REJECT;
                if (page && picked && node instanceof HTMLElement && pageAnchor(node) !== picked)
                    return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const segment = document.createRange();
        let node = root instanceof Text ? root : walker.nextNode();
        while (node) {
            const parent = node.parentElement;
            if (parent && !parent.closest(excluded) && (node instanceof Text || node instanceof HTMLBRElement)) {
                const anchor = page ? pageAnchor(parent) : anchorFor(parent);
                if (anchor && (!picked || anchor === picked)) {
                    if (node instanceof HTMLBRElement && parts.has(anchor)) {
                        parts.set(anchor, parts.get(anchor) + '\n');
                    }
                    else if (node instanceof Text) {
                        const begin = range.startContainer === node ? range.startOffset : 0;
                        const end = range.endContainer === node ? range.endOffset : node.length;
                        segment.setStart(node, begin);
                        segment.setEnd(node, end);
                        if (isPainted(segment, parent, anchor, page)) {
                            const piece = node.data.slice(begin, end);
                            if (piece.trim() || parts.has(anchor)) {
                                const text = (parts.get(anchor) ?? '') + piece;
                                parts.set(anchor, text);
                            }
                        }
                    }
                }
            }
            node = walker.nextNode();
        }
        return Array.from(parts, ([anchor, text]) => ({ anchor, text: text.trim() })).filter((part) => part.text);
    };
    const selectionPieces = () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.closest(pageExclude))
            return [];
        return extract(selection.getRangeAt(0), undefined, true);
    };
    // Keep DualRead's inside/after contract. A child also stays below its source in a row or grid.
    const place = (item) => {
        const { anchor, node } = item;
        if (!anchor.isConnected) {
            item.observer?.disconnect();
            node.remove();
            results.delete(anchor);
            return;
        }
        const parent = anchor.parentElement;
        const css = parent && getComputedStyle(parent);
        const horizontal = css && (css.display.includes('grid') || (css.display.includes('flex') && css.flexDirection.startsWith('row')));
        const inside = anchor === document.body || scope.LLMTranslatorShared.getTranslationPlacement(anchor.tagName) === 'inside' || horizontal;
        if (inside && node.parentElement !== anchor)
            anchor.append(node);
        if (!inside && anchor.nextElementSibling !== node)
            anchor.after(node);
        if (item.observer && parent && parent !== item.parent) {
            item.observer?.disconnect();
            item.observer.observe(parent, { childList: true });
            item.parent = parent;
        }
    };
    const resultFor = (piece, route, page = false) => {
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
        const item = { ...piece, route, node, done: false, parent: null, observer: page ? undefined : new MutationObserver((changes) => {
                if (changes.some((change) => Array.from(change.removedNodes).includes(piece.anchor)))
                    place(item);
            }) };
        results.set(piece.anchor, item);
        place(item);
        return item;
    };
    const chunksFor = (text) => {
        const chunks = [];
        let start = 0;
        while (text.length - start > MAX_CHARS) {
            const limit = start + MAX_CHARS;
            let end = limit;
            while (end > start + MAX_CHARS / 2 && !/\s/u.test(text[end - 1]))
                end--;
            if (end <= start + MAX_CHARS / 2)
                end = limit;
            if (/[\uD800-\uDBFF]/.test(text[end - 1]))
                end--;
            chunks.push(text.slice(start, end));
            start = end;
        }
        chunks.push(text.slice(start));
        return chunks;
    };
    const requestOne = async (text, route, active) => {
        let output = '';
        for (const chunk of chunksFor(text)) {
            if (!active())
                return '';
            if (!chunk.trim()) {
                output += chunk;
                continue;
            }
            const reply = await chrome.runtime.sendMessage({ type: 'personal-translate', text: chunk, routeVersion: route });
            if (reply?.ok !== true || typeof reply.translation !== 'string' || !reply.translation.trim()) {
                throw new Error(typeof reply?.error === 'string' ? reply.error : '번역 응답이 비어 있습니다.');
            }
            output += chunk.match(/^\s*/u)[0] + reply.translation.trim() + chunk.match(/\s*$/u)[0];
        }
        return output;
    };
    const translate = async (pieces, route) => {
        if (!pieces.length)
            throw new Error('입력창 밖에서 번역할 문단이나 텍스트를 선택해 주세요.');
        if (running)
            throw new Error('번역 중입니다. 잠시 후 다시 시도해 주세요.');
        const token = Symbol();
        running = token;
        let count = 0;
        try {
            for (const piece of pieces) {
                if (token !== running)
                    break;
                if (!piece.anchor.isConnected)
                    continue;
                const prev = results.get(piece.anchor);
                if (prev?.done && prev.node.isConnected && prev.text === piece.text && prev.route === route) {
                    place(prev);
                    continue;
                }
                const item = resultFor(piece, route);
                item.node.className = 'llm-bilingual-translation is-loading';
                item.node.textContent = '번역 중…';
                try {
                    const translated = await requestOne(piece.text, route, () => token === running);
                    if (token !== running)
                        break;
                    place(item);
                    if (!piece.anchor.isConnected)
                        continue;
                    item.node.className = 'llm-bilingual-translation is-done';
                    item.node.textContent = translated;
                    item.done = true;
                    count++;
                }
                catch (error) {
                    if (token !== running)
                        break;
                    const message = error instanceof Error ? error.message : '번역에 실패했습니다.';
                    item.node.className = 'llm-bilingual-translation is-error';
                    item.node.textContent = message;
                    throw new Error(count ? `${count}개 문단 번역 후 중단했습니다. ${message}` : message);
                }
            }
            return count;
        }
        finally {
            if (running === token)
                running = undefined;
        }
    };
    let stopPage;
    const pageCache = new Map();
    let cachedRoute;
    const remember = (text, translation) => {
        if (text.length > MAX_CHARS || translation.length > MAX_CHARS * 4)
            return;
        pageCache.delete(text);
        pageCache.set(text, translation);
        if (pageCache.size > CACHE_ITEMS)
            pageCache.delete(pageCache.keys().next().value);
    };
    const startPage = (route) => {
        if (route !== cachedRoute) {
            pageCache.clear();
            cachedRoute = route;
        }
        const tracked = new Set();
        const nearby = new Set();
        const desired = new Map();
        const subscribers = new Map();
        const waiting = new Set();
        const dirty = new Set();
        const roots = new Set();
        let walker;
        let scanTimer;
        let active = true;
        let failed = false;
        let first = true;
        let requests = 0;
        let singleOnly = false;
        const onScreen = (anchor) => {
            const rect = anchor.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        };
        const removeResult = (anchor) => {
            const item = results.get(anchor);
            if (!item)
                return;
            item.observer?.disconnect();
            item.node.remove();
            results.delete(anchor);
        };
        const unsubscribe = (anchor) => {
            const old = desired.get(anchor);
            desired.delete(anchor);
            if (!old)
                return;
            const anchors = subscribers.get(old);
            anchors?.delete(anchor);
            if (!anchors?.size && waiting.delete(old))
                subscribers.delete(old);
        };
        const render = (anchor, source, translation) => {
            if (!active || !anchor.isConnected || desired.get(anchor) !== source || anchor.closest(pageExclude))
                return;
            const item = resultFor({ anchor, text: source }, route, true);
            item.node.className = 'llm-bilingual-translation is-done';
            item.node.textContent = translation;
            item.done = true;
        };
        const refresh = (anchor) => {
            let text = '';
            if (anchor.isConnected && !anchor.closest(pageExclude)) {
                const range = document.createRange();
                range.selectNodeContents(anchor);
                text = extract(range, anchor, true)[0]?.text ?? '';
            }
            if (desired.get(anchor) === text && text) {
                const item = results.get(anchor);
                if (item?.done && item.text === text && !item.node.isConnected)
                    place(item);
                return;
            }
            unsubscribe(anchor);
            if (!text) {
                removeResult(anchor);
                return;
            }
            desired.set(anchor, text);
            const current = results.get(anchor);
            if (current?.done && current.text === text && current.route === route) {
                remember(text, current.node.textContent ?? '');
                place(current);
                return;
            }
            removeResult(anchor);
            const cached = pageCache.get(text);
            if (cached !== undefined) {
                render(anchor, text, cached);
                return;
            }
            const anchors = subscribers.get(text);
            if (anchors)
                anchors.add(anchor);
            else {
                subscribers.set(text, new Set([anchor]));
                waiting.add(text);
            }
        };
        const next = () => {
            for (const text of waiting) {
                const anchors = subscribers.get(text);
                if (anchors && Array.from(anchors).some(onScreen))
                    return text;
            }
            return waiting.values().next().value;
        };
        const fetchGroup = async (texts) => {
            let translations;
            if (texts.length === 1)
                translations = [await requestOne(texts[0], route, () => active && !failed)];
            else {
                const reply = await chrome.runtime.sendMessage({ type: 'personal-translate-batch', texts, routeVersion: route });
                const malformed = reply?.code === 'INVALID_BATCH_OUTPUT' || (reply?.ok === true &&
                    (!Array.isArray(reply.translations) || reply.translations.length !== texts.length ||
                        !reply.translations.every((value) => typeof value === 'string' && value.trim())));
                if (malformed) {
                    singleOnly = true;
                    if (active && !failed)
                        for (const text of texts)
                            if (subscribers.get(text)?.size)
                                waiting.add(text);
                    return;
                }
                if (!reply?.ok)
                    throw new Error(typeof reply?.error === 'string' ? reply.error : '서버에서 문단별 번역을 받지 못했습니다.');
                translations = reply.translations;
            }
            if (!active)
                return;
            texts.forEach((text, index) => {
                remember(text, translations[index]);
                for (const anchor of subscribers.get(text) ?? [])
                    render(anchor, text, translations[index]);
                subscribers.delete(text);
            });
        };
        const pump = () => {
            while (active && !failed && requests < MAX_REQUESTS && waiting.size) {
                const texts = [];
                let length = 0;
                while (texts.length < (first || singleOnly ? 1 : BATCH_SIZE)) {
                    const text = next();
                    if (text === undefined || (texts.length && length + text.length > MAX_CHARS))
                        break;
                    waiting.delete(text);
                    texts.push(text);
                    length += text.length;
                }
                first = false;
                requests++;
                void fetchGroup(texts).catch((error) => {
                    if (!active || failed)
                        return;
                    failed = true;
                    notify(error instanceof Error ? error.message : '페이지를 번역하지 못했습니다.');
                }).finally(() => { requests--; pump(); });
            }
        };
        const schedule = () => {
            if (active && scanTimer === undefined)
                scanTimer = window.setTimeout(scan, 0);
        };
        const visibility = new IntersectionObserver((entries) => {
            if (!active)
                return;
            const visibleFirst = entries.filter((entry) => entry.isIntersecting && onScreen(entry.target));
            for (const { target, isIntersecting } of [...visibleFirst, ...entries]) {
                const anchor = target;
                if (isIntersecting) {
                    nearby.add(anchor);
                    dirty.add(anchor);
                }
                else
                    nearby.delete(anchor);
            }
            schedule();
        }, { rootMargin: innerHeight * 2 + 'px 0px' });
        const track = (element) => {
            const anchor = pageAnchor(element);
            if (!anchor || anchor === document.documentElement)
                return;
            if (!tracked.has(anchor)) {
                tracked.add(anchor);
                visibility.observe(anchor);
            }
        };
        const makeWalker = (root) => document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node instanceof Element)
                    return node.matches(pageExclude) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
                return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            },
        });
        // Discovery and layout reads yield between slices, even on a very long document.
        function scan() {
            scanTimer = undefined;
            if (!active || failed)
                return;
            const deadline = performance.now() + SCAN_BUDGET_MS;
            do {
                const anchor = dirty.values().next().value;
                if (anchor) {
                    dirty.delete(anchor);
                    if (nearby.has(anchor))
                        refresh(anchor);
                    if (first && waiting.size && onScreen(anchor))
                        pump();
                    continue;
                }
                if (!walker) {
                    const root = roots.values().next().value;
                    if (!root)
                        break;
                    roots.delete(root);
                    if (!root.isConnected || root.closest(pageExclude))
                        continue;
                    walker = makeWalker(root);
                }
                const text = walker.nextNode();
                if (!text)
                    walker = undefined;
                else if (text.parentElement)
                    track(text.parentElement);
            } while (performance.now() < deadline);
            // During first discovery at a deep scroll position, wait for an on-screen
            // source before spending the first request on a look-ahead block.
            if (!first || (!walker && !roots.size && !dirty.size))
                pump();
            if (walker || roots.size || dirty.size)
                schedule();
        }
        const forget = (anchor) => {
            tracked.delete(anchor);
            visibility.unobserve(anchor);
            nearby.delete(anchor);
            dirty.delete(anchor);
            unsubscribe(anchor);
            removeResult(anchor);
        };
        const changed = new MutationObserver((records) => {
            if (!active || failed)
                return;
            let removals = false;
            for (const record of records) {
                const element = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
                if (!element || element.closest('.llm-bilingual-translation,.llm-bilingual-page-notice'))
                    continue;
                if (record.type === 'attributes') {
                    roots.add(element);
                    // A visibility or editable-state change can affect old results anywhere in this branch.
                    for (const anchor of tracked) {
                        if (element === anchor || element.contains(anchor)) {
                            if (anchor.closest(pageExclude))
                                forget(anchor);
                            else if (nearby.has(anchor))
                                dirty.add(anchor);
                        }
                    }
                }
                else if (record.type === 'childList') {
                    const ours = (node) => node instanceof Element &&
                        node.matches('.llm-bilingual-translation,.llm-bilingual-page-notice');
                    const added = Array.from(record.addedNodes).filter((node) => !ours(node));
                    const removed = Array.from(record.removedNodes).filter((node) => !ours(node));
                    if (!added.length && !removed.length)
                        continue;
                    if (removed.length)
                        removals = true;
                    for (const node of added) {
                        if (node instanceof HTMLElement)
                            roots.add(node);
                        else if (node instanceof Text && node.data.trim() && !element.closest(pageExclude))
                            track(element);
                    }
                }
                else if (!element.closest(pageExclude))
                    track(element);
                const anchor = pageAnchor(element);
                if (anchor && nearby.has(anchor))
                    dirty.add(anchor);
            }
            if (removals)
                for (const anchor of tracked)
                    if (!anchor.isConnected)
                        forget(anchor);
            if (dirty.size || roots.size)
                schedule();
        });
        changed.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['hidden', 'inert', 'aria-hidden', 'contenteditable', 'class', 'style', 'open'] });
        // Seed a few visible anchors immediately, including when activation happens halfway down the page.
        const body = document.body;
        if (body && document.designMode !== 'on') {
            for (const y of [0.12, 0.4, 0.7]) {
                for (const x of [0.25, 0.55]) {
                    const element = document.elementFromPoint(innerWidth * x, innerHeight * y);
                    if (!(element instanceof HTMLElement) || element.closest(pageExclude))
                        continue;
                    const anchor = pageAnchor(element);
                    if (!anchor || anchor === body || anchor.childElementCount > 8 || !anchor.firstChild ||
                        !anchor.firstChild.textContent?.trim() || anchor.querySelector('p,div,section,article,li,table'))
                        continue;
                    track(element);
                    nearby.add(anchor);
                    dirty.add(anchor);
                }
            }
            roots.add(body);
            schedule();
        }
        stopPage = () => {
            active = false;
            window.clearTimeout(scanTimer);
            visibility.disconnect();
            changed.disconnect();
            waiting.clear();
            subscribers.clear();
            stopPage = undefined;
        };
    };
    const stopPick = () => {
        picking = undefined;
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        dismissNotice();
    };
    const onKey = (event) => {
        if (event.isTrusted && event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            stopPick();
        }
    };
    const onClick = (event) => {
        if (!event.isTrusted || event.button !== 0 || picking === undefined)
            return;
        const route = picking;
        const target = event.composedPath()[0];
        if (!(target instanceof HTMLElement) || target.closest(exclude) || !document.body.contains(target))
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        stopPick();
        const originalGeneration = generation;
        try {
            const anchor = anchorFor(target);
            if (!anchor || anchor === document.body || anchor === document.documentElement)
                throw new Error('글이 있는 문단 안을 클릭해 주세요.');
            const range = document.createRange();
            range.selectNodeContents(anchor);
            const pieces = extract(range, anchor);
            if (pieces.some((piece) => /\n[\t ]*\n/.test(piece.text))) {
                throw new Error('이 글 영역에는 문단이 여러 개 있습니다. 원하는 문단만 드래그해서 번역해 주세요.');
            }
            void translate(pieces, route).then((count) => {
                if (originalGeneration === generation)
                    notify(count ? '선택한 문단을 번역했습니다.' : '이미 번역한 문단입니다.');
            }, (error) => {
                if (originalGeneration === generation)
                    notify(error instanceof Error ? error.message : '번역에 실패했습니다.');
            });
        }
        catch (error) {
            notify(error instanceof Error ? error.message : '문단을 읽을 수 없습니다.');
        }
    };
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (sender.id !== chrome.runtime.id || !['personal-pick', 'personal-selected', 'personal-all', 'personal-clear'].includes(message?.type))
            return;
        if (message.type === 'personal-clear' || (message.type === 'personal-all' && stopPage)) {
            stopPage?.();
            if (message.type === 'personal-clear')
                pageCache.clear();
            generation++;
            stopPick();
            running = undefined;
            const count = results.size;
            for (const item of results.values()) {
                item.observer?.disconnect();
                item.node.remove();
            }
            results.clear();
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
            if (picking !== undefined)
                stopPick();
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
                if (originalGeneration === generation)
                    notify(count ? `${count}개 문단을 번역했습니다.` : '이미 번역한 선택 영역입니다.');
                respond({ ok: true, count });
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : '선택 영역을 번역할 수 없습니다.';
                if (originalGeneration === generation)
                    notify(detail);
                respond({ ok: false, error: detail });
            }
        })();
        return true;
    });
})();
