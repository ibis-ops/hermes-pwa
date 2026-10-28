// Page helper for the Chrome connector (chrome_connector.py). Hermes installs it in every
// document of the connector's tabs and calls window.__hcx from Runtime.evaluate. It lists what
// a page offers (with short refs like e12 kept on the elements as data-hcx), finds elements by
// ref, role and visible text, and does the DOM side of actions. Mouse and key input come from
// CDP, so pages see real events. Password values are never returned.
(function () {
  'use strict';
  var VERSION = 19;
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
    '[onclick]', '[tabindex]:not([tabindex="-1"])', '[draggable=true]'
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
    // A see-through checkbox or radio over a styled label (TodoMVC, many design systems) still takes the click.
    if (parseFloat(cs.opacity) === 0 && !isToggle(el)) return false;
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

  // An unlabelled checkbox or radio is named by the text right next to it: a text node, a <label> or <span>
  // that is not tied to it ("<input type=checkbox> checkbox 1", TodoMVC's "<input><label>milk</label>").
  function besideText(el) {
    var ways = [['nextSibling', 3], ['previousSibling', 2]];
    for (var w = 0; w < ways.length; w++) {
      var n = el[ways[w][0]];
      for (var hops = 0; n && hops < ways[w][1]; hops++, n = n[ways[w][0]]) {
        if (n.nodeType === 1 && (n.tagName === 'BR' || n.matches(SEL) || n.querySelector(SEL))) break;
        var t = n.nodeType === 3 ? norm(n.textContent) : n.nodeType === 1 ? norm(n.innerText || n.textContent) : '';
        if (t) return cut(t, 80);
      }
    }
    return '';
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
    if (!n && isToggle(el)) n = besideText(el);
    if (!n && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      var t = (el.type || '').toLowerCase();
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) n = norm(el.value);
      if (!n) n = norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id);
    }
    if (!n) n = norm(el.innerText || el.textContent);
    if (!n && tag === 'IMG') n = norm(el.getAttribute('alt') || el.getAttribute('title'));
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
    if (role === 'link') { var h = relHref(el.getAttribute('href')); if (h) s.href = cut(h, 70); }
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
    (ts.names = ts.names || {})[r] = [roleOf(el), nameOf(el)];
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

  // innerText, plus the text inside open shadow roots: web components (MDN's code examples, many design
  // systems) keep their text there, where innerText of the page does not reach.
  var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;

  function fullText(el, max) {
    if (!el) return '';
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      // A frame from this site reads as its page ("read css=frame[name=middle]").
      var fd = null;
      try { fd = el.contentDocument; } catch (e) { fd = null; }
      if (!fd || !fd.body) return '';
      return fd.body.tagName === 'FRAMESET' ? frameTexts(fd, 1, max || 200000).join('\n') : fullText(fd.body, max);
    }
    var shadow = !!el.shadowRoot;
    if (!shadow && el.querySelectorAll) {
      var all = el.querySelectorAll('*');
      for (var i = 0; i < all.length && !shadow; i++) if (all[i].shadowRoot) shadow = true;
    }
    if (!shadow) return el.innerText || el.textContent || '';
    var out = [], size = 0, cap = max || 200000;
    // Like innerText: no text from display:none subtrees or from visibility:hidden elements (their children
    // may still be visible, so the walk goes on below them).
    var walk = function (node, show) {
      if (size > cap) return;
      if (node.nodeType === 3) {
        if (show) { out.push(node.textContent); size += node.textContent.length; }
        return;
      }
      if (node.nodeType === 1) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
        if (node.tagName === 'SLOT') {
          var got = node.assignedNodes ? node.assignedNodes({ flatten: true }) : [];
          var src = got.length ? got : node.childNodes;
          for (var s = 0; s < src.length; s++) walk(src[s], show);
          return;
        }
        var cs = node.ownerDocument.defaultView.getComputedStyle(node);
        if (cs.display === 'none') return;
        // Not rendered (inside a closed <details>, content-visibility hidden); display:contents has no box.
        if (cs.display !== 'contents' && node.checkVisibility && !node.checkVisibility()) return;
        show = cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      }
      var kids = (node.shadowRoot || node).childNodes;
      for (var k = 0; k < kids.length; k++) walk(kids[k], show);
      if (node.nodeType === 1 && BLOCK.test(node.tagName)) out.push('\n');
    };
    walk(el, true);
    return out.join('');
  }

  // The text of this site's frames in a document, each under its name: a frameset page has no text of
  // its own, and some pages keep their content in a frame.
  function frameTexts(doc, depth, cap) {
    var out = [];
    if (depth > 3) return out;
    var fs = doc.querySelectorAll('frame,iframe');
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], d = null;
      try { d = f.contentDocument; } catch (e) { d = null; }
      if (!d || !d.body || (f.tagName === 'IFRAME' && !visible(f))) continue;
      if (d.body.tagName === 'FRAMESET') { out = out.concat(frameTexts(d, depth + 1, cap)); continue; }
      var name = f.getAttribute('name') || f.getAttribute('title') || f.id || ('frame ' + (i + 1));
      var t = blockText(fullText(d.body, cap));
      if (t) out.push('[frame ' + cut(name, 40) + ']\n' + t);
      out = out.concat(frameTexts(d, depth + 1, cap));
    }
    return out;
  }

  function mainText(limit) {
    if (document.body && document.body.tagName === 'FRAMESET') {
      var ft = frameTexts(document, 0, limit * 2).join('\n');
      return ft.length > limit ? ft.slice(0, limit) + '\n[... ' + (ft.length - limit) + ' more characters]' : ft;
    }
    var main = document.querySelector('main,[role=main]');
    // MDN's main is display:contents (no box of its own), so a main counts when it is rendered and has text.
    var root = main && getComputedStyle(main).display !== 'none' && (main.innerText || '').trim() ? main : document.body;
    if (!root) return '';
    var t = fullText(root, limit * 2 + 2000);
    t = t.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    // Little text of its own: what this site's frames show comes after it.
    if (t.length < 500) { var more = frameTexts(document, 0, limit).join('\n'); if (more) t = (t ? t + '\n' : '') + more; }
    return t.length > limit ? t.slice(0, limit) + '\n[... ' + (t.length - limit) + ' more characters; read with {"read": "text"}]' : t;
  }

  function notices() {
    var seen = {};
    return deepQueryAll('[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],.toast,.alert,.notification,.flash,.error,.invalid-feedback')
      .filter(visible).map(function (n) { return cut(n.innerText || n.textContent, 160); })
      .filter(function (t) { if (!t || seen[t]) return false; seen[t] = 1; return true; }).slice(0, 6);
  }

  // The text of the row or card a control sits in: the smallest container around it with text of its own,
  // short of a container that also holds another control with the same name.
  function rowText(el, name) {
    var n = low(name), role = roleOf(el), node = el;
    for (var i = 0; i < 6 && node.parentElement && node.parentElement !== document.body; i++) {
      var p = node.parentElement, same = 0, list = p.querySelectorAll(SEL);
      for (var j = 0; j < list.length && same < 2; j++) {
        if (list[j] === el || roleOf(list[j]) === role && low(nameOf(list[j])) === n) same++;
      }
      if (same > 1) return '';
      var t = norm(p.innerText || '');
      if (t && low(t) !== n) {
        if (n && low(t).indexOf(n) === 0) t = norm(t.slice(n.length));
        return t ? cut(t, 60) : '';
      }
      node = p;
    }
    return '';
  }

  // A page that walls this browser off (a bot check, an access block), named so the bot stops at once.
  // The title always counts; the text only on a short page, so an article about CAPTCHAs is not a wall.
  var TITLE_WALLS = [
    [/^just a moment\W*$|^attention required!? \| cloudflare/i, 'a Cloudflare check'],
    [/^(access denied|forbidden|403 forbidden|request rejected)$/i, 'an access block'],
    [/^(are you a robot|robot check|human verification|verify you are human)\b/i, 'a bot check']
  ];
  var TEXT_WALLS = [
    [/unusual traffic from your computer network/i, 'a Google bot check'],
    [/verify (that )?you are (a )?human|are you a robot|press (&|and) hold to confirm|i'?m not a robot/i, 'a bot check'],
    [/checking your browser before accessing|enable javascript and cookies to continue/i, 'a browser check'],
    [/to discuss automated access to amazon data|enter the characters you see below/i, 'an Amazon bot check'],
    [/blocked by network security|you'?ve been blocked|request unsuccessful\. incapsula/i, 'a block on this browser'],
    [/^access denied|you don'?t have permission to access .* on this server/i, 'an access block'],
    [/captcha/i, 'a captcha']
  ];

  function wallOf() {
    var title = norm(document.title), i;
    for (i = 0; i < TITLE_WALLS.length; i++) if (TITLE_WALLS[i][0].test(title)) return TITLE_WALLS[i][1];
    // A wall is a small page: skip reading the text of a big one (its inline scripts make textContent long).
    var small = document.body && document.body.getElementsByTagName('*').length < 800;
    var text = small ? norm(document.body.innerText || '') : '';
    if (!text || text.length >= 1500) return '';
    for (i = 0; i < TEXT_WALLS.length; i++) if (TEXT_WALLS[i][0].test(text)) return TEXT_WALLS[i][1];
    return '';
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
    // A destination is listed once (a product card links its picture and its title to the same page);
    // text targets still reach every copy.
    var seenHref = {};
    els = els.filter(function (el) {
      if (el.tagName !== 'A') return true;
      var key = relHref(el.getAttribute('href'));
      if (!key || key.charAt(0) === '#') return true;
      if (seenHref[key]) return false;
      seenHref[key] = 1;
      return true;
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
    var out = [], outEls = [];
    first.forEach(function (el) { if (out.length < limit) { out.push(entryOf(el, false)); outEls.push(el); } });
    var behindCount = 0;
    rest.forEach(function (el) {
      if (out.length < limit && opts.full) { out.push(entryOf(el, true)); outEls.push(el); } else behindCount++;
    });
    // Controls that share a name (a Delete in every row, an "Add to cart" on every card) get their row's text.
    var groups = {};
    out.forEach(function (e) { var k = e[1] + '|' + e[2]; groups[k] = (groups[k] || 0) + 1; });
    out.forEach(function (e, i) {
      if (groups[e[1] + '|' + e[2]] > 1) { var rt = rowText(outEls[i], e[2]); if (rt) e[3].row = rt; }
    });
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
      notices: notices(), heads: heads, frames: frames, login: pw.length > 0, wall: wallOf(),
      els: out, total: total, cut: Math.max(0, total - out.length - (opts.full ? 0 : behindCount)),
      text: opts.text === 0 ? '' : mainText(opts.text || 1200),
      scroll: [Math.round(scrollY), Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))]
    };
  }

  // ---- finding a target -------------------------------------------------------------------
  // Forms: e12 (a ref from the map), css=<selector>, role:Name (button:Save, textbox:Email,
  // link:Clients), or plain visible text / label / placeholder. Text matching prefers exact,
  // then starts-with, then contains; then enabled, inside an open dialog, on screen; the first on
  // the page wins a tie. Forms models also write are taken too: text:Save, "Save", role:searchbox,
  // #id or .class without css=, "Delete in Jane Doe" (the control in the row that holds that text),
  // "Login button" or "Card A" (a kind of control named with the name).
  // A step's kind (type, select, check) prefers controls of that kind, and an unlabelled field or list
  // is found by the text just before it.
  function typeable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !/^(checkbox|radio|file|button|submit|reset|image|range|color|hidden)$/i.test(el.type || 'text');
    return false;
  }

  // A wrapper that holds one field (a combobox box around its input) types into that field.
  function typeInside(el) {
    if (!el || !el.querySelectorAll) return null;
    var fs = Array.prototype.filter.call(el.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true]'),
      function (x) { return typeable(x) && visible(x); });
    return fs.length === 1 ? fs[0] : null;
  }

  function fitsKind(el, kind) {
    if (kind === 'type') return typeable(el) || !!typeInside(el);
    if (kind === 'select') return el.tagName === 'SELECT' || /^(combobox|listbox)$/.test(el.getAttribute('role') || '');
    if (kind === 'check') return checkedOf(el) !== null;
    return true;
  }

  var TYPED = /^(textbox|searchbox|combobox|spinbutton)$/;
  function roleFits(r, role) {
    // Fields a person types into are one kind: a search box is often a combobox (MDN, Google), a text box
    // a searchbox or spinbutton.
    return !role || r === role || (role === 'textbox' && r === 'password') || (TYPED.test(role) && TYPED.test(r)) ||
      (role === 'select' && r === 'combobox') || (role === 'button' && r === 'clickable');
  }

  function unquote(s) {
    s = norm(s);
    var q = /^["'\u201c\u2018](.*)["'\u201d\u2019]$/.exec(s);
    return q ? norm(q[1]) : s;
  }

  // Every control whose name fits `w` (all of a role when `w` is empty), with a score.
  function scored(w, role, kind, dialog) {
    var out = [];
    candidates().forEach(function (el) {
      if (!roleFits(roleOf(el), role)) return;
      var n = low(nameOf(el));
      var score = 0;
      if (!w) score = 50;
      else {
        var alt = low(el.getAttribute('placeholder') || '') + '|' + low(el.getAttribute('title') || '') + '|' + low(el.getAttribute('name') || '');
        // A dropdown list also answers to the text it shows ("Please select an option").
        if (el.tagName === 'SELECT' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) alt += '|' + low(el.options[el.selectedIndex].text);
        if (n === w) score = 100;
        else if (w.length <= 2) {
          // A one- or two-letter target ("A", "OK") is a whole word, never a piece of another name.
          if (new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(n)) score = 60;
          else return;
        }
        else if (n.indexOf(w) === 0) score = 70;
        else if (n.indexOf(w) > 0) score = 50;
        else if (alt.indexOf(w) >= 0) score = 40;
        else return;
      }
      if (!(el.disabled || el.getAttribute('aria-disabled') === 'true')) score += 8;
      if (dialog && dialog.contains(el)) score += 12;
      if (inViewport(el)) score += 3;
      score -= Math.min(10, Math.max(0, n.length - w.length) / 20);
      if (kind && fitsKind(el, kind)) score += 100;
      out.push({ el: el, score: score });
    });
    return out;
  }

  function top(list) {
    var best = null;
    list.forEach(function (c) { if (!best || c.score > best.score) best = c; });
    return best;
  }

  // The smallest visible element whose own text is the target (clickable divs, table headers). Nested
  // matches are one (the label inside its list item: the inner one wins); apart from that the first on
  // the page wins, and the count says how many there are.
  function textMatches(w) {
    var picks = [], group = null;
    roots(document).forEach(function (r) {
      var walker = (r.ownerDocument || r).createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      var n = walker.currentNode;
      while (n) {
        if (n.nodeType === 1 && n.childElementCount < 4 && (n.textContent || '').length <= w.length + 40 &&
            low(n.innerText || '') === w && visible(n)) {
          if (group && group.contains(n)) picks[picks.length - 1] = n;
          else { group = n; picks.push(n); }
        }
        n = walker.nextNode();
      }
    });
    return picks;
  }

  function textMatch(w) {
    var picks = textMatches(w);
    return picks.length ? { el: picks[0], count: picks.length, loose: true } : null;
  }

  // Pictures and icons named by their alt text, label or title ("hover User Avatar").
  function altMatches(w) {
    return deepQueryAll('img[alt],svg[aria-label],[role=img][aria-label],[title]').filter(function (el) {
      var a = low(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      return a && (a === w || (w.length > 2 && a.indexOf(w) >= 0)) && visible(el);
    });
  }

  // An unlabelled field or list named by the text before it ("Dropdown List" over a <select>, a "Name"
  // line over its input): the first such control after that text, in the same box.
  function controlAfter(el, kind) {
    var css = kind === 'select' ? 'select,[role=combobox],[role=listbox]' :
      'input,textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]';
    var node = el;
    for (var i = 0; i < 3 && node && node.nodeType === 1 && node !== document.body; i++) {
      var list = node.querySelectorAll(css);
      for (var j = 0; j < list.length; j++) {
        var c = list[j];
        if (!(visible(c) || proxyOf(c)) || !fitsKind(c, kind)) continue;
        if (el.contains(c) || el.compareDocumentPosition(c) & 4) return c;
      }
      node = node.parentElement;
    }
    return null;
  }

  // "Delete in Jane Doe", "Toggle Todo in beta task", "Edit for Invoice 7": the control named X that sits
  // closest to the text Y (its row, card or item; the map shows such rows as: checkbox "Toggle" e19 in "beta").
  function scopeSplits(want) {
    var splits = [], m;
    var re = /\s+(?:in|inside|within|for|of|on|at|next to|beside|near)\s+(?:the\s+)?(?:(?:row|item|card|line|entry|task|section|box)\s+)?(?:(?:with|containing|named|called)\s+)?/ig;
    while ((m = re.exec(want))) splits.push([want.slice(0, m.index), want.slice(m.index + m[0].length)]);
    var colon = want.indexOf(':');
    if (colon > 0) splits.push([want.slice(0, colon), want.slice(colon + 1)]);
    return splits;
  }

  // How far up from el the nearest box holding the text y is (99: none within 9 levels or 20k characters).
  function depthTo(el, y) {
    var node = el, d = 0;
    while (node && d < 9) {
      var tc = node.textContent || '';
      if (tc.length > 20000) return 99;
      if (low(node.innerText || tc).indexOf(y) >= 0) return d;
      node = node.parentElement;
      d++;
    }
    return 99;
  }

  function scopedMatch(want, role, kind, dialog) {
    var splits = scopeSplits(want);
    for (var i = 0; i < splits.length; i++) {
      var x = low(unquote(splits[i][0])), y = low(unquote(splits[i][1]));
      if (!x || !y) continue;
      var hits = scored(x, role, kind, dialog);
      var best = null, bestD = 99, bestS = -1;
      hits.forEach(function (h) {
        var d = depthTo(h.el, y);
        if (d >= 9) return;
        if (d < bestD || d === bestD && h.score > bestS) { best = h.el; bestD = d; bestS = h.score; }
      });
      if (best) return { el: best, count: 1, loose: true };
    }
    return null;
  }

  // "Login button", "the Search box", "Card A", "searchbox": a kind of control named with the name.
  var NOUN_ROLE = {
    'button': 'button', 'link': 'link', 'checkbox': 'checkbox', 'check box': 'checkbox', 'radio button': 'radio',
    'radio': 'radio', 'field': 'textbox', 'input': 'textbox', 'textbox': 'textbox', 'text box': 'textbox',
    'text field': 'textbox', 'search box': 'textbox', 'searchbox': 'textbox', 'search field': 'textbox',
    'box': 'textbox', 'combobox': 'combobox', 'dropdown': 'select', 'drop-down': 'select', 'select': 'select',
    'tab': 'tab', 'option': 'option', 'menu': '', 'icon': '', 'card': '', 'column': '', 'item': '', 'row': '',
    'entry': '', 'toggle': '', 'switch': 'switch', 'heading': '', 'label': '', 'title': ''
  };
  var NOUNS = Object.keys(NOUN_ROLE).sort(function (a, b) { return b.length - a.length; })
    .map(function (k) { return k.replace(/[-]/g, '\\-').replace(/ /g, '\\s+'); }).join('|');
  var NOUN_END = new RegExp('^(.+?)\\s+(' + NOUNS + ')$', 'i');
  var NOUN_START = new RegExp('^(' + NOUNS + ')\\s+(.+)$', 'i');
  function nounForms(want, role) {
    var s = norm(want).replace(/^the\s+/i, ''), rest = null, noun = null, m = NOUN_END.exec(s);
    if (m) { rest = m[1]; noun = m[2]; } else if ((m = NOUN_START.exec(s))) { noun = m[1]; rest = m[2]; }
    if (!rest) {
      var only = NOUN_ROLE[low(s)];
      return only && !role ? ['role:' + only] : [];
    }
    var nr = NOUN_ROLE[low(noun)];
    var out = [];
    if (nr && !role) out.push(nr + ':' + rest);
    // Without its kind, a name of one or two letters ("Option 2") would match too much.
    if (!nr || role || norm(rest).length > 2) out.push((role ? role + ':' : '') + rest);
    return out;
  }

  // "first result", "the second product", "3rd item", "first product result", "last video": an entry of the
  // page's main list of results, found as the biggest group of repeated boxes (cards, rows, list items, all
  // with the same tag and class) that hold a link, outside the header, menus, filters and footer.
  var ORDINAL = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
  var ORDINAL_RE = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s+(?:(?:search|product|video|news)\s+)?(?:result|product|item|link|video|article|listing|match|entry|card|hit|post|repo|repository|book|story)s?\b/i;
  function nthResult(n) {
    var groups = [], keys = [];
    deepQueryAll('a[href]').forEach(function (a) {
      var h = a.getAttribute('href') || '';
      if (!h || h.charAt(0) === '#' || /^javascript:/i.test(h) || !visible(a) || norm(nameOf(a)).length < 3) return;
      if (a.closest('nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[role=menu],[role=search]')) return;
      var node = a;
      for (var hops = 0; node.parentElement && hops < 8; hops++) {
        var same = 0;
        for (var c = node.parentElement.firstElementChild; c && same < 3; c = c.nextElementSibling) {
          if (c.tagName === node.tagName && c.className === node.className) same++;
        }
        if (same >= 3) break;
        node = node.parentElement;
      }
      if (!node.parentElement || node === document.body) return;
      var i = keys.indexOf(node.parentElement);
      if (i < 0) { keys.push(node.parentElement); groups.push({ cards: [], links: [] }); i = keys.length - 1; }
      if (groups[i].cards.indexOf(node) < 0) { groups[i].cards.push(node); groups[i].links.push(a); }
    });
    var best = null;
    groups.forEach(function (g) { if (g.cards.length >= 3 && (!best || g.cards.length > best.cards.length)) best = g; });
    if (!best) return null;
    return n < 0 ? best.links[best.links.length - 1] : best.links[n - 1] || null;
  }

  // Role names models write that are not ARIA's: role:search (MDN), role:input, role:dropdown.
  var ROLE_ALIAS = { search: 'searchbox', input: 'textbox', textfield: 'textbox', field: 'textbox', text: 'textbox',
    dropdown: 'select', a: 'link', btn: 'button' };

  // "second image", "third figure", "first row": elements of that kind (or with that class), taken from
  // the biggest group of repeated boxes when there is one, so a logo or a ribbon picture does not count.
  var KIND_SEL = {
    image: 'img,[role=img]', images: 'img,[role=img]', picture: 'img,[role=img]', photo: 'img,[role=img]',
    avatar: 'img,[role=img]', thumbnail: 'img,[role=img]', img: 'img,[role=img]', figure: 'figure,.figure',
    row: 'tr,[role=row]', button: 'button,[role=button]', link: 'a[href]', checkbox: 'input[type=checkbox],[role=checkbox]',
    field: 'input:not([type=hidden]),textarea', input: 'input:not([type=hidden]),textarea', card: '.card,[class*=card]',
    heading: 'h1,h2,h3,h4', item: 'li,[role=listitem]', tab: '[role=tab]', option: '[role=option],option'
  };
  function kindPool(rest) {
    var word = rest.replace(/s$/, ''), sel = KIND_SEL[rest] || KIND_SEL[word];
    if (!sel && /^[a-z][\w-]*$/.test(word)) sel = '.' + word + ',.' + rest;  // a class name: "second figure"
    if (!sel) return [];
    var els = [];
    try { els = deepQueryAll(sel).filter(visible); } catch (e) { return []; }
    if (els.length < 2) return els;
    var groups = [], keys = [];
    els.forEach(function (el) {
      var node = el;
      for (var hops = 0; node.parentElement && hops < 6; hops++) {
        var same = 0;
        for (var c = node.parentElement.firstElementChild; c && same < 2; c = c.nextElementSibling) {
          if (c.tagName === node.tagName && c.className === node.className) same++;
        }
        if (same >= 2) break;
        node = node.parentElement;
      }
      var i = keys.indexOf(node.parentElement);
      if (i < 0) { keys.push(node.parentElement); groups.push([]); i = keys.length - 1; }
      groups[i].push(el);
    });
    var best = groups.reduce(function (a, g) { return g.length > a.length ? g : a; }, []);
    return best.length >= 2 ? best : els;
  }

  // Last resort: a control whose name starts with the target's first word and shares at least half of
  // its words ("Search MDN" finds the Search button, not "Skip to search"). The first word must match, so
  // "Accept all cookies" never lands on "Reject all cookies".
  function wordMatch(w, role, dialog) {
    var ws = w.split(' ').filter(Boolean);
    if (ws.length < 2 || ws[0].length < 3) return null;
    var best = null, bestS = 0;
    candidates().forEach(function (el) {
      if (!roleFits(roleOf(el), role)) return;
      var nw = low(nameOf(el)).split(' ');
      if (nw[0] !== ws[0]) return;
      var hit = ws.filter(function (x) { return nw.indexOf(x) >= 0; }).length / ws.length;
      if (dialog && dialog.contains(el)) hit += 0.01;
      if (hit >= 0.5 && hit > bestS) { best = el; bestS = hit; }
    });
    return best;
  }

  function resolve(target, kind, depth, probe) {
    target = norm(target);
    depth = depth || 0;
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
      if (!seen) {
        return { error: 'ref ' + target + ' was never on this page: refs come from a map of the page you are on. ' +
          'Target by visible text or label instead (click Upload, type Search = shoes), or use a ref from the map below.' };
      }
      return { error: 'ref ' + target + ' is gone (the page changed). Use the newest map, or target by text.' };
    }
    if (/^css=/i.test(target)) {
      var css = target.slice(4);
      var hits = deepQueryAll(css);
      var vis = hits.filter(function (h) { return visible(h) || proxyOf(h); });
      if (vis.length) return { el: vis[0], count: vis.length };
      if (hits.length) return { el: hits[0], count: hits.length, hidden: true };
      // "css=.destroy in alpha task": that selector in the row or card holding the text.
      var cm = /^(.+?)\s+in\s+(.+)$/i.exec(css);
      if (cm) {
        var y = low(unquote(cm[2])), near = null, nearD = 99;
        deepQueryAll(cm[1]).forEach(function (h) { var d = depthTo(h, y); if (d < nearD) { near = h; nearD = d; } });
        if (near) return { el: near, count: 1, loose: true, hidden: !(visible(near) || proxyOf(near)) };
      }
      return { error: 'no element matches ' + css };
    }
    var t = unquote(target.replace(/^text\s*[:=]\s*/i, ''));
    var role = null, want = t;
    var rm = /^role\s*[:=]\s*([a-z]+)\s*(?:\[\s*name\s*=\s*(.*?)\s*\]|[:=\s]\s*(.*))?$/i.exec(t);
    var m = ROLE_WORDS.exec(t);
    if (rm) { role = rm[1].toLowerCase(); role = ROLE_ALIAS[role] || role; want = unquote(rm[2] || rm[3] || ''); }
    else if (m) { role = m[1].toLowerCase(); want = unquote(m[2]); }
    var w = low(want);
    var dialog = openDialog();
    if (!w && role === 'searchbox') {
      // "role:searchbox": a field that is one (type=search, role searchbox) or is named for search; else the
      // Search button that opens one (MDN, many site headers); else any field.
      var sb = top(scored('', 'searchbox', kind, dialog).filter(function (h) { return roleOf(h.el) === 'searchbox'; })) ||
        top(scored('search', 'searchbox', kind, dialog)) ||
        top(scored('search', null, null, dialog).filter(function (h) { return !typeable(h.el); }));
      if (sb) return { el: sb.el, count: 1, loose: true };
    }
    var found = scored(w, role, kind, dialog);
    var best = top(found);
    if (best) return { el: best.el, count: found.length, loose: !w };
    if (!w) return { error: 'no ' + role + ' on the page' };
    var small = textMatch(w);
    if (small) {
      var after = (kind === 'type' || kind === 'select') && !fitsKind(small.el, kind) ? controlAfter(small.el, kind) : null;
      if (after) return { el: after, count: 1, loose: true };
      return small;
    }
    var pics = altMatches(w);
    if (pics.length) return { el: pics[0], count: pics.length, loose: true };
    if (depth < 2) {
      var sc = scopedMatch(want, role, kind, dialog);
      if (sc) return sc;
      var forms = nounForms(want, role);
      for (var i = 0; i < forms.length; i++) {
        var r2 = resolve(forms[i], kind, depth + 1);
        if (r2.el) { r2.loose = true; return r2; }
      }
    }
    // "second User Avatar", "the third Delete", "last Edit": that one of the matches, in page order.
    var on = !depth && /^(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s+(.+)$/i.exec(want);
    if (on) {
      var nth = ORDINAL[on[1].toLowerCase()], rest = low(unquote(on[2]));
      var pool = scored(rest, role, kind, dialog).map(function (h) { return h.el; });
      if (!pool.length) pool = textMatches(rest);
      if (!pool.length) pool = altMatches(rest);
      if (!pool.length) pool = kindPool(rest);
      var pick = nth < 0 ? pool[pool.length - 1] : pool[nth - 1];
      if (pick) return { el: pick, count: pool.length, loose: true };
    }
    var om = !depth && ORDINAL_RE.exec(want);
    if (om) {
      var nr = nthResult(ORDINAL[om[1].toLowerCase()]);
      if (nr) return { el: nr, count: 1, loose: true };
    }
    // An element id written bare ("drag column-a = column-b").
    if (/^[A-Za-z][\w-]*$/.test(want)) {
      var byId = deepQueryAll('[id="' + want + '"]').filter(function (h) { return visible(h) || proxyOf(h); });
      if (byId.length === 1) return { el: byId[0], count: 1, loose: true };
    }
    if (/^[#.][A-Za-z_-]|^\[[A-Za-z_-]|^[a-z][a-z0-9-]*[#.\[]|\s>\s/.test(want)) {
      var ch = deepQueryAll(want), cv = ch.filter(function (h) { return visible(h) || proxyOf(h); });
      if (cv.length) return { el: cv[0], count: cv.length, loose: true };
    }
    if (depth) return { error: 'no match' };
    var wm = wordMatch(w, role, dialog);
    if (wm) return { el: wm, count: 1, loose: true };
    // While a step still waits for its target (probe), only on a page that has settled: the field it
    // names may yet appear.
    var settled = document.readyState === 'complete' && !st.inflight && Date.now() - st.lastMutation > 800;
    if (kind === 'type' && (!probe || settled)) {
      // "type Add item = milk" on a page with one field (a to-do list's input named otherwise): that field.
      // The reply names the field it used.
      var fields = candidates().filter(function (el) { return typeable(el) && roleOf(el) !== 'password'; });
      if (fields.length === 1) return { el: fields[0], count: 1, loose: true };
    }
    var words = w.split(' ').filter(function (x) { return x.length > 2; });
    var short = w.split(' ').filter(function (x) { return x && x.length <= 2; });
    var near = [];
    candidates().forEach(function (el) {
      if (near.length >= 6) return;
      var n = nameOf(el);
      var ln = low(n);
      if (n && (words.some(function (x) { return ln.indexOf(x) >= 0; }) || short.indexOf(ln) >= 0)) {
        near.push(roleOf(el) + ' "' + cut(n, 40) + '" ' + refOf(el));
      }
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

  // Offset of el's document inside the top page (same-site frames).
  function topOffset(doc) {
    var ox = 0, oy = 0, w = doc.defaultView;
    try {
      while (w && w !== window && w.frameElement) {
        var fr = w.frameElement.getBoundingClientRect();
        ox += fr.left + (w.frameElement.clientLeft || 0);
        oy += fr.top + (w.frameElement.clientTop || 0);
        w = w.parent;
      }
    } catch (e) { /* cross-origin parent: leave the offset */ }
    return [ox, oy];
  }

  // The control that opens the closed list or menu an option sits in: the one naming the list in
  // aria-controls or aria-owns, else the nearest popup button or combobox around the list.
  function openerFor(el) {
    var lb = el.closest && el.closest('[role=listbox],[role=menu]');
    if (!lb) return null;
    if (lb.id) {
      var named = deepQueryAll('[aria-controls~="' + lb.id + '"],[aria-owns~="' + lb.id + '"]').filter(visible);
      if (named.length) return named[0];
    }
    var node = lb.parentElement;
    for (var k = 0; k < 4 && node && node !== document.body; k++, node = node.parentElement) {
      var cs = Array.prototype.filter.call(node.querySelectorAll('[aria-haspopup],[role=combobox],[aria-expanded]'), visible);
      if (cs.length) return cs[0];
    }
    return null;
  }

  // A control that shows only while the mouse is over its row (row actions, TodoMVC's delete button):
  // the row to hover first, and the control's ref to act on once it shows. "Delete in gamma task" picks
  // the row that holds that text.
  function reveal(t) {
    var s = unquote(norm(t).replace(/^text\s*[:=]\s*/i, '')), role = null;
    var m = ROLE_WORDS.exec(s);
    if (m) { role = m[1].toLowerCase(); s = unquote(m[2]); }
    var tries = [[s, '']].concat(scopeSplits(s));
    var all = deepQueryAll(SEL);
    for (var i = 0; i < tries.length; i++) {
      var w = low(unquote(tries[i][0])), y = low(unquote(tries[i][1]));
      if (!w || (tries[i][1] && !y)) continue;
      var best = null, bestD = 99;
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (visible(el) || proxyOf(el) || !roleFits(roleOf(el), role)) continue;
        var n = low(nameOf(el));
        if (!(n === w || (w.length > 2 && n.indexOf(w) >= 0))) continue;
        var row = el.parentElement, k;
        for (k = 0; k < 4 && row && !visible(row); k++) row = row.parentElement;
        if (!row || !visible(row) || row === document.body) continue;
        var d = y ? depthTo(el, y) : 0;
        if (d < bestD) { best = [el, row]; bestD = d; }
        if (!y) break;
      }
      if (best) {
        // An option of a closed dropdown list ("click One way"): open the list first.
        var op = openerFor(best[0]);
        if (op) return { ref: refOf(best[0]), opener: refOf(op), what: describe(best[0]) };
        try { best[1].scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { /* ignore */ }
        var r = best[1].getBoundingClientRect(), off = topOffset(best[1].ownerDocument);
        return { ref: refOf(best[0]), x: r.left + r.width / 2 + off[0], y: r.top + r.height / 2 + off[1], what: describe(best[0]) };
      }
    }
    return null;
  }

  // ---- trouble ----------------------------------------------------------------------------
  // The HTTP status this document arrived with (0 when the browser does not say).
  function docStatus() {
    try { var e = performance.getEntriesByType('navigation')[0]; return (e && e.responseStatus) || 0; } catch (x) { return 0; }
  }

  function signin() { return deepQueryAll('input[type=password]').some(visible); }

  // A page that says it is not there (a 404 page), as opposed to an app that answers 404 but still shows its
  // content (some single-page sites are served that way).
  function notFoundPage() {
    var heads = [document.title].concat(Array.prototype.map.call(document.querySelectorAll('h1,h2'), function (h) { return h.innerText; }));
    if (heads.some(function (t) { return /\b404\b|not found|n.?t exist|no longer (available|exists)|page (is )?missing|can.?t be found|cannot be found/i.test(t || ''); })) return true;
    return norm(document.body ? document.body.innerText : '').length < 200;
  }

  // Whether the target is what a click at (x, y) would hit now: a page can slide content in or re-render a
  // control as the pointer arrives.
  function hitsAt(t, x, y) {
    var r = resolve(t);
    if (!r.el) return false;
    var el = proxyOf(r.el) || r.el, doc = el.ownerDocument, off = topOffset(doc);
    var scope = el.getRootNode ? el.getRootNode() : doc;
    var hit = (scope && scope.elementFromPoint ? scope : doc).elementFromPoint(x - off[0], y - off[1]);
    return !!hit && (hit === el || el.contains(hit) || (hit.control && hit.control === r.el) ||
      (hit.tagName === 'LABEL' && r.el.labels && Array.prototype.indexOf.call(r.el.labels, hit) >= 0));
  }

  // What covers a target, when it is a cookie banner or a promotional popup, and the button that clears it
  // without agreeing to anything: Reject all, Only necessary, No thanks, Close.
  var CLEAR_RE = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|(use )?(only )?(strictly )?(necessary|essential)( cookies)?( only)?|continue without (accepting|agreeing)|no,? thanks|not now|maybe later|close|dismiss|skip|\u00d7|\u2715|x)$/i;
  var REJECT_FIRST = /^(reject|decline|deny|refuse|only|use|strictly|necessary|essential|continue)/i;
  function cover(t) {
    var r = resolve(t);
    if (!r.el) return null;
    var el = proxyOf(r.el) || r.el, rc = el.getBoundingClientRect();
    var hit = el.ownerDocument.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
    if (!hit || hit === el || el.contains(hit)) return null;
    var box = hit;
    while (box && box !== el.ownerDocument.body) {
      var cs = getComputedStyle(box), role = box.getAttribute('role') || '';
      if (cs.position === 'fixed' || cs.position === 'sticky' || /dialog/.test(role) || box.getAttribute('aria-modal') === 'true') break;
      box = box.parentElement;
    }
    if (!box || box === el.ownerDocument.body) return null;
    var text = low(box.innerText || '');
    var kind = /cookie|consent|privacy|gdpr|tracking/.test(text) ? 'a cookie banner' :
      /newsletter|subscribe|discount|offer|sign up|signup|promo/.test(text) ? 'a popup' : '';
    if (!kind) return null;
    var btns = Array.prototype.filter.call(box.querySelectorAll('button,[role=button],a,[aria-label]'), function (b) {
      return visible(b) && (CLEAR_RE.test(norm(nameOf(b))) || /^(close|dismiss)/i.test(b.getAttribute('aria-label') || ''));
    });
    btns.sort(function (a, b) { return (REJECT_FIRST.test(nameOf(b)) ? 1 : 0) - (REJECT_FIRST.test(nameOf(a)) ? 1 : 0); });
    return btns.length ? { kind: kind, ref: refOf(btns[0]), name: cut(nameOf(btns[0]), 40) } : { kind: kind, ref: '' };
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
    // A button or link is not a field: the caller clicks it (a search button opens the search box) and
    // types into the field that appears.
    if (el.tagName === 'SELECT') return { notField: true, list: true, what: describe(el) };
    var field = typeable(el) || el.tagName === 'INPUT' && /^(range|color)$/i.test(el.type) ? el : typeInside(el);
    if (!field) return { notField: true, what: describe(el) };
    el = field;
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
    return { before: before, focused: active === el || el.contains(active), what: describe(el), kind: el.type || '', ref: refOf(el) };
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
    // "read #result", "read .price": a selector written without css=.
    if (/^[#.][A-Za-z_-][\w-]*$/.test(spec) && deepQueryAll(spec).some(visible)) spec = 'css=' + spec;
    if (spec === 'text') {
      var mt = mainText(limit);
      return { text: mt, heads: mt.length > 2500 ? sectionHeads() : [] };
    }
    if (/^section\s*[:=]/i.test(spec)) return readSection(spec.replace(/^section\s*[:=]\s*/i, ''), limit);
    if (spec === 'all') return { text: (document.body.innerText || '').slice(0, limit) };
    if (spec === 'form') return readForm();
    if (spec === 'table') return readTable(null);
    if (/^(the )?(list|items|list items|results|search results|entries)$/i.test(spec)) {
      // The page's main list: the visible list with the most items outside the header, menus and footer.
      var lists = deepQueryAll('ul,ol,[role=list],[role=listbox],[role=feed]').filter(visible), bestL = null, nL = 0;
      lists.forEach(function (l) {
        if (l.closest('nav,header,footer,[role=navigation],[role=menu]')) return;
        var k = Array.prototype.filter.call(l.children, function (c) { return visible(c) && norm(c.innerText); }).length;
        if (k > nL) { bestL = l; nL = k; }
      });
      if (!bestL) return { items: [] };
      var kids = Array.prototype.filter.call(bestL.children, function (c) { return visible(c) && norm(c.innerText); });
      return { items: kids.slice(0, 300).map(function (c) { return cut(fullText(c), 400); }), more: Math.max(0, kids.length - 300) };
    }
    if (/^table\s*[:=]\s*\d+$/.test(spec)) {
      // "read table:2": the second table on the page.
      var nth = +spec.replace(/^table\s*[:=]\s*/, ''), tabs = deepQueryAll('table').filter(visible);
      return tabs[nth - 1] ? readTable(tabs[nth - 1]) : { error: 'the page has ' + tabs.length + ' tables' };
    }
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
      return { items: els.slice(0, 300).map(function (e) { return cut(fullText(e) || valueOf(e), 400); }), more: Math.max(0, els.length - 300) };
    }
    if (!ROLE_WORDS.test(spec) && !/^e\d+$/.test(spec)) {
      // "read Born", "read Price": a label cell, term or heading with exactly that text reads its value.
      var cell = labelCell(spec);
      var pt = cell && pairedText(cell, limit);
      if (pt) return { what: describe(cell), value: pt, ref: refOf(cell), block: pt.indexOf('\n') >= 0 };
    }
    var r = resolve(spec);
    if (r.error) return r;
    var v = valueOf(r.el);
    if (v === null) {
      // A label cell or heading named by the target reads what belongs to it: "read Born" on an infobox
      // gives the date, "read Syntax" the section under that heading.
      var paired = pairedText(r.el, limit);
      if (paired) return { what: describe(r.el), value: paired, ref: refOf(r.el), block: paired.indexOf('\n') >= 0 };
    }
    return { what: describe(r.el), value: v === null ? cut(r.el.innerText || r.el.textContent, limit) : v, ref: refOf(r.el) };
  }

  var HEAD_SEL = 'h1,h2,h3,h4,h5,h6,[role=heading]';

  function headLevel(h) {
    var m = /^H(\d)$/.exec(h.tagName);
    return m ? +m[1] : +(h.getAttribute('aria-level') || 2);
  }

  function blockText(t) {
    return String(t || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }

  // Headings of the main content, to say what a long text read left out.
  function sectionHeads() {
    var main = document.querySelector('main,[role=main]');
    var root = main && visible(main) ? main : document.body;
    return Array.prototype.slice.call(root.querySelectorAll('h2,h3')).filter(visible)
      .map(function (h) { return cut(h.innerText, 50); }).filter(Boolean).slice(0, 30);
  }

  // The text under the heading named `want`, up to the next heading of the same or a higher level.
  function readSection(want, limit) {
    var w = low(want);
    var heads = deepQueryAll(HEAD_SEL + ',summary,legend').filter(visible);
    var best = null, score = 0;
    heads.forEach(function (h) {
      var t = low(h.innerText || h.textContent);
      var s = t === w ? 3 : t.indexOf(w) === 0 ? 2 : t.indexOf(w) >= 0 ? 1 : 0;
      if (s > score) { best = h; score = s; }
    });
    if (!best) {
      // Not a heading: a label cell or term with that text ("section:Born"), then a box whose id, class or
      // label is that word ("section:infobox").
      var cell = labelCell(want), pt = cell && pairedText(cell, limit);
      if (pt) return { what: describe(cell), value: pt, ref: refOf(cell), block: pt.indexOf('\n') >= 0 };
      var box = null;
      try {
        // As written, lower case and hyphenated: "section:Infobox" finds .infobox, "section:Price box" .price-box.
        var forms = [norm(want), low(want), low(want).replace(/ /g, '-')], sels = [];
        forms.forEach(function (f) { var esc = CSS.escape(f); sels.push('#' + esc, '.' + esc); });
        sels.push('[aria-label="' + norm(want).replace(/"/g, '') + '" i]');
        box = deepQueryAll(sels.join(',')).filter(visible)[0];
      } catch (e) { box = null; }
      if (box) return { what: describe(box), value: clip(blockText(fullText(box)), limit), ref: refOf(box), block: true };
      return { error: 'no heading named "' + want + '". Headings: ' +
        heads.slice(0, 20).map(function (h) { return cut(h.innerText, 40); }).join(' | ') };
    }
    return { what: describe(best), value: clip(sectionText(best), limit), ref: refOf(best), block: true };
  }

  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }

  function sectionText(h) {
    var box = h.parentElement;
    if (box && /^(SECTION|DETAILS|FIELDSET|ARTICLE)$/.test(box.tagName) &&
        box.querySelector(HEAD_SEL + ',summary,legend') === h) {
      return blockText(fullText(box));
    }
    var lv = /^(SUMMARY|LEGEND)$/.test(h.tagName) ? 1 : headLevel(h);
    var out = [norm(h.innerText)], node = h, size = 0;
    while (node && size < 60000) {
      var next = node.nextElementSibling;
      while (!next && node.parentElement && node.parentElement !== document.body) {
        node = node.parentElement;
        next = node.nextElementSibling;
      }
      if (!next) break;
      node = next;
      var stop = node.matches(HEAD_SEL) ? node : node.querySelector(HEAD_SEL);
      if (stop && headLevel(stop) <= lv) break;
      if (!visible(node)) continue;
      var t = blockText(fullText(node));
      if (t) { out.push(t); size += t.length; }
    }
    return out.join('\n');
  }

  // What a label-like element names: the rest of a table row (th), the dd after a dt, a heading's section.
  function pairedText(el, limit) {
    var tag = el.tagName;
    if (tag === 'TH' || (tag === 'TD' && el.nextElementSibling && el.parentElement && el.parentElement.tagName === 'TR' &&
        el.parentElement.firstElementChild === el)) {
      var cells = [], c = el.nextElementSibling;
      for (; c; c = c.nextElementSibling) cells.push(blockText(c.innerText));
      return cut(cells.join(' | '), limit);
    }
    if (tag === 'DT') {
      var dd = [], d = el.nextElementSibling;
      for (; d && d.tagName === 'DD'; d = d.nextElementSibling) dd.push(blockText(d.innerText));
      return cut(dd.join(' | '), limit);
    }
    if (el.matches && el.matches(HEAD_SEL)) return clip(sectionText(el), limit);
    if (/^(B|STRONG|LABEL|SPAN|DIV)$/.test(tag) && el.parentElement) {
      // "<b>Price:</b> £12": the rest of the line after the label.
      var whole = norm(fullText(el.parentElement)), own = norm(el.innerText);
      if (!own || own.length > 40 || (tag === 'LABEL' && el.control)) return '';
      if (whole.indexOf(own) === 0 && whole.length > own.length) return cut(whole.slice(own.length).replace(/^[\s:–-]+/, ''), limit);
      var sib = el.nextElementSibling;
      if (sib && !sib.matches(SEL)) return cut(norm(fullText(sib)), limit);
    }
    return '';
  }

  // A table header, term, heading or label whose own text is exactly the target, without a trailing colon.
  function labelCell(want) {
    var w = low(want).replace(/:$/, '');
    if (!w) return null;
    var hits = deepQueryAll('th,dt,' + HEAD_SEL + ',summary,legend,label,b,strong,dt *,th *').filter(function (x) {
      return !(x.tagName === 'LABEL' && x.control) && low(x.innerText || x.textContent).replace(/\s*:$/, '') === w && visible(x);
    });
    if (!hits.length) return null;
    var h = hits[0];
    // A link or span inside a th/dt names the cell itself.
    var up = h.closest && h.closest('th,dt');
    return up && low(up.innerText).replace(/\s*:$/, '') === w ? up : h;
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
    if (/^[#.][A-Za-z_-][\w-]*$/.test(spec) && deepQueryAll(spec).some(visible)) return true;
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
  function withTarget(target, fn, kind) {
    var r = resolve(target, kind);
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
    docStatus: docStatus,
    signin: signin,
    notFoundPage: notFoundPage,
    hits: hitsAt,
    cover: cover,
    found: function (t, kind) { return !resolve(t, kind || undefined, 0, true).error || !!reveal(t); },
    reveal: reveal,
    wall: wallOf,
    scroll: scroll,
    point: function (t) { return withTarget(t, point); },
    // Where a target is now, without scrolling it (the drop end of a drag).
    where: function (t) {
      return withTarget(t, function (el) {
        var r = (proxyOf(el) || el).getBoundingClientRect();
        var inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, what: describe(el), inView: inView };
      });
    },
    prepareType: function (t, clear) { return withTarget(t, function (el) { return prepareType(el, clear); }, 'type'); },
    finishType: function (t, text, clear) { return withTarget(t, function (el) { return finishType(el, text, clear); }, 'type'); },
    select: function (t, want) { return withTarget(t, function (el) { return selectOption(el, want); }, 'select'); },
    // After a click on a search button: the field to type in (one named like the target, or the one
    // that took the focus).
    fieldFor: function (t) {
      var r = resolve(t, 'type');
      var el = r.el ? (typeable(r.el) ? r.el : typeInside(r.el)) : null;
      if (!el) {
        var a = document.activeElement;
        try {
          while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
          while (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME') && a.contentDocument) a = a.contentDocument.activeElement;
        } catch (e) { /* a cross-origin frame has the focus */ }
        if (a && typeable(a) && visible(a)) el = a;
      }
      if (!el) return { error: describe(r.el) + ' is not a field, and clicking it opened none to type in' };
      return { ref: refOf(el), what: describe(el) };
    },
    state: function (t, kind) {
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
      }, kind);
    },
    jsClick: function (t) { return withTarget(t, function (el) { (proxyOf(el) || el).click(); return { what: describe(el) }; }); },
    // The one checkbox, radio or switch in the row of a target that is not one itself ("check milk" on a
    // to-do list ticks that item's box).
    toggleFor: function (t) {
      return withTarget(t, function (el) {
        if (checkedOf(el) !== null) return { what: describe(el) };
        var node = el;
        for (var i = 0; i < 5 && node && node !== document.body; i++) {
          var ts = Array.prototype.filter.call(
            node.querySelectorAll('input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio]'),
            function (x) { return visible(x) || !!proxyOf(x); });
          if (ts.length === 1) return { what: describe(ts[0]), ref: refOf(ts[0]), via: describe(el) };
          if (ts.length > 1) break;
          node = node.parentElement;
        }
        return { error: describe(el) + ' is not a checkbox, radio or switch, and no single one sits in its row' };
      });
    },
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
    // The page's one file input, for "upload Choose File = ..." (Chrome draws that button; the input is
    // usually named by its name attribute, or hidden behind a styled button).
    onlyFileInput: function () {
      var all = deepQueryAll('input[type=file]');
      var shown = all.filter(visible);  // libraries such as Dropzone add a hidden one of their own
      var pick = shown.length === 1 ? shown[0] : all.length === 1 ? all[0] : null;
      if (!pick) return { error: all.length + ' file inputs on the page' };
      return { ref: refOf(pick), what: describe(pick) };
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
