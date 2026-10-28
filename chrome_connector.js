// Page helper for the Chrome connector (chrome_connector.py). Hermes installs it in every
// document of the connector's tabs and calls window.__hcx from Runtime.evaluate. It lists what
// a page offers (with short refs like e12 kept on the elements as data-hcx), finds elements by
// ref, role and visible text, and does the DOM side of actions. Mouse and key input come from
// CDP, so pages see real events. Password values are never returned.
(function () {
  'use strict';
  var VERSION = 8;
  if (window.__hcx && window.__hcx.version >= VERSION) return;

  // ---- activity tracking for settle detection ----------------------------------------------
  var st = window.__hcxState;
  if (!st) {
    st = window.__hcxState = { inflight: 0, lastMutation: Date.now(), lastNet: 0, seq: 0, api: [], apiSeq: 0 };
    // JSON the page loads from its own server, kept (last 25, 200 KB each) so the bot can read
    // the data directly instead of scraping the rendered page.
    var keep = function (url, method, status, text) {
      try {
        if (typeof text !== 'string' || !text || text.length > 4000000) return;
        var t = text.replace(/^\)\]\}',?\n/, '');
        if (!/^\s*[\[{]/.test(t)) return;
        st.apiSeq++;
        st.api.push({ i: st.apiSeq, url: String(url || ''), method: method || 'GET', status: status, size: t.length,
          body: t.length > 200000 ? t.slice(0, 200000) : t, at: Date.now() });
        if (st.api.length > 25) st.api.shift();
      } catch (e) { /* never break the page */ }
    };
    try {
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.__hcxFetch = origFetch;
        window.fetch = function (input, init) {
          st.inflight++;
          st.lastNet = Date.now();
          var method = (init && init.method) || (input && input.method) || 'GET';
          var done = function () { st.inflight = Math.max(0, st.inflight - 1); st.lastNet = Date.now(); };
          try {
            var p = origFetch.apply(this, arguments);
            p.then(function (resp) {
              done();
              try {
                var ct = (resp.headers && resp.headers.get('content-type')) || '';
                if (/json/i.test(ct)) resp.clone().text().then(function (t) { keep(resp.url, String(method).toUpperCase(), resp.status, t); }, function () {});
              } catch (e) { /* opaque response */ }
            }, done);
            return p;
          } catch (e) { done(); throw e; }
        };
      }
    } catch (e) { /* page forbids it: settle falls back to DOM quiet only */ }
    try {
      var xopen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m) { this.__hcxMethod = String(m || 'GET').toUpperCase(); return xopen.apply(this, arguments); };
      var xsend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var x = this;
        st.inflight++;
        st.lastNet = Date.now();
        x.addEventListener('loadend', function () {
          st.inflight = Math.max(0, st.inflight - 1);
          st.lastNet = Date.now();
          try {
            var ct = x.getResponseHeader('content-type') || '';
            if (/json/i.test(ct) && (x.responseType === '' || x.responseType === 'text')) keep(x.responseURL, x.__hcxMethod, x.status, x.responseText);
          } catch (e) { /* ignore */ }
        });
        return xsend.apply(this, arguments);
      };
    } catch (e) { /* as above */ }
    var observe = function () {
      try {
        new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            if (records[i].type !== 'attributes' || records[i].attributeName !== 'data-hcx') {
              st.lastMutation = Date.now();
              return;
            }
          }
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) { /* no DOM yet */ }
    };
    if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe);
  }

  // ---- small helpers -------------------------------------------------------------------------
  var SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', '[contenteditable=""]',
    '[contenteditable=true]', '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=switch]',
    '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=option]',
    '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[role=spinbutton]', '[role=slider]', '[role=treeitem]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  var DIALOG_SEL = 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]';
  var ROLE_WORDS = /^(button|link|textbox|searchbox|checkbox|radio|switch|select|combobox|tab|menuitem|option|password|slider|spinbutton|file|treeitem|clickable)\s*:\s*(.+)$/i;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cut(s, n) { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function low(s) { return norm(s).toLowerCase(); }

  function isToggle(el) {
    return el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
  }

  function visible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    var cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.display === 'none') return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  // A hidden checkbox or radio styled through its label: act on the visible label.
  function proxyOf(el) {
    if (isToggle(el) && !visible(el) && el.labels) {
      for (var i = 0; i < el.labels.length; i++) if (visible(el.labels[i])) return el.labels[i];
    }
    return null;
  }

  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return r.split(/\s+/)[0].toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'file' || t === 'color') return t;
      if (t === 'range') return 'slider';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'password') return 'password';
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (/^(date|datetime-local|time|month|week)$/.test(t)) return t;
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }

  function textOfIds(el, ids) {
    var out = [];
    ids.split(/\s+/).forEach(function (id) {
      var n = id && el.ownerDocument.getElementById(id);
      if (n) out.push(n.innerText || n.textContent || '');
    });
    return norm(out.join(' '));
  }

  function nameOf(el) {
    var n = '';
    var lb = el.getAttribute('aria-labelledby');
    if (lb) n = textOfIds(el, lb);
    if (!n) n = norm(el.getAttribute('aria-label'));
    var tag = el.tagName;
    if (!n && el.labels && el.labels.length) {
      n = norm(Array.prototype.map.call(el.labels, function (l) { return l.innerText || l.textContent || ''; }).join(' '));
    }
    if (!n && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      var t = (el.type || '').toLowerCase();
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) n = norm(el.value);
      if (!n) n = norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id);
    }
    if (!n) n = norm(el.innerText || el.textContent);
    if (!n) {
      var img = el.querySelector && el.querySelector('img[alt],svg[aria-label],[title]');
      n = norm((img && (img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title'))) ||
        el.getAttribute('title') || '');
    }
    return n;
  }

  function relHref(h) {
    if (!h || /^javascript:/i.test(h) || h === '#') return '';
    try {
      var u = new URL(h, location.href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
    } catch (e) { return h; }
  }

  function checkedOf(el) {
    if (isToggle(el)) return !!el.checked;
    var a = el.getAttribute('aria-checked');
    if (a != null) return a === 'true';
    var p = el.getAttribute('aria-pressed');
    if (p != null) return p === 'true';
    return null;
  }

  function valueOf(el) {
    var role = roleOf(el);
    if (role === 'password') return el.value ? '(hidden)' : '';
    if (el.tagName === 'SELECT') {
      if (el.multiple) {
        return Array.prototype.filter.call(el.options, function (o) { return o.selected; })
          .map(function (o) { return norm(o.text); }).join(', ');
      }
      var o = el.options[el.selectedIndex];
      return o ? norm(o.text) : '';
    }
    if (el.isContentEditable) return norm(el.innerText);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value == null ? '' : el.value);
    return null;
  }

  function stateOf(el, role) {
    var s = {};
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.disabled = true;
    var c = checkedOf(el);
    if (c !== null && /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio|button|clickable)$/.test(role)) {
      if (role !== 'button' && role !== 'clickable' || el.getAttribute('aria-pressed') != null) s.checked = c;
    }
    var v = valueOf(el);
    if (v !== null && role !== 'button' && role !== 'checkbox' && role !== 'radio') s.value = cut(v, 120);
    if (el.tagName === 'SELECT') {
      s.options = Array.prototype.slice.call(el.options, 0, 15).map(function (o) { return cut(o.text, 40); });
      if (el.options.length > 15) s.more = el.options.length - 15;
    }
    var ex = el.getAttribute('aria-expanded');
    if (ex != null) s.expanded = ex === 'true';
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.current = true;
    if (el.required || el.getAttribute('aria-required') === 'true') s.required = true;
    if (el.readOnly) s.readonly = true;
    if (el.getAttribute('aria-invalid') === 'true') s.invalid = true;
    if (role === 'link') { var h = relHref(el.getAttribute('href')); if (h) s.href = cut(h, 90); }
    return s;
  }

  // ---- refs ----------------------------------------------------------------------------------
  function topState() {
    try { return window.top.__hcxState || st; } catch (e) { return st; }
  }

  function refOf(el) {
    var r = el.getAttribute('data-hcx');
    if (r) return r;
    var ts = topState();
    ts.seq = (ts.seq || 0) + 1;
    r = 'e' + ts.seq;
    el.setAttribute('data-hcx', r);
    return r;
  }

  // Every document we can reach: this one, open shadow roots, same-origin frames.
  function roots(doc, out, depth) {
    out = out || [];
    depth = depth || 0;
    out.push(doc);
    if (depth > 6) return out;
    var walker = (doc.ownerDocument || doc).createTreeWalker(doc.documentElement || doc, NodeFilter.SHOW_ELEMENT);
    var n = walker.currentNode;
    while (n) {
      if (n.shadowRoot) roots(n.shadowRoot, out, depth + 1);
      if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
        try { if (n.contentDocument && n.contentDocument.documentElement) roots(n.contentDocument, out, depth + 1); } catch (e) { /* cross-origin */ }
      }
      n = walker.nextNode();
    }
    return out;
  }

  function byRef(ref) {
    var all = roots(document);
    for (var i = 0; i < all.length; i++) {
      var el = all[i].querySelector('[data-hcx="' + ref + '"]');
      if (el) return el;
    }
    return null;
  }

  function deepQueryAll(css) {
    var out = [];
    roots(document).forEach(function (r) {
      try { Array.prototype.push.apply(out, r.querySelectorAll(css)); } catch (e) { /* bad selector in this root */ }
    });
    return out;
  }

  function openDialog() {
    var ds = deepQueryAll(DIALOG_SEL).filter(visible);
    return ds.length ? ds[ds.length - 1] : null;
  }

  function candidates() {
    var out = [];
    roots(document).forEach(function (r) {
      var list = r.querySelectorAll(SEL);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var proxy = proxyOf(el);
        if (proxy || visible(el)) out.push(el);
      }
    });
    return out;
  }

  function inViewport(el) {
    var r = (proxyOf(el) || el).getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function entryOf(el, behind) {
    var role = roleOf(el);
    var e = [refOf(el), role, cut(nameOf(el), 70), stateOf(el, role)];
    var ts = topState();
    (ts.names = ts.names || {})[e[0]] = [role, nameOf(el)];
    if (behind) e[3].behind = true;
    if (!inViewport(el)) e[3].offscreen = true;
    return e;
  }

  function mainText(limit) {
    var main = document.querySelector('main,[role=main]');
    var root = main && visible(main) ? main : document.body;
    if (!root) return '';
    var t = root.innerText || '';
    t = t.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return t.length > limit ? t.slice(0, limit) + '\n[... ' + (t.length - limit) + ' more characters; read with {"read": "text"}]' : t;
  }

  function notices() {
    var seen = {};
    return deepQueryAll('[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],.toast,.alert,.notification,.flash,.error,.invalid-feedback')
      .filter(visible).map(function (n) { return cut(n.innerText || n.textContent, 160); })
      .filter(function (t) { if (!t || seen[t]) return false; seen[t] = 1; return true; }).slice(0, 6);
  }

  // The page as a short list: title, url, open dialog, notices, headings, interactive elements, text.
  function map(opts) {
    opts = opts || {};
    var limit = opts.limit || 120;
    var dialog = openDialog();
    var els = candidates();
    // Drop generic clickable wrappers that hold real controls (they only repeat their children).
    els = els.filter(function (el) {
      if (roleOf(el) !== 'clickable') return true;
      if (el.querySelector && el.querySelector(SEL)) return false;
      return nameOf(el).length <= 80;
    });
    var first = [], rest = [];
    els.forEach(function (el) {
      if (dialog && !dialog.contains(el)) rest.push(el); else first.push(el);
    });
    if (!dialog) {
      // Elements on screen first keeps the list useful when it is cut.
      var on = [], off = [];
      first.forEach(function (el) { (inViewport(el) ? on : off).push(el); });
      first = on.concat(off);
    }
    var out = [];
    first.forEach(function (el) { if (out.length < limit) out.push(entryOf(el, false)); });
    var behindCount = 0;
    rest.forEach(function (el) { if (out.length < limit && opts.full) out.push(entryOf(el, true)); else behindCount++; });
    var total = first.length + rest.length;
    var heads = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
      .filter(visible).slice(0, 8).map(function (h) { return h.tagName.toLowerCase() + ' ' + cut(h.innerText, 90); });
    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe')).filter(function (f) {
      try { return !f.contentDocument; } catch (e) { return true; }
    }).filter(visible).slice(0, 5).map(function (f) { return cut(f.src, 120); });
    var pw = deepQueryAll('input[type=password]').filter(visible);
    return {
      title: cut(document.title, 120), url: location.href, ready: document.readyState,
      dialog: dialog ? cut(nameOf(dialog) || dialog.innerText, 120) : '', behind: behindCount,
      notices: notices(), heads: heads, frames: frames, login: pw.length > 0,
      els: out, total: total, cut: Math.max(0, total - out.length - (opts.full ? 0 : behindCount)),
      text: opts.text === 0 ? '' : mainText(opts.text || 1200),
      scroll: [Math.round(scrollY), Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))]
    };
  }

  // ---- finding a target -------------------------------------------------------------------
  // Forms: e12 (a ref from the map), css=<selector>, role:Name (button:Save, textbox:Email,
  // link:Clients), or plain visible text / label / placeholder. Text matching prefers exact,
  // then starts-with, then contains; then enabled, inside an open dialog, on screen.
  function resolve(target) {
    target = norm(target);
    if (!target) return { error: 'empty target' };
    if (/^e\d+$/.test(target)) {
      var el = byRef(target);
      if (el) return { el: el };
      // The page re-rendered the control: find the one the map listed under this ref by role and name.
      var seen = (topState().names || {})[target];
      if (seen && seen[1]) {
        var again = resolve((ROLE_WORDS.test(seen[0] + ':x') ? seen[0] + ':' : '') + seen[1]);
        if (again.el && !again.loose && (again.count || 1) === 1) { again.loose = true; return again; }
      }
      return { error: 'ref ' + target + ' is gone (the page changed). Use the newest map, or target by text.' };
    }
    if (/^css=/i.test(target)) {
      var css = target.slice(4);
      var hits = deepQueryAll(css);
      var vis = hits.filter(function (h) { return visible(h) || proxyOf(h); });
      if (vis.length) return { el: vis[0], count: vis.length };
      if (hits.length) return { el: hits[0], count: hits.length, hidden: true };
      return { error: 'no element matches ' + css };
    }
    var role = null, want = target;
    var m = ROLE_WORDS.exec(target);
    if (m) { role = m[1].toLowerCase(); want = m[2]; }
    var w = low(want);
    var dialog = openDialog();
    var best = null, bestScore = -1, names = [];
    candidates().forEach(function (el) {
      var r = roleOf(el);
      if (role && r !== role && !(role === 'textbox' && /^(searchbox|password|spinbutton)$/.test(r)) &&
          !(role === 'select' && r === 'combobox') && !(role === 'button' && r === 'clickable')) return;
      var n = low(nameOf(el));
      var alt = low(el.getAttribute('placeholder') || '') + '|' + low(el.getAttribute('title') || '') + '|' + low(el.getAttribute('name') || '');
      var score = 0;
      if (n === w) score = 100;
      else if (n.indexOf(w) === 0) score = 70;
      else if (n.indexOf(w) > 0) score = 50;
      else if (alt.indexOf(w) >= 0) score = 40;
      else return;
      if (!(el.disabled || el.getAttribute('aria-disabled') === 'true')) score += 8;
      if (dialog && dialog.contains(el)) score += 12;
      if (inViewport(el)) score += 3;
      score -= Math.min(10, Math.max(0, n.length - w.length) / 20);
      names.push(cut(nameOf(el), 40));
      if (score > bestScore) { best = el; bestScore = score; }
    });
    if (best) return { el: best, count: names.length };
    // Last resort: the smallest visible element whose own text is the target (clickable divs).
    var small = null, smallLen = 1e9;
    roots(document).forEach(function (r) {
      var walker = (r.ownerDocument || r).createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      var n = walker.currentNode;
      while (n) {
        if (n.nodeType === 1 && n.childElementCount < 4 && (n.textContent || '').length <= w.length + 40) {
          var t = low(n.innerText || '');
          if (t === w && visible(n) && t.length < smallLen) { small = n; smallLen = t.length; }
        }
        n = walker.nextNode();
      }
    });
    if (small) return { el: small, count: 1, loose: true };
    var words = w.split(' ').filter(function (x) { return x.length > 2; });
    var near = [];
    candidates().forEach(function (el) {
      if (near.length >= 6) return;
      var n = nameOf(el);
      var ln = low(n);
      if (n && words.some(function (x) { return ln.indexOf(x) >= 0; })) near.push(roleOf(el) + ' "' + cut(n, 40) + '" ' + refOf(el));
    });
    return { error: 'nothing on the page matches "' + want + '"' + (role ? ' as ' + role : '') +
      (near.length ? '. Close: ' + near.join(', ') : '') };
  }

  function describe(el) {
    if (!el) return 'nothing';
    var role = roleOf(el);
    var n = cut(nameOf(el), 50);
    return role + (n ? ' "' + n + '"' : ' <' + el.tagName.toLowerCase() + '>');
  }

  // Where to click, in top-level viewport pixels, and whether a click there reaches the element.
  function point(el) {
    var target = proxyOf(el) || el;
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { target.scrollIntoView(); }
    var r = target.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var doc = target.ownerDocument;
    var scope = target.getRootNode ? target.getRootNode() : doc;
    var hit = (scope && scope.elementFromPoint ? scope : doc).elementFromPoint(x, y);
    var reach = !!hit && (hit === target || target.contains(hit) || (hit.control && hit.control === el) ||
      (hit.tagName === 'LABEL' && el.labels && Array.prototype.indexOf.call(el.labels, hit) >= 0));
    var ox = 0, oy = 0, w = doc.defaultView;
    try {
      while (w && w !== window && w.frameElement) {
        var fr = w.frameElement.getBoundingClientRect();
        ox += fr.left + (w.frameElement.clientLeft || 0);
        oy += fr.top + (w.frameElement.clientTop || 0);
        w = w.parent;
      }
    } catch (e) { /* cross-origin parent: leave the offset */ }
    return { x: x + ox, y: y + oy, reach: reach, cover: reach ? '' : describe(hit), what: describe(el) };
  }

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function setNative(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype :
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    fire(el, 'input');
    fire(el, 'change');
  }

  // Focus a field and select what is in it, so the typed text replaces it.
  function prepareType(el, clear) {
    var target = el;
    if (roleOf(el) === 'password') return { error: 'password field: never type passwords. Use browser_vault (action=fill) for saved logins.' };
    if (el.disabled || el.readOnly) return { error: describe(el) + ' is ' + (el.disabled ? 'disabled' : 'read-only') };
    try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { /* ignore */ }
    target.focus();
    var before = valueOf(el);
    if (clear) {
      if (el.isContentEditable) {
        var sel = el.ownerDocument.getSelection(), rg = el.ownerDocument.createRange();
        rg.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(rg);
      } else {
        try { el.select(); } catch (e) { if (before) setNative(el, ''); }
      }
    } else if (!el.isContentEditable) {
      try { var L = String(el.value || '').length; el.setSelectionRange(L, L); } catch (e) { /* not a text input */ }
    }
    var active = el.ownerDocument.activeElement;
    return { before: before, focused: active === el || el.contains(active), what: describe(el), kind: el.type || '' };
  }

  function finishType(el, text, clear) {
    var now = valueOf(el);
    var want = clear ? String(text) : null;
    if (want !== null && norm(now) !== norm(want) && !el.isContentEditable && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      // Typed input did not land (date pickers, masked inputs): set it directly.
      setNative(el, want);
      now = valueOf(el);
    } else {
      fire(el, 'change');
    }
    return { after: now };
  }

  function selectOption(el, want) {
    if (el.tagName !== 'SELECT') return { error: describe(el) + ' is not a dropdown list. Click it, then click the option.' };
    if (el.disabled) return { error: describe(el) + ' is disabled' };
    var w = low(want), pick = null, i, o;
    for (i = 0; i < el.options.length && !pick; i++) { o = el.options[i]; if (low(o.text) === w || low(o.value) === w) pick = o; }
    for (i = 0; i < el.options.length && !pick; i++) { o = el.options[i]; if (low(o.text).indexOf(w) === 0) pick = o; }
    for (i = 0; i < el.options.length && !pick; i++) { o = el.options[i]; if (low(o.text).indexOf(w) >= 0) pick = o; }
    if (!pick) {
      return { error: 'no option "' + want + '" in ' + describe(el) + '. Options: ' +
        Array.prototype.slice.call(el.options, 0, 20).map(function (x) { return norm(x.text); }).join(' | ') };
    }
    var before = valueOf(el);
    if (el.multiple) { pick.selected = true; fire(el, 'input'); fire(el, 'change'); } else setNative(el, pick.value);
    return { before: before, after: valueOf(el), what: describe(el) };
  }

  // ---- reading -------------------------------------------------------------------------------
  function cellText(c) { return cut(c.innerText || c.textContent, 200); }

  function readTable(el) {
    var t = el && (el.tagName === 'TABLE' ? el : (el.closest && el.closest('table')) || (el.querySelector && el.querySelector('table')));
    if (el && !t) {
      // A heading or caption names the table that follows it.
      t = deepQueryAll('table').filter(visible).filter(function (x) {
        return el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING;
      })[0];
    }
    t = t || deepQueryAll('table').filter(visible)[0];
    if (!t) {
      var grid = deepQueryAll('[role=grid],[role=table]').filter(visible)[0];
      if (!grid) return { error: 'no table on the page' };
      var grows = Array.prototype.slice.call(grid.querySelectorAll('[role=row]'), 0, 300);
      return { rows: grows.map(function (r) {
        return Array.prototype.map.call(r.querySelectorAll('[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]'), cellText);
      }) };
    }
    var rows = Array.prototype.slice.call(t.rows, 0, 300).map(function (r) {
      return Array.prototype.map.call(r.cells, cellText);
    });
    return { rows: rows, more: Math.max(0, t.rows.length - 300) };
  }

  function readForm(scope) {
    var root = scope || openDialog() || document;
    var out = [];
    candidates().forEach(function (el) {
      if (root !== document && !root.contains(el)) return;
      var role = roleOf(el);
      if (!/^(textbox|searchbox|password|spinbutton|select|listbox|combobox|checkbox|radio|switch|slider|date|datetime-local|time|month|week|color|file)$/.test(role)) return;
      var v = (role === 'checkbox' || role === 'radio' || role === 'switch') ? (checkedOf(el) ? 'on' : 'off') : valueOf(el);
      out.push([refOf(el), role, cut(nameOf(el), 60), cut(v, 300)]);
    });
    return { fields: out };
  }

  function read(spec, opts) {
    spec = norm(spec || 'text');
    var limit = (opts && opts.limit) || 8000;
    if (spec === 'text') return { text: mainText(limit) };
    if (spec === 'all') return { text: (document.body.innerText || '').slice(0, limit) };
    if (spec === 'form') return readForm();
    if (spec === 'table') return readTable(null);
    if (/^table\s*[:=]/.test(spec)) {
      var tr = resolve(spec.replace(/^table\s*[:=]\s*/, ''));
      return tr.error ? tr : readTable(tr.el);
    }
    if (spec === 'links' || /^links\s*[:=]/.test(spec)) {
      var scope = document;
      if (spec !== 'links') { var sr = resolve(spec.replace(/^links\s*[:=]\s*/, '')); if (sr.error) return sr; scope = sr.el; }
      var seen = {};
      var links = Array.prototype.slice.call(scope.querySelectorAll('a[href]')).filter(visible).map(function (a) {
        return [cut(nameOf(a), 80), relHref(a.getAttribute('href'))];
      }).filter(function (l) { var k = l[0] + '|' + l[1]; if (!l[1] || seen[k]) return false; seen[k] = 1; return true; });
      return { links: links.slice(0, 300), more: Math.max(0, links.length - 300) };
    }
    if (/^css=/i.test(spec)) {
      var els = deepQueryAll(spec.slice(4)).filter(visible);
      return { items: els.slice(0, 300).map(function (e) { return cut(e.innerText || e.textContent || valueOf(e), 400); }), more: Math.max(0, els.length - 300) };
    }
    var r = resolve(spec);
    if (r.error) return r;
    var v = valueOf(r.el);
    return { what: describe(r.el), value: v === null ? cut(r.el.innerText || r.el.textContent, limit) : v, ref: refOf(r.el) };
  }

  function busy() {
    var now = Date.now();
    return {
      ready: document.readyState, url: location.href, inflight: st.inflight,
      quiet: now - st.lastMutation, net: st.lastNet ? now - st.lastNet : 1e9
    };
  }

  function has(spec) {
    spec = norm(spec);
    if (/^gone:/i.test(spec)) { var g = has(spec.slice(5)); return !g; }
    if (/^css=/i.test(spec)) return deepQueryAll(spec.slice(4)).some(visible);
    if (/^e\d+$/.test(spec)) { var el = byRef(spec); return !!el && visible(el); }
    if (/^url:/i.test(spec)) return location.href.indexOf(spec.slice(4).trim()) >= 0;
    if (ROLE_WORDS.test(spec)) { var hit = resolve(spec); return !!hit.el && (visible(hit.el) || !!proxyOf(hit.el)); }
    var w = low(spec.replace(/^text:/i, ''));
    var docs = roots(document);
    for (var i = 0; i < docs.length; i++) {
      var body = docs[i].body || docs[i];
      if (low(body.innerText || body.textContent || '').indexOf(w) >= 0) return true;
    }
    return false;
  }

  function scroll(spec) {
    spec = norm(spec || 'down');
    if (spec === 'down' || spec === 'up') {
      var root = openDialog() || document.scrollingElement || document.documentElement;
      root.scrollBy({ top: (spec === 'down' ? 1 : -1) * Math.round(innerHeight * 0.85), behavior: 'instant' });
    } else if (spec === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (spec === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    } else {
      var r = resolve(spec);
      if (r.error) return r;
      (proxyOf(r.el) || r.el).scrollIntoView({ block: 'center', behavior: 'instant' });
      return { what: describe(r.el) };
    }
    return { y: Math.round(scrollY) };
  }

  // ---- entry points used from Python (each returns plain JSON) ---------------------------
  function withTarget(target, fn) {
    var r = resolve(target);
    if (r.error) return { error: r.error };
    var out = fn(r.el) || {};
    out.ref = out.ref || refOf(r.el);
    if (r.loose) out.loose = true;
    if (r.count > 1) out.matches = r.count;
    return out;
  }

  window.__hcx = {
    version: VERSION,
    map: map,
    read: read,
    busy: busy,
    has: has,
    found: function (t) { return !resolve(t).error; },
    scroll: scroll,
    point: function (t) { return withTarget(t, point); },
    prepareType: function (t, clear) { return withTarget(t, function (el) { return prepareType(el, clear); }); },
    finishType: function (t, text, clear) { return withTarget(t, function (el) { return finishType(el, text, clear); }); },
    select: function (t, want) { return withTarget(t, function (el) { return selectOption(el, want); }); },
    state: function (t) {
      return withTarget(t, function (el) {
        var out = { what: describe(el), checked: checkedOf(el), value: valueOf(el), role: roleOf(el), disabled: !!el.disabled };
        // A group label (fieldset legend, radiogroup): list its radio options so fill can pick one.
        var group = out.value === null && out.checked === null && el.closest && el.closest('fieldset,[role=radiogroup]');
        if (group) {
          out.choices = Array.prototype.filter.call(group.querySelectorAll('input[type=radio],[role=radio]'), function (r) {
            return visible(r) || !!proxyOf(r);
          }).map(function (r) { return [refOf(r), nameOf(r)]; });
        }
        return out;
      });
    },
    jsClick: function (t) { return withTarget(t, function (el) { (proxyOf(el) || el).click(); return { what: describe(el) }; }); },
    fileInput: function (t) {
      return withTarget(t, function (el) {
        if (!(el.tagName === 'INPUT' && el.type === 'file')) {
          var inner = el.querySelector && el.querySelector('input[type=file]');
          if (!inner) return { error: describe(el) + ' is not a file input' };
          el = inner;
        }
        el.setAttribute('data-hcx-upload', '1');
        return { what: describe(el) };
      });
    },
    uploadEl: function () {
      var e = deepQueryAll('[data-hcx-upload]')[0];
      if (e) e.removeAttribute('data-hcx-upload');
      return e || null;
    },
    notices: notices,
    apiLog: function () {
      return st.api.map(function (c) {
        return { i: c.i, url: c.url, method: c.method, status: c.status, size: c.size, preview: cut(c.body, 160) };
      });
    },
    apiBody: function (i) {
      for (var k = 0; k < st.api.length; k++) if (st.api[k].i === i) return st.api[k].body;
      return null;
    },
    // A request to this site's own server with the page's session (same origin only).
    apiCall: function (url, method, body) {
      var u;
      try { u = new URL(url, location.href); } catch (e) { return Promise.resolve({ error: 'bad url ' + url }); }
      if (u.origin !== location.origin) return Promise.resolve({ error: 'api calls stay on ' + location.origin + ' (the page you are on)' });
      var headers = { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' };
      var meta = document.querySelector('meta[name=csrf-token],meta[name=_csrf],meta[name=csrf_token]');
      if (meta && meta.content) headers['X-CSRF-TOKEN'] = meta.content;
      var xs = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(document.cookie);
      if (xs) headers['X-XSRF-TOKEN'] = decodeURIComponent(xs[1]);
      var init = { method: method || 'GET', credentials: 'include', headers: headers };
      if (body != null && init.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      var f = window.__hcxFetch || window.fetch;
      return f.call(window, u.href, init).then(function (r) {
        return r.text().then(function (t) {
          var out = t;
          try { out = JSON.parse(t); } catch (e) { out = t.length > 200000 ? t.slice(0, 200000) : t; }
          return { url: u.pathname + u.search, status: r.status, body: out };
        });
      }, function (e) { return { error: 'request failed: ' + e }; });
    }
  };
})();
