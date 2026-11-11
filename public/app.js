/* ニュースボード - 画面の動作 */
'use strict';

(() => {
  const PAGE = 60;                       // 一度に表示する記事数
  const NEWS_INTERVAL = 10 * 60 * 1000;  // ニュースの自動更新間隔
  const QUOTES_INTERVAL = 3 * 60 * 1000; // 指数の自動更新間隔
  const DEFAULT_WATCH = ['トヨタ', 'エヌビディア', '日銀'];

  const KW = window.NB_KEYWORDS || { themes: [], stocks: [] };

  // GitHub Pages 版: サーバーがないので、GitHub Actions が定期的に書き出した data/*.json を読む。
  // 検索・ウォッチリストは取得済みの記事の中から探す（?static を付けるとローカルでも試せる）
  const STATIC = location.hostname.endsWith('.github.io') || new URLSearchParams(location.search).has('static');

  // ================================================================ ユーティリティ
  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** 要素を安全に作る（文字列は必ず textContent として入る） */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    kids.forEach((k) => el.append(k));
    return el;
  }

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('nb:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('nb:' + key, JSON.stringify(value)); } catch { /* 保存できなくても動作は続ける */ }
    },
  };

  function safeUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function parseDate(str) {
    if (!str) return NaN;
    let t = Date.parse(str);
    if (Number.isNaN(t)) t = Date.parse(str.replace(/\bJST\b/, '+0900'));
    if (Number.isNaN(t)) {
      const m = str.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
      if (m) t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    }
    return t;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${d.getHours()}:${pad2(d.getMinutes())}`;
  function shortStamp(d) {
    const now = new Date();
    return d.toDateString() === now.toDateString() ? hhmm(d) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
  }
  function fullStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(d)}`;
  }
  function relTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const sec = Math.max(0, (now - ts) / 1000);
    if (sec < 60) return 'たった今';
    if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
    const d = new Date(ts);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `昨日 ${hhmm(d)}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
  }
  function timeEl(ts) {
    if (!ts) return null;
    return h('time', { datetime: new Date(ts).toISOString(), title: fullStamp(ts), 'data-ts': ts, text: relTime(ts) });
  }

  const norm = (s) => String(s || '').normalize('NFKC');
  /** 「Investing.com - FX | 株式市場 | …」のような長い媒体名を先頭部分だけにする */
  function shortSource(s) {
    const t = norm(s).trim();
    return t.split(/\s+[|｜\-–—:：]\s+/)[0] || t;
  }
  /** 重複判定用のキー。末尾の「（ロイター）」「(時事)」のような出典表記や記号の違いは無視する */
  function titleKey(t) {
    return norm(t).toLowerCase()
      .replace(/\s*\([^()]{1,15}\)\s*$/, '')
      .replace(/[\s「」『』【】〈〉《》（）()[\]、。,.!?！？・:：;；\-‐–—―~〜'"“”‘’…|｜/]/g, '')
      .slice(0, 80);
  }
  const fmtNum = (n, digits) => Number(n).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  function signed(n, digits) {
    const v = Number(Number(n).toFixed(digits));
    if (v === 0) return fmtNum(0, digits);
    return (v > 0 ? '+' : '−') + fmtNum(Math.abs(v), digits);
  }
  const translateUrl = (u) => 'https://translate.google.com/translate?sl=auto&tl=ja&u=' + encodeURIComponent(u);
  const external = { target: '_blank', rel: 'noopener noreferrer' };

  // ================================================================ 株関連キーワード
  function compile(def) {
    const res = [];
    const add = (src, flags) => {
      try { res.push(new RegExp(src, flags)); } catch (e) { console.warn('キーワード定義の正規表現エラー:', src, e); }
    };
    if (def.ja) add(def.ja, '');
    if (def.en) add('\\b(?:' + def.en + ')\\b', 'i');
    if (def.acr) add('\\b(?:' + def.acr + ')\\b', '');
    return (text) => res.some((r) => r.test(text));
  }
  const THEMES = (KW.themes || []).map((t) => Object.assign({}, t, { weight: t.weight || 1, test: compile(t) }));
  const STOCKS = (KW.stocks || []).map((s) => Object.assign({}, s, {
    short: s.short || s.name,
    jp: /^\d{3}[0-9A-Z]$/.test(s.code),
    test: compile(s),
  }));
  const quoteUrl = (s) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(s.code)}${s.jp ? '.T' : ''}`;

  // ================================================================ 状態
  const savedView = store.get('view', null);
  const state = {
    categories: [],
    byCat: new Map(),
    unique: [],
    errors: [],
    newsAt: 0,
    newsError: '',
    loading: true,
    quotes: [],
    quotesAt: 0,
    quotesError: '',
    view: savedView && (savedView.type === 'category' || savedView.type === 'watch') ? savedView : { type: 'category', id: 'top' },
    lastTab: { type: 'category', id: 'top' },
    f: {
      q: '',
      stockOnly: store.get('stockOnly', false),
      showEnglish: store.get('showEnglish', true),
      compact: store.get('compact', false),
      feed: '',
    },
    limit: PAGE,
    watch: store.get('watch', null) || DEFAULT_WATCH.slice(),
    watchSel: '',
    watchData: { key: null, at: 0, items: [], errors: [], loading: false, error: '' },
    search: { q: '', items: [], errors: [], loading: false, error: '' },
    renderedKeys: new Set(),
  };
  if (state.view.type === 'category' || state.view.type === 'watch') state.lastTab = state.view;

  // ================================================================ データ整形
  function enrich(raw) {
    const it = Object.assign({}, raw);
    it.link = safeUrl(raw.link);
    it.image = raw.image ? safeUrl(raw.image) : null;
    const now = Date.now();
    let ts = parseDate(raw.date);
    if (!Number.isFinite(ts)) ts = 0;
    else if (ts > now + 5 * 60 * 1000) ts = now;
    it.ts = ts;
    const text = norm(raw.title + ' ' + (raw.summary || ''));
    it.themes = THEMES.filter((t) => t.test(text));
    it.stocks = STOCKS.filter((s) => s.test(text));
    it.score = it.themes.reduce((a, t) => a + t.weight, 0) + it.stocks.length * 2;
    it.isStock = it.score >= 2;
    it.key = titleKey(raw.title) || it.link;
    it.source = shortSource(raw.source || raw.feed);
    it.hay = (text + ' ' + it.source).toLowerCase();
    return it;
  }
  const byDate = (a, b) => b.ts - a.ts;

  /** 同じ見出し・同じURLの記事を1件にまとめる（新しい順のリストを渡す） */
  function dedup(list) {
    const seen = new Map();
    const out = [];
    for (const it of list) {
      const prev = seen.get(it.key) || seen.get(it.link);
      if (prev) {
        if (!prev.summary && it.summary) prev.summary = it.summary;
        if (!prev.image && it.image) prev.image = it.image;
        if (it.query && prev.queries && !prev.queries.includes(it.query)) prev.queries.push(it.query);
        continue;
      }
      if (it.query) it.queries = [it.query];
      seen.set(it.key, it);
      seen.set(it.link, it);
      out.push(it);
    }
    return out;
  }

  // ================================================================ 通信
  async function getJson(url) {
    if (STATIC) {
      const name = url.match(/^\/api\/(\w+)/)[1];
      url = `data/${name}.json?t=${Math.floor(Date.now() / 60000)}`;
    }
    const res = await fetch(url, { cache: 'no-store' });
    let data = {};
    try { data = await res.json(); } catch { /* 空のまま */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let loadingCount = 0;
  function setLoading(delta) {
    loadingCount = Math.max(0, loadingCount + delta);
    state.loading = loadingCount > 0;
    document.body.classList.toggle('is-loading', state.loading);
    $('refresh').disabled = state.loading;
  }

  async function loadNews({ force = false, auto = false } = {}) {
    setLoading(+1);
    let ok = false;
    try {
      const data = await getJson('/api/news' + (force ? '?force=1' : ''));
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      state.errors = data.errors || [];
      state.newsAt = Date.parse(data.fetchedAt) || Date.now();
      const all = (data.items || []).map(enrich).filter((i) => i.link && i.title).sort(byDate);
      const byCat = new Map(state.categories.map((c) => [c.id, []]));
      for (const it of all) {
        if (!byCat.has(it.category)) byCat.set(it.category, []);
        byCat.get(it.category).push(it);
      }
      for (const [k, v] of byCat) byCat.set(k, dedup(v));
      state.byCat = byCat;
      state.unique = dedup(all);
      state.newsError = '';
      if (state.view.type === 'category' && !byCat.has(state.view.id) && state.categories.length) {
        state.view = { type: 'category', id: state.categories[0].id };
        state.lastTab = state.view;
      }
      ok = true;
    } catch (e) {
      state.newsError = STATIC
        ? `ニュースを取得できませんでした（${e.message}）。通信状態を確認して、しばらくしてから「更新」を押してください。`
        : `ニュースを取得できませんでした（${e.message}）。start.bat の黒いウィンドウが開いているか確認してください。`;
    } finally {
      setLoading(-1);
    }

    // GitHub Pages 版の検索・ウォッチリストは取得済みの記事から探すので、記事が変わったら探し直す
    if (STATIC && ok) {
      if (state.view.type === 'watch') loadWatch({ force: true });
      else if (state.view.type === 'search' && state.search.q) runSearch(state.search.q, { history: 'none' });
    }

    // 自動更新で、読んでいる途中（下までスクロール中）なら一覧を差し替えず「新着」ボタンを出す
    if (ok && auto && window.scrollY > 400 && ['category', 'theme', 'stock'].includes(state.view.type)) {
      const fresh = filterList(currentList()).slice(0, PAGE).filter((i) => !state.renderedKeys.has(i.key)).length;
      renderStatus(); renderTabs(); renderSide();
      if (fresh > 0) {
        const pill = $('newPill');
        pill.textContent = `新着 ${fresh}件を表示`;
        pill.hidden = false;
      }
      return;
    }
    renderAll();
  }

  async function loadQuotes({ force = false } = {}) {
    try {
      const data = await getJson('/api/quotes' + (force ? '?force=1' : ''));
      state.quotes = data.quotes || [];
      state.quotesAt = Date.parse(data.fetchedAt) || Date.now();
      state.quotesError = '';
    } catch (e) {
      state.quotesError = `指数を取得できませんでした（${e.message}）`;
    }
    renderTiles();
  }

  /** GitHub Pages 版: 取得済みの記事から、語句（空白区切りはすべて含む）に合う記事を探す */
  function searchLocal(queries, tagQuery) {
    const out = [];
    for (const q of queries) {
      const terms = norm(q).toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) continue;
      for (const it of state.unique) {
        if (terms.every((t) => it.hay.includes(t))) out.push(tagQuery ? Object.assign({}, it, { query: q }) : it);
      }
    }
    return dedup(out.sort(byDate));
  }
  const googleNewsUrl = (q) => 'https://news.google.com/search?q=' + encodeURIComponent(q) + '&hl=ja&gl=JP&ceid=JP:ja';

  let watchToken = 0;
  async function loadWatch({ force = false } = {}) {
    const wd = state.watchData;
    const key = state.watch.join('\n');
    if (!state.watch.length) {
      Object.assign(wd, { key, items: [], errors: [], loading: false, error: '' });
      if (state.view.type === 'watch') renderMain();
      return;
    }
    if (!force && wd.key === key && Date.now() - wd.at < 5 * 60 * 1000) return;
    if (STATIC) {
      ++watchToken;
      Object.assign(wd, { key, at: Date.now(), items: searchLocal(state.watch, true), errors: [], loading: false, error: '' });
      if (!state.watch.includes(state.watchSel)) state.watchSel = '';
      if (state.view.type === 'watch') renderMain();
      return;
    }
    const token = ++watchToken;
    wd.loading = true;
    wd.error = '';
    if (state.view.type === 'watch') renderMain();
    try {
      const params = new URLSearchParams();
      state.watch.forEach((w) => params.append('q', w));
      if (force) params.set('force', '1');
      const data = await getJson('/api/search?' + params.toString());
      if (token !== watchToken) return;
      wd.items = dedup((data.items || []).map(enrich).filter((i) => i.link).sort(byDate));
      wd.errors = data.errors || [];
      wd.key = key;
      wd.at = Date.now();
    } catch (e) {
      if (token === watchToken) wd.error = `ウォッチリストの記事を取得できませんでした（${e.message}）`;
    } finally {
      if (token === watchToken) {
        wd.loading = false;
        if (!state.watch.includes(state.watchSel)) state.watchSel = '';
        if (state.view.type === 'watch') renderMain();
      }
    }
  }

  let searchToken = 0;
  async function runSearch(q, { force = false, history: hist = 'push' } = {}) {
    q = q.trim();
    if (!q) return;
    const token = ++searchToken;
    state.search = { q, items: [], errors: [], loading: true, error: '' };
    if (STATIC) {
      state.search.items = searchLocal([q], false);
      state.search.loading = state.loading && !state.unique.length;
      setView({ type: 'search', q }, { history: hist });
      return;
    }
    setView({ type: 'search', q }, { history: hist });
    try {
      const params = new URLSearchParams({ q });
      if (force) params.set('force', '1');
      const data = await getJson('/api/search?' + params.toString());
      if (token !== searchToken) return;
      // 検索結果にはウォッチリスト用の「★キーワード」表示は不要なので query を外す
      const items = (data.items || []).map(enrich).filter((i) => i.link).map((i) => { delete i.query; return i; });
      state.search.items = dedup(items.sort(byDate));
      state.search.errors = data.errors || [];
    } catch (e) {
      if (token === searchToken) state.search.error = `検索できませんでした（${e.message}）`;
    } finally {
      if (token === searchToken) {
        state.search.loading = false;
        if (state.view.type === 'search') renderMain();
      }
    }
  }

  function refreshAll() {
    loadNews({ force: true });
    loadQuotes({ force: true });
    if (state.view.type === 'watch') loadWatch({ force: true });
    if (state.view.type === 'search' && state.search.q) runSearch(state.search.q, { force: true, history: 'none' });
  }

  // ================================================================ 表示対象
  function currentList() {
    const v = state.view;
    switch (v.type) {
      case 'category': return state.byCat.get(v.id) || [];
      case 'watch': {
        const items = state.watchData.items;
        return state.watchSel ? items.filter((i) => i.queries && i.queries.includes(state.watchSel)) : items;
      }
      case 'search': return state.search.items;
      case 'theme': return state.unique.filter((i) => i.themes.some((t) => t.id === v.id));
      case 'stock': return state.unique.filter((i) => i.stocks.some((s) => s.code === v.id));
      default: return [];
    }
  }

  function filterList(list, ignoreFeed = false) {
    const f = state.f;
    const terms = norm(f.q).toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((i) =>
      (f.showEnglish || i.lang !== 'en') &&
      (!f.stockOnly || i.isStock) &&
      (ignoreFeed || !f.feed || i.feed === f.feed) &&
      terms.every((t) => i.hay.includes(t)));
  }

  const catLabel = (id) => (state.categories.find((c) => c.id === id) || {}).label || '';

  // ---- URL（#market, #theme=fx, #stock=7203, #q=トヨタ）と表示を対応させる
  function viewToHash(v) {
    switch (v.type) {
      case 'category': return '#' + encodeURIComponent(v.id);
      case 'watch': return '#watch';
      case 'theme': return '#theme=' + encodeURIComponent(v.id);
      case 'stock': return '#stock=' + encodeURIComponent(v.id);
      case 'search': return '#q=' + encodeURIComponent(v.q);
      default: return '';
    }
  }
  function hashToView(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    const eq = raw.indexOf('=');
    const key = eq < 0 ? raw : raw.slice(0, eq);
    let val = '';
    try { val = eq < 0 ? '' : decodeURIComponent(raw.slice(eq + 1)); } catch { return null; }
    if (key === 'watch') return { type: 'watch' };
    if (key === 'theme' && val) return { type: 'theme', id: val };
    if (key === 'stock' && val) return { type: 'stock', id: val };
    if (key === 'q' && val.trim()) return { type: 'search', q: val.trim() };
    if (eq < 0 && /^[\w-]+$/.test(key)) return { type: 'category', id: key };
    return null;
  }

  /**
   * 表示を切り替える。
   * history: 'push' = テーマ・銘柄・検索は履歴に積む（ブラウザの「戻る」で戻れる） / 'none' = URLを変えない
   */
  function setView(view, { scroll = true, history: hist = 'push' } = {}) {
    state.view = view;
    if (view.type === 'category' || view.type === 'watch') {
      state.lastTab = view;
      store.set('view', view);
    }
    state.limit = PAGE;
    state.f.feed = '';
    if (hist !== 'none') {
      const hash = viewToHash(view);
      if (hash && location.hash !== hash) {
        const drill = view.type === 'theme' || view.type === 'stock' || view.type === 'search';
        if (hist === 'push' && drill) history.pushState(null, '', hash);
        else history.replaceState(null, '', hash);
      }
    }
    if (view.type === 'watch') loadWatch();
    renderTabs();
    renderMain();
    renderSide();
    if (scroll) scrollToList();
  }

  function onLocationChange() {
    const v = hashToView(location.hash) || state.lastTab;
    if (viewToHash(v) === viewToHash(state.view)) return;
    if (v.type === 'search') runSearch(v.q, { history: 'none' });
    else setView(v, { history: 'none' });
  }

  function scrollToList() {
    const nav = document.querySelector('.nav');
    const top = document.querySelector('.filters').getBoundingClientRect().top + window.scrollY - nav.offsetHeight;
    if (window.scrollY > top) window.scrollTo({ top });
  }

  // ================================================================ ウォッチリスト操作
  function isWatched(term) {
    const t = term.toLowerCase();
    return state.watch.some((w) => w.toLowerCase() === t);
  }
  function addWatch(term) {
    term = String(term || '').trim().slice(0, 40);
    if (!term || isWatched(term)) return false;
    if (state.watch.length >= 20) {
      window.alert('ウォッチリストに登録できるのは20件までです。');
      return false;
    }
    state.watch.push(term);
    store.set('watch', state.watch);
    if (state.view.type === 'watch') loadWatch();
    return true;
  }
  function removeWatch(term) {
    state.watch = state.watch.filter((w) => w !== term);
    store.set('watch', state.watch);
    if (state.watchSel === term) state.watchSel = '';
    const wd = state.watchData;
    wd.items = wd.items.filter((i) => {
      i.queries = (i.queries || []).filter((q) => q !== term);
      return i.queries.length > 0;
    });
    wd.key = state.watch.join('\n');
  }
  function toggleWatch(term) {
    if (isWatched(term)) removeWatch(state.watch.find((w) => w.toLowerCase() === term.toLowerCase()));
    else addWatch(term);
    renderMain();
    renderSide();
  }

  // ================================================================ 描画: 共通パーツ
  function themeTag(t) {
    return h('button', {
      type: 'button', class: 'tag', title: `テーマ「${t.label}」の記事をまとめて表示`,
      onclick: () => setView({ type: 'theme', id: t.id }),
    }, '#' + t.label);
  }
  function stockTag(s) {
    return h('a', Object.assign({
      class: 'tag tag-stock', href: quoteUrl(s),
      title: `${s.name}（${s.code}）の株価を Yahoo!ファイナンスで見る`,
    }, external), s.short, s.short !== s.code ? h('span', { class: 'code', text: s.code }) : null);
  }

  function renderItem(it, showCategory) {
    const meta = h('div', { class: 'meta' },
      h('span', { class: 'source', text: it.source || it.feed }),
      timeEl(it.ts),
      showCategory && catLabel(it.category) ? h('span', { class: 'cat', text: catLabel(it.category) }) : null,
      it.lang === 'en' ? h('span', { class: 'badge', title: '英語の記事', text: 'EN' }) : null,
      it.isStock ? h('span', { class: 'badge badge-stock', title: '株価に関係しそうな記事（自動判定）', text: '株関連' }) : null);

    const tags = [];
    for (const q of it.queries || []) tags.push(h('span', { class: 'tag tag-watch', title: 'ウォッチリストのキーワード', text: '★ ' + q }));
    for (const t of it.themes) tags.push(themeTag(t));
    for (const s of it.stocks.slice(0, 5)) tags.push(stockTag(s));
    if (it.lang === 'en') {
      tags.push(h('a', Object.assign({ class: 'tag tag-link', href: translateUrl(it.link), title: 'Google翻訳で日本語にして開く' }, external), '日本語で読む ↗'));
    }

    const body = h('div', { class: 'article-body' },
      meta,
      h('h3', { class: 'title' }, h('a', Object.assign({ href: it.link, text: it.title }, external))),
      it.summary ? h('p', { class: 'summary', text: it.summary }) : null,
      tags.length ? h('div', { class: 'tags' }, tags) : null);

    let thumb = null;
    if (it.image) {
      thumb = h('img', { class: 'thumb', src: it.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      thumb.addEventListener('error', () => thumb.remove(), { once: true });
    }
    return h('li', { class: 'article' + (it.isStock ? ' is-stock' : '') }, body, thumb);
  }

  // ================================================================ 描画: 各領域
  function renderAll() {
    renderStatus();
    renderTabs();
    renderMain();
    renderSide();
  }

  function renderStatus() {
    const el = $('updated');
    if (!state.newsAt) { el.textContent = ''; return; }
    const stamp = shortStamp(new Date(state.newsAt));
    el.textContent = state.newsError ? `更新できませんでした（${stamp} 時点の情報）` : `${stamp} 更新`;
  }

  function renderTabs() {
    const tabs = state.categories.map((c) => ({
      view: { type: 'category', id: c.id },
      label: c.label,
      count: state.unique.length ? filterList(state.byCat.get(c.id) || [], true).length : null,
    }));
    tabs.push({ view: { type: 'watch' }, label: '★ ウォッチリスト', count: null });
    const v = state.view;
    $('tabs').replaceChildren(...tabs.map((t, idx) => {
      const active = t.view.type === v.type && (t.view.type === 'watch' || t.view.id === v.id);
      return h('button', {
        type: 'button', role: 'tab', class: 'tab' + (active ? ' is-active' : ''),
        'aria-selected': String(active), 'aria-controls': 'list', 'data-key': idx + 1,
        title: `${t.label}（${idx + 1} キー）`,
        onclick: () => setView(t.view),
      }, t.label, t.count != null ? h('span', { class: 'tab-count', text: String(t.count) }) : null);
    }));
  }

  function renderBanner() {
    const v = state.view;
    const box = $('banner');
    if (!['theme', 'stock', 'search'].includes(v.type)) { box.hidden = true; box.replaceChildren(); return; }
    let title = '';
    let sub = '';
    const extra = [];
    const watchBtn = (term) => {
      const on = isWatched(term);
      return h('button', {
        type: 'button', class: 'btn btn-small', 'aria-pressed': String(on),
        onclick: () => toggleWatch(term),
      }, on ? '★ ウォッチ中' : '☆ ウォッチに追加');
    };
    if (v.type === 'theme') {
      const t = THEMES.find((x) => x.id === v.id);
      title = `テーマ「${t ? t.label : v.id}」の記事`;
      sub = '全カテゴリのニュースから自動で抽出しています';
    } else if (v.type === 'stock') {
      const s = STOCKS.find((x) => x.code === v.id);
      title = `「${s ? s.short : v.id}」が登場する記事`;
      sub = s ? `${s.name}（${s.code}）` : '';
      if (s) {
        extra.push(h('a', Object.assign({ class: 'btn btn-small', href: quoteUrl(s) }, external), '株価を見る ↗'));
        extra.push(watchBtn(s.short));
      }
    } else {
      title = `「${v.q}」の検索結果`;
      sub = STATIC ? '取得済みのニュース（直近1〜2日）から検索しています' : 'Googleニュースの直近7日の記事';
      if (STATIC) extra.push(h('a', Object.assign({ class: 'btn btn-small', href: googleNewsUrl(v.q) }, external), 'Googleニュースで探す ↗'));
      extra.push(watchBtn(v.q));
    }
    box.hidden = false;
    box.replaceChildren(
      h('div', null, h('div', { class: 'banner-title', text: title }), sub ? h('div', { class: 'banner-sub', text: sub }) : null),
      h('span', { class: 'spacer' }),
      ...extra,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => setView(state.lastTab) }, '× 閉じる'));
  }

  function renderWatchPanel() {
    const on = state.view.type === 'watch';
    $('watchPanel').hidden = !on;
    if (!on) return;
    const wd = state.watchData;
    const counts = new Map();
    for (const it of wd.items) for (const q of it.queries || []) counts.set(q, (counts.get(q) || 0) + 1);
    const chip = (label, value, count, removable) => {
      const active = state.watchSel === value;
      return h('span', { class: 'chip' + (active ? ' is-active' : '') + (removable ? ' removable' : '') },
        h('button', {
          type: 'button', class: 'chip-main', 'aria-pressed': String(active),
          onclick: () => { state.watchSel = value; state.limit = PAGE; renderMain(); },
        }, label, count != null && !wd.loading ? h('span', { class: 'chip-count', text: String(count) }) : null),
        removable ? h('button', {
          type: 'button', class: 'chip-x', title: '削除', 'aria-label': `${label} をウォッチリストから削除`,
          onclick: () => { removeWatch(value); renderMain(); renderSide(); },
        }, '×') : null);
    };
    $('watchChips').replaceChildren(
      chip('すべて', '', wd.items.length, false),
      ...state.watch.map((w) => chip(w, w, counts.get(w) || 0, true)));
  }

  function renderFeedSelect(base) {
    const sel = $('feedFilter');
    const counts = new Map();
    for (const i of filterList(base, true)) counts.set(i.feed, (counts.get(i.feed) || 0) + 1);
    const feeds = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (state.f.feed && !counts.has(state.f.feed)) state.f.feed = '';
    sel.replaceChildren(
      h('option', { value: '' }, `すべての配信元（${feeds.length}）`),
      ...feeds.map(([f, n]) => h('option', { value: f }, `${f}（${n}）`)));
    sel.value = state.f.feed;
    sel.closest('.select').hidden = feeds.length <= 1;
  }

  function renderFeedErrors() {
    const v = state.view;
    const errs = v.type === 'watch' ? state.watchData.errors : v.type === 'search' ? state.search.errors : state.errors;
    const box = $('feedErrors');
    if (!errs || !errs.length) { box.replaceChildren(); return; }
    box.replaceChildren(h('details', { class: 'errs' },
      h('summary', null, `一部の配信元を取得できませんでした（${errs.length}件）`),
      h('ul', null, ...errs.map((e) => h('li', { text: `${e.feed}: ${e.error}` })))));
  }

  function renderMain() {
    document.body.classList.toggle('compact', state.f.compact);
    $('newPill').hidden = true;
    renderWatchPanel();
    renderBanner();

    const v = state.view;
    const base = currentList();
    renderFeedSelect(base);
    const items = filterList(base);
    const shown = items.slice(0, state.limit);
    const showCategory = v.type === 'theme' || v.type === 'stock';
    $('list').replaceChildren(...shown.map((it) => renderItem(it, showCategory)));
    state.renderedKeys = new Set(shown.map((i) => i.key));

    $('count').textContent = items.length
      ? `${items.length}件の記事` + (items.length > shown.length ? `（${shown.length}件を表示中）` : '')
      : '';
    $('more').hidden = items.length <= shown.length;
    renderEmpty(base, items);
    renderFeedErrors();
  }

  function renderEmpty(base, items) {
    const box = $('empty');
    if (items.length) { box.hidden = true; box.replaceChildren(); return; }
    const v = state.view;
    let msg = '';
    let action = null;
    const loading = (v.type === 'watch' && state.watchData.loading) ||
      (v.type === 'search' && state.search.loading) ||
      (state.loading && !state.unique.length && v.type !== 'watch' && v.type !== 'search');
    if (loading) msg = '読み込み中…';
    else if (v.type === 'watch' && state.watchData.error) msg = state.watchData.error;
    else if (v.type === 'search' && state.search.error) msg = state.search.error;
    else if (v.type !== 'watch' && v.type !== 'search' && state.newsError) msg = state.newsError;
    else if (v.type === 'watch' && !state.watch.length) msg = '上の入力欄から、追いかけたい企業名やキーワードを追加してください。';
    else if (base.length) {
      msg = '条件に合う記事がありません。';
      action = h('button', { type: 'button', class: 'btn', onclick: clearFilters }, '絞り込みを解除');
    } else msg = '記事がありません。';
    box.hidden = false;
    box.replaceChildren(h('p', { text: msg }), action);
  }

  function clearFilters() {
    state.f.q = '';
    $('q').value = '';
    state.f.stockOnly = false;
    $('stockOnly').checked = false;
    store.set('stockOnly', false);
    state.f.feed = '';
    state.limit = PAGE;
    renderAll();
  }

  // ---------------------------------------------------------------- サイドバー
  function sideItems(hours) {
    const now = Date.now();
    return state.unique.filter((i) => i.ts && now - i.ts < hours * 3600 * 1000 && (state.f.showEnglish || i.lang !== 'en'));
  }
  const sideEmpty = (text) => h('li', { class: 'side-empty', text });

  function renderSide() {
    renderPickup();
    renderThemeRank();
    renderStockRank();
  }

  function renderPickup() {
    const box = $('pickup');
    if (!state.unique.length) { box.replaceChildren(sideEmpty(state.loading ? '読み込み中…' : '記事がありません')); return; }
    const now = Date.now();
    const picks = sideItems(36)
      .filter((i) => i.isStock)
      .map((i) => ({ i, s: i.score * Math.pow(0.5, (now - i.ts) / (12 * 3600 * 1000)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.i);
    if (!picks.length) { box.replaceChildren(sideEmpty('該当する記事はまだありません')); return; }
    box.replaceChildren(...picks.map((it) => h('li', null,
      h('a', Object.assign({ class: 'pick-title', href: it.link, text: it.title }, external)),
      h('div', { class: 'pick-meta' }, `${it.source} · `, timeEl(it.ts)),
      h('div', { class: 'tags' }, ...it.themes.slice(0, 2).map(themeTag), ...it.stocks.slice(0, 3).map(stockTag)))));
  }

  function rankRow({ label, code, n, max, active, title, onclick }) {
    const bar = h('span', { class: 'rank-bar' });
    bar.style.width = `calc((100% - 2.8em) * ${(n / max).toFixed(4)})`;
    return h('button', {
      type: 'button', class: 'rank-row' + (active ? ' is-active' : ''),
      'aria-pressed': String(Boolean(active)), title, onclick,
    },
    h('span', { class: 'rank-label' }, label, code ? h('span', { class: 'rank-code', text: code }) : null),
    h('span', { class: 'rank-track', 'aria-hidden': 'true' }, bar, h('span', { class: 'rank-value', text: String(n) })),
    h('span', { class: 'visually-hidden', text: `${n}件` }));
  }

  function renderThemeRank() {
    const box = $('themes');
    if (!state.unique.length) { box.replaceChildren(sideEmpty(state.loading ? '読み込み中…' : '—')); return; }
    const items = sideItems(24);
    const rows = THEMES
      .map((t) => ({ t, n: items.reduce((a, i) => a + (i.themes.includes(t) ? 1 : 0), 0) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    if (!rows.length) { box.replaceChildren(sideEmpty('該当する記事はまだありません')); return; }
    const max = rows[0].n;
    box.replaceChildren(...rows.map(({ t, n }) => h('li', null, rankRow({
      label: t.label, n, max,
      active: state.view.type === 'theme' && state.view.id === t.id,
      title: `${t.label}: ${n}件（クリックで記事を表示）`,
      onclick: () => setView({ type: 'theme', id: t.id }),
    }))));
  }

  function renderStockRank() {
    const box = $('stocks');
    if (!state.unique.length) { box.replaceChildren(sideEmpty(state.loading ? '読み込み中…' : '—')); return; }
    const counts = new Map();
    for (const i of sideItems(48)) for (const s of i.stocks) counts.set(s, (counts.get(s) || 0) + 1);
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!rows.length) { box.replaceChildren(sideEmpty('該当する記事はまだありません')); return; }
    const max = rows[0][1];
    box.replaceChildren(...rows.map(([s, n]) => {
      const on = isWatched(s.short);
      return h('li', null,
        rankRow({
          label: s.short, code: s.short !== s.code ? s.code : '', n, max,
          active: state.view.type === 'stock' && state.view.id === s.code,
          title: `${s.name}（${s.code}）: ${n}件（クリックで記事を表示）`,
          onclick: () => setView({ type: 'stock', id: s.code }),
        }),
        h('a', Object.assign({
          class: 'rank-act', href: quoteUrl(s),
          title: 'Yahoo!ファイナンスで株価を見る', 'aria-label': `${s.short}の株価を見る`,
        }, external), '↗'),
        h('button', {
          type: 'button', class: 'rank-act' + (on ? ' is-on' : ''), 'aria-pressed': String(on),
          title: on ? 'ウォッチリストから外す' : 'ウォッチリストに追加',
          'aria-label': on ? `${s.short}をウォッチリストから外す` : `${s.short}をウォッチリストに追加`,
          onclick: () => toggleWatch(s.short),
        }, on ? '★' : '☆'));
    }));
  }

  // ---------------------------------------------------------------- マーケット指標
  const tip = $('tooltip');
  function showTip(anchorX, anchorTop, anchorBottom, strong, sub) {
    tip.replaceChildren(h('strong', { text: strong }), h('span', { text: sub }));
    tip.hidden = false;
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    const left = Math.min(Math.max(anchorX - w / 2, 6), window.innerWidth - w - 6);
    let top = anchorTop - ht - 8;
    if (top < 6) top = anchorBottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  function renderTiles() {
    const box = $('tiles');
    const note = $('marketsNote');
    if (!state.quotes.length) {
      box.replaceChildren();
      note.textContent = state.quotesError || '指数を読み込み中…';
      return;
    }
    box.replaceChildren(...state.quotes.map(tile));
    note.textContent = '前日終値との比較。折れ線は直近の取引日の値動き（15分足）、横線は前日終値です。'
      + 'データ: Yahoo Finance（遅延あり・参考値）'
      + (state.quotesAt ? ` · ${hhmm(new Date(state.quotesAt))} 取得` : '')
      + (state.quotesError ? ` · ${state.quotesError}` : '');
  }

  function tile(q) {
    const label = h('span', { class: 'tile-label', text: q.label || q.symbol });
    if (!q.ok || !Number.isFinite(q.price) || !Number.isFinite(q.prevClose)) {
      return h('div', { class: 'tile is-missing', role: 'group', 'aria-label': `${q.label}: 取得できませんでした` },
        h('div', { class: 'tile-head' }, label),
        h('div', { class: 'tile-value', text: '—' }),
        h('div', { class: 'tile-delta', text: '取得できませんでした' }));
    }
    const digits = Number.isInteger(q.digits) ? q.digits : 2;
    const unit = q.unit || '';
    const change = q.price - q.prevClose;
    const pct = q.prevClose ? (change / q.prevClose) * 100 : 0;
    const dir = Number(change.toFixed(digits)) === 0 ? 0 : change > 0 ? 1 : -1;
    // 色は「上昇が良いことか」で決める（為替・金利・原油は良し悪しが決まらないので中立色）
    const tone = dir === 0 || q.upIsGood == null ? 'neutral' : (dir > 0) === Boolean(q.upIsGood) ? 'good' : 'bad';
    const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '―';
    const showPct = q.showPct !== false;
    const parts = [h('span', { text: `${arrow} ${signed(change, digits)}` })];
    if (showPct) parts.push(h('span', { text: `(${signed(pct, 2)}%)` }));
    if (q.fxJpy && dir) parts.push(h('span', { text: dir > 0 ? '円安' : '円高' }));

    const stamp = q.time ? shortStamp(new Date(q.time * 1000)) : '';
    const aria = `${q.label} ${fmtNum(q.price, digits)}${unit}、前日比 ${signed(change, digits)}`
      + (showPct ? `（${signed(pct, 2)}%）` : '') + (stamp ? `、${stamp} 時点` : '');
    return h('div', { class: 'tile', role: 'group', 'aria-label': aria },
      h('div', { class: 'tile-head' }, label, stamp ? h('span', { class: 'tile-time', text: stamp }) : null),
      h('div', { class: 'tile-value' }, fmtNum(q.price, digits), unit ? h('span', { class: 'tile-unit', text: unit }) : null),
      h('div', { class: 'tile-delta ' + tone }, ...parts),
      sparkline(q, digits, unit));
  }

  function sparkline(q, digits, unit) {
    const ts = q.timestamps || [];
    const vs = q.points || [];
    const pts = [];
    for (let i = 0; i < ts.length; i++) {
      const v = vs[i];
      if (v != null && Number.isFinite(+v) && Number.isFinite(+ts[i])) pts.push([+ts[i], +v]);
    }
    if (pts.length < 2) return h('div', { class: 'spark', 'aria-hidden': 'true' });

    let x0 = pts[0][0];
    let x1 = pts[pts.length - 1][0];
    // 取引時間中なら、取引時間全体を横軸にする（どこまで進んだかが分かる）
    if (Number.isFinite(q.periodStart) && Number.isFinite(q.periodEnd) && q.periodStart <= x0 && x1 <= q.periodEnd + 900) {
      x0 = q.periodStart;
      x1 = Math.max(q.periodEnd, x1);
    }
    const values = pts.map((p) => p[1]);
    let lo = Math.min(q.prevClose, ...values);
    let hi = Math.max(q.prevClose, ...values);
    const padY = (hi - lo) * 0.12 || Math.abs(hi) * 0.001 || 1;
    lo -= padY;
    hi += padY;
    const X = (t) => ((t - x0) / (x1 - x0 || 1)) * 100;
    const Y = (v) => (1 - (v - lo) / (hi - lo)) * 100;

    const refY = Y(q.prevClose).toFixed(2);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)}`).join('');
    const chart = svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
      svg('line', { class: 'ref', x1: 0, x2: 100, y1: refY, y2: refY }),
      svg('path', { class: 'line', d: path }));

    const last = pts[pts.length - 1];
    const dot = h('span', { class: 'spark-dot' });
    dot.style.left = `${X(last[0])}%`;
    dot.style.top = `${Y(last[1])}%`;
    const cross = h('span', { class: 'spark-cross', hidden: true });
    const mark = h('span', { class: 'spark-mark', hidden: true });
    const box = h('div', { class: 'spark' }, chart, cross, mark, dot);

    box.addEventListener('pointermove', (e) => {
      const r = box.getBoundingClientRect();
      const xp = ((e.clientX - r.left) / r.width) * 100;
      let best = pts[0];
      let bestD = Infinity;
      for (const p of pts) {
        const d = Math.abs(X(p[0]) - xp);
        if (d < bestD) { bestD = d; best = p; }
      }
      const px = X(best[0]);
      cross.hidden = false;
      cross.style.left = `${px}%`;
      mark.hidden = best === last;
      mark.style.left = `${px}%`;
      mark.style.top = `${Y(best[1])}%`;
      const tileRect = box.closest('.tile').getBoundingClientRect();
      showTip(r.left + (px / 100) * r.width, tileRect.top, tileRect.bottom,
        fmtNum(best[1], digits) + unit,
        shortStamp(new Date(best[0] * 1000)) + (best === last ? '（最新）' : ''));
    });
    box.addEventListener('pointerleave', () => {
      cross.hidden = true;
      mark.hidden = true;
      hideTip();
    });
    return box;
  }

  // ================================================================ 表示テーマ
  const THEME_UI = {
    auto: { label: '表示: 自動（OSの設定に合わせる）', icon: () => svg('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, svg('circle', { cx: 12, cy: 12, r: 8 }), svg('path', { d: 'M12 4a8 8 0 0 1 0 16z', class: 'fill' })) },
    light: { label: '表示: ライト', icon: () => svg('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, svg('circle', { cx: 12, cy: 12, r: 4 }), svg('path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' })) },
    dark: { label: '表示: ダーク', icon: () => svg('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, svg('path', { d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' })) },
  };
  let themePref = store.get('theme', 'auto');
  function applyTheme() {
    if (!THEME_UI[themePref]) themePref = 'auto';
    if (themePref === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', themePref);
    const ui = THEME_UI[themePref];
    const btn = $('themeToggle');
    btn.replaceChildren(ui.icon());
    btn.title = ui.label + '（クリックで切り替え）';
    btn.setAttribute('aria-label', ui.label + '（クリックで切り替え）');
  }

  // ================================================================ イベント
  function bindEvents() {
    const qEl = $('q');
    qEl.addEventListener('input', () => {
      state.f.q = qEl.value;
      state.limit = PAGE;
      renderTabs();
      renderMain();
    });
    qEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        const v = qEl.value.trim();
        if (v) {
          qEl.value = '';
          state.f.q = '';
          runSearch(v);
        }
      } else if (e.key === 'Escape') {
        qEl.value = '';
        state.f.q = '';
        renderTabs();
        renderMain();
      }
    });

    const bindToggle = (id, key, after) => {
      const el = $(id);
      el.checked = state.f[key];
      el.addEventListener('change', () => {
        state.f[key] = el.checked;
        store.set(key, el.checked);
        state.limit = PAGE;
        after();
      });
    };
    bindToggle('stockOnly', 'stockOnly', () => { renderTabs(); renderMain(); });
    bindToggle('showEnglish', 'showEnglish', renderAll);
    bindToggle('compact', 'compact', renderMain);

    $('feedFilter').addEventListener('change', (e) => {
      state.f.feed = e.target.value;
      state.limit = PAGE;
      renderMain();
    });

    $('more').addEventListener('click', () => {
      state.limit += PAGE;
      renderMain();
    });

    $('newPill').addEventListener('click', () => {
      renderAll();
      scrollToList();
      $('list').focus({ preventScroll: true });
    });

    $('refresh').addEventListener('click', refreshAll);

    $('themeToggle').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      themePref = order[(order.indexOf(themePref) + 1) % order.length];
      store.set('theme', themePref);
      applyTheme();
    });

    const watchInput = $('watchInput');
    const submitWatch = () => {
      const v = watchInput.value.trim();
      if (!v) return;
      if (isWatched(v)) {
        state.watchSel = state.watch.find((w) => w.toLowerCase() === v.toLowerCase());
      } else if (addWatch(v)) {
        state.watchSel = '';
      }
      watchInput.value = '';
      renderMain();
      renderSide();
    };
    $('watchAdd').addEventListener('click', submitWatch);
    watchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) submitWatch();
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === '/') {
        e.preventDefault();
        qEl.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        if (!state.loading) refreshAll();
      } else if (/^[1-9]$/.test(e.key)) {
        const btn = document.querySelector(`.tab[data-key="${e.key}"]`);
        if (btn) btn.click();
      }
    });

    // 自動更新（タブが表示されているときだけ）
    setInterval(() => {
      if (document.visibilityState === 'visible') loadNews({ auto: true });
    }, NEWS_INTERVAL);
    setInterval(() => {
      if (document.visibilityState === 'visible') loadQuotes();
    }, QUOTES_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.newsAt && Date.now() - state.newsAt > NEWS_INTERVAL) loadNews({ auto: true });
      if (state.quotesAt && Date.now() - state.quotesAt > QUOTES_INTERVAL) loadQuotes();
    });

    // 「◯分前」の表示を1分ごとに更新
    setInterval(() => {
      document.querySelectorAll('time[data-ts]').forEach((el) => { el.textContent = relTime(+el.dataset.ts); });
      renderStatus();
    }, 60 * 1000);

    window.addEventListener('scroll', hideTip, { passive: true });
  }

  // ================================================================ 起動
  if (STATIC) {
    document.querySelector('#watchPanel .hint').textContent =
      '取得済みのニュース（直近1〜2日・約20分ごとに更新）から、登録したキーワードを含む記事をまとめて表示します。';
  }
  applyTheme();
  bindEvents();
  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);

  const initial = hashToView(location.hash);
  if (initial && initial.type !== 'search') {
    state.view = initial;
    if (initial.type === 'category' || initial.type === 'watch') state.lastTab = initial;
  } else if (!initial) {
    history.replaceState(null, '', viewToHash(state.view));
  }

  setLoading(+1);
  renderAll();
  renderTiles();
  setLoading(-1);
  loadNews();
  loadQuotes();
  if (initial && initial.type === 'search') runSearch(initial.q, { history: 'none' });
  else if (state.view.type === 'watch') loadWatch();
})();
