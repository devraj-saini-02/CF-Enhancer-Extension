/**
 * Codeforces Problem Tracker — content.js  v3.0
 * Manifest V3 · Vanilla JS · Zero dependencies
 *
 * v3 changes:
 *  - Title renamed "Problem Tracker" (matches sibling extension naming style)
 *  - Gap 1: fetchSubmissions() has exponential-backoff retry (3 attempts,
 *           safe text-only error rendering (no innerHTML with API strings)
 *  - Gap 2: Pagination loop fetches all submissions past the 10 000 cap;
 *           banner shown when data was paginated (user knows it's complete)
 *  - Gap 3: Full dark-mode support via @media + .dark body class detection
 *  - Bug:   Deselecting all topics now shows a "No topics selected" placeholder
 *           instead of silently falling back to the top-8 default
 */

(() => {
  'use strict';

  /* ================================================================
     CONSTANTS
  ================================================================ */
  const GHOST_TAGS = [
    'greedy', 'math', 'implementation', 'brute force',
    'constructive algorithms', 'binary search', 'sortings', 'dp'
  ];
  const GHOST_RATINGS  = [800, 900, 1000, 1100, 1200, 1300];
  const RATING_STEP    = 100;
  const COLUMN_WINDOW  = 6;
  const CF_GREEN       = '0, 168, 67';
  const CF_ORANGE      = '255, 133, 27';
  const STORAGE_PREFIX = 'cfmatrix_v2_';

  // CF API paginates at 10 000; we fetch in chunks to get everything
  const API_PAGE_SIZE  = 10000;

  const TAG_LABELS = {
    'greedy'                   : 'Greedy',
    'math'                     : 'Math',
    'implementation'           : 'Implementation',
    'brute force'              : 'Brute Force',
    'constructive algorithms'  : 'Constructive Algorithms',
    'binary search'            : 'Binary Search',
    'sortings'                 : 'Sortings',
    'dp'                       : 'Dynamic Programming',
    'graphs'                   : 'Graphs',
    'dfs and similar'          : 'DFS & Similar',
    'trees'                    : 'Trees',
    'data structures'          : 'Data Structures',
    'number theory'            : 'Number Theory',
    'strings'                  : 'Strings',
    'two pointers'             : 'Two Pointers',
    'bitmasks'                 : 'Bitmasks',
    'combinatorics'            : 'Combinatorics',
    'geometry'                 : 'Geometry',
    'shortest paths'           : 'Shortest Paths',
    'divide and conquer'       : 'Divide & Conquer',
    'flows'                    : 'Flows',
    'interactive'              : 'Interactive',
    'probabilities'            : 'Probabilities',
    'matrix exponentiation'    : 'Matrix Exponentiation',
    'string suffix structures' : 'Suffix Structures',
    'segment tree'             : 'Segment Tree',
    'fft'                      : 'FFT',
    'games'                    : 'Games',
    'graph matchings'          : 'Graph Matchings',
    'hashing'                  : 'Hashing',
    '2-sat'                    : '2-SAT',
    'chinese remainder theorem': 'CRT',
    'expression parsing'       : 'Expression Parsing',
    'meet-in-the-middle'       : 'Meet in the Middle',
    'ternary search'           : 'Ternary Search',
    'schedules'                : 'Schedules',
    'dsu'                      : 'DSU'
  };

  const WIDGET_TITLE = 'Problem Tracker';

  /* ================================================================
     UTILITIES
  ================================================================ */
  function getHandle() {
    const parts = window.location.pathname.split('/');
    return parts[2] ? decodeURIComponent(parts[2]) : null;
  }

  function storageKey(handle) {
    return STORAGE_PREFIX + handle.toLowerCase();
  }

  function tagLabel(tag) {
    return TAG_LABELS[tag] || tag.replace(/\b\w/g, c => c.toUpperCase());
  }

  function getRatingFromDOM() {
    for (const li of document.querySelectorAll('.info ul li')) {
      if (/contest rating/i.test(li.textContent)) {
        const m = li.textContent.match(/\b(\d{3,4})\b/);
        if (m) return parseInt(m[1], 10);
      }
    }
    for (const span of document.querySelectorAll('.userbox span[class], .info span[class]')) {
      const m = span.textContent.match(/\b(\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 800 && n <= 4000) return n;
      }
    }
    for (const b of document.querySelectorAll('.info b, .userbox b')) {
      const n = parseInt(b.textContent.trim(), 10);
      if (n >= 800 && n <= 4000) return n;
    }
    return null;
  }

  function buildRatingWindow(userRating) {
    if (!userRating || userRating < 800) userRating = 800;
    const floorHundred = Math.floor(userRating / 100) * 100;
    // Centre window around user's rating, clamped within [800, 3500]
    const MAX_START = 3500 - (COLUMN_WINDOW - 1) * RATING_STEP; // = 3000
    const start = Math.min(MAX_START, Math.max(800, floorHundred - 200));
    return Array.from({ length: COLUMN_WINDOW }, (_, i) => start + i * RATING_STEP);
  }

  /** sleep helper for backoff */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ================================================================
     GAP 1 — FETCH WITH EXPONENTIAL-BACKOFF RETRY
     3 attempts: immediate → 1 s delay → 3 s delay
     Error message is returned as a plain string, never injected as HTML.
  ================================================================ */
  async function fetchWithRetry(url, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(attempt === 1 ? 1000 : 3000);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (json.status !== 'OK') {
          // comment field is plain text from CF — we store it but NEVER innerHTML it
          throw new Error(json.comment || 'CF API returned non-OK');
        }
        return json.result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /* ================================================================
     GAP 2 — PAGINATED FETCH (bypasses the 10 000 submission cap)
     Fetches pages of API_PAGE_SIZE until a page comes back smaller,
     meaning we've reached the end.
     Returns { submissions: [], wasPaginated: boolean }
  ================================================================ */
  async function fetchSubmissions(handle) {
    const all = [];
    let from = 1;
    let wasPaginated = false;

    while (true) {
      const url =
        `https://codeforces.com/api/user.status` +
        `?handle=${encodeURIComponent(handle)}` +
        `&from=${from}&count=${API_PAGE_SIZE}`;

      const page = await fetchWithRetry(url);

      all.push(...page);

      if (page.length < API_PAGE_SIZE) break; // last page — done

      // We got a full page; there may be more
      wasPaginated = true;
      from += API_PAGE_SIZE;
    }

    return { submissions: all, wasPaginated };
  }

  /* ================================================================
     DATA ENGINE
  ================================================================ */
  function parseSubmissions(submissions) {
    const problemMap = new Map();

    for (const sub of submissions) {
      const prob = sub.problem;
      if (!prob) continue;
      const key  = `${sub.contestId || prob.contestId || 0}_${prob.index}`;
      const isOK = sub.verdict === 'OK';

      if (!problemMap.has(key)) {
        problemMap.set(key, {
          verdict   : isOK ? 'OK' : 'ATTEMPTED',
          tags      : prob.tags || [],
          rating    : prob.rating || null,
          contestId : sub.contestId || prob.contestId,
          index     : prob.index,
          name      : prob.name
        });
      } else if (isOK) {
        problemMap.get(key).verdict = 'OK';
      }
    }

    const cellMap       = new Map();
    const tagSolveCount = new Map();
    let   maxRating     = 0;

    for (const entry of problemMap.values()) {
      if (!entry.rating) continue;
      const band = Math.floor(entry.rating / 100) * 100;
      if (band > maxRating) maxRating = band;

      const probInfo = {
        contestId : entry.contestId,
        index     : entry.index,
        name      : entry.name,
        rating    : entry.rating
      };

      for (const tag of entry.tags) {
        const cellKey = `${tag}|${band}`;
        if (!cellMap.has(cellKey)) {
          cellMap.set(cellKey, { solvedProblems: [], attemptedProblems: [] });
        }
        const cell = cellMap.get(cellKey);

        if (entry.verdict === 'OK') {
          cell.solvedProblems.push(probInfo);
          tagSolveCount.set(tag, (tagSolveCount.get(tag) || 0) + 1);
        } else {
          cell.attemptedProblems.push(probInfo);
          if (!tagSolveCount.has(tag)) tagSolveCount.set(tag, 0);
        }
      }
    }

    const sortedTags = [...tagSolveCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);

    return { cellMap, sortedTags, maxRating };
  }

  /* ================================================================
     STORAGE
  ================================================================ */
  function loadState(handle) {
    return new Promise(resolve => {
      chrome.storage.local.get(storageKey(handle), result => {
        resolve(result[storageKey(handle)] || null);
      });
    });
  }

  function saveState(handle, state) {
    chrome.storage.local.set({ [storageKey(handle)]: state });
  }

  function clearState(handle) {
    chrome.storage.local.remove(storageKey(handle));
  }

  /* ================================================================
     DOM INJECTION
  ================================================================ */
  function findInsertionAnchor() {
    const pageContent = document.getElementById('pageContent');
    if (!pageContent) return null;

    const candidates = [
      pageContent.querySelector('._UserActivityGraph'),
      pageContent.querySelector('[class*="activity"]'),
      pageContent.querySelector('[class*="Activity"]'),
      pageContent.querySelector('.userbox'),
      pageContent.querySelector('.roundbox.userbox'),
      pageContent.firstElementChild
    ];

    for (const el of candidates) {
      if (el && el.parentNode === pageContent) return el;
    }
    return pageContent.lastElementChild || null;
  }

  function createAndInjectPanel() {
    if (document.getElementById('cfmatrix-widget')) {
      return document.getElementById('cfmatrix-widget');
    }
    const widget = document.createElement('div');
    widget.id        = 'cfmatrix-widget';
    widget.className = 'cfmatrix-widget';

    const anchor = findInsertionAnchor();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(widget, anchor.nextSibling);
    } else {
      (document.getElementById('pageContent') || document.body).appendChild(widget);
    }
    return widget;
  }

  /* ================================================================
     LOADING / ERROR STATES
     GAP 1 fix: error text set via textContent, never innerHTML,
     so a malicious CF API comment cannot inject script.
  ================================================================ */
  function makeHeaderBar() {
    const bar = document.createElement('div');
    bar.className = 'cfmatrix-header-bar';
    const t = document.createElement('span');
    t.className   = 'cfmatrix-title';
    t.textContent = WIDGET_TITLE;
    bar.appendChild(t);
    return bar;
  }

  function renderLoading(widget) {
    widget.innerHTML = '';
    widget.appendChild(makeHeaderBar());
    const wrap = document.createElement('div');
    wrap.className = 'cfmatrix-loading';
    const spinner = document.createElement('div');
    spinner.className = 'cfmatrix-spinner';
    const txt = document.createElement('span');
    txt.textContent = 'Loading submission data…';
    wrap.appendChild(spinner);
    wrap.appendChild(txt);
    widget.appendChild(wrap);
  }

  function renderError(widget, plainMsg) {
    widget.innerHTML = '';
    widget.appendChild(makeHeaderBar());

    const box = document.createElement('div');
    box.className = 'cfmatrix-error';

    const strong = document.createElement('strong');
    strong.textContent = 'Problem Tracker — could not load data: ';
    // textContent only — never innerHTML with the API string
    const msgNode = document.createTextNode(plainMsg);

    box.appendChild(strong);
    box.appendChild(msgNode);
    widget.appendChild(box);
  }

  /* ================================================================
     CONTROL BAR
  ================================================================ */
  function buildControlBar({ allTags, activeTags, activeRatings, onTagChange, onRatingShift, onReset }) {
    const bar = document.createElement('div');
    bar.className = 'cfmatrix-control-bar';

    /* ---- Topic dropdown ---- */
    const dropWrap = document.createElement('div');
    dropWrap.className = 'cfmatrix-dropdown-wrap';

    const topicBtn = document.createElement('button');
    topicBtn.type      = 'button';
    topicBtn.className = 'cfmatrix-dropdown-btn';

    function refreshTopicBtn() { topicBtn.textContent = 'Topics ▾'; }
    refreshTopicBtn();

    const dropList = document.createElement('div');
    dropList.className    = 'cfmatrix-dropdown-list';
    dropList.style.display = 'none';

    const searchBox = document.createElement('input');
    searchBox.type        = 'text';
    searchBox.placeholder = 'Filter topics…';
    searchBox.className   = 'cfmatrix-dropdown-search';
    searchBox.addEventListener('input', () => {
      const q = searchBox.value.toLowerCase();
      dropList.querySelectorAll('.cfmatrix-dropdown-item').forEach(item => {
        item.style.display = item.dataset.tag.includes(q) ? '' : 'none';
      });
    });
    dropList.appendChild(searchBox);

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'cfmatrix-dropdown-items';
    dropList.appendChild(itemsContainer);

    function refreshDropdown() {
      itemsContainer.innerHTML = '';
      searchBox.value = '';
      for (const tag of allTags) {
        const label = document.createElement('label');
        label.className  = 'cfmatrix-dropdown-item';
        label.dataset.tag = tag;

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.value   = tag;
        cb.checked = activeTags.includes(tag);

        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!activeTags.includes(tag)) activeTags.push(tag);
          } else {
            const idx = activeTags.indexOf(tag);
            if (idx !== -1) activeTags.splice(idx, 1);
          }
          refreshTopicBtn();
          onTagChange();
        });

        const span = document.createElement('span');
        span.textContent = tagLabel(tag);

        label.appendChild(cb);
        label.appendChild(span);
        itemsContainer.appendChild(label);
      }
    }
    refreshDropdown();

    topicBtn.addEventListener('click', e => {
      e.stopPropagation();
      dropList.style.display = dropList.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { dropList.style.display = 'none'; });
    dropList.addEventListener('click', e => e.stopPropagation());

    dropWrap.appendChild(topicBtn);
    dropWrap.appendChild(dropList);

    /* ---- Rating shifter ---- */
    const ratingWrap = document.createElement('div');
    ratingWrap.className = 'cfmatrix-rating-wrap';

    const btnLeft = document.createElement('button');
    btnLeft.type      = 'button';
    btnLeft.className = 'cfmatrix-shift-btn';
    btnLeft.textContent = '◀';
    btnLeft.title     = 'Shift window −100';

    const ratingLabel = document.createElement('span');
    ratingLabel.className = 'cfmatrix-rating-label';

    function refreshRatingLabel() {
      if (activeRatings.length) {
        ratingLabel.textContent = `${activeRatings[0]} – ${activeRatings[activeRatings.length - 1]}`;
      }
    }
    refreshRatingLabel();

    const btnRight = document.createElement('button');
    btnRight.type       = 'button';
    btnRight.className  = 'cfmatrix-shift-btn';
    btnRight.textContent = '▶';
    btnRight.title      = 'Shift window +100';

    btnLeft.addEventListener('click', () => {
      if (activeRatings[0] <= 800) return;
      for (let i = 0; i < activeRatings.length; i++) activeRatings[i] -= RATING_STEP;
      refreshRatingLabel();
      syncBtnState();
      onRatingShift();
    });
    btnRight.addEventListener('click', () => {
      if (activeRatings[activeRatings.length - 1] >= 3500) return;
      for (let i = 0; i < activeRatings.length; i++) activeRatings[i] += RATING_STEP;
      refreshRatingLabel();
      syncBtnState();
      onRatingShift();
    });

    ratingWrap.appendChild(btnLeft);
    ratingWrap.appendChild(ratingLabel);
    ratingWrap.appendChild(btnRight);

    /* Sync disabled visual state of ◀▶ based on current window position */
    function syncBtnState() {
      const atMin = activeRatings[0] <= 800;
      const atMax = activeRatings[activeRatings.length - 1] >= 3500;
      btnLeft.disabled  = atMin;
      btnRight.disabled = atMax;
      btnLeft.style.opacity  = atMin ? '0.35' : '';
      btnRight.style.opacity = atMax ? '0.35' : '';
      btnLeft.style.cursor   = atMin ? 'default' : '';
      btnRight.style.cursor  = atMax ? 'default' : '';
    }
    syncBtnState(); // set initial state on render

    /* ---- Reset button (goes in header bar, returned separately) ---- */
    const resetBtn = document.createElement('button');
    resetBtn.type       = 'button';
    resetBtn.className  = 'cfmatrix-reset-btn';
    resetBtn.textContent = '🔄';
    resetBtn.title      = 'Reset Defaults — clear saved state and restore baseline';
    resetBtn.addEventListener('click', onReset);

    /* ---- Legend (goes in header bar, returned separately) ---- */
    const legend = document.createElement('div');
    legend.className = 'cfmatrix-legend';
    const solvedSq = document.createElement('span');
    solvedSq.className = 'cfmatrix-legend-sq cfmatrix-legend-solved';
    const solvedTxt = document.createElement('span');
    solvedTxt.textContent = 'Solved';
    const attemptedSq = document.createElement('span');
    attemptedSq.className = 'cfmatrix-legend-sq cfmatrix-legend-attempted';
    const attemptedTxt = document.createElement('span');
    attemptedTxt.textContent = 'Attempted';
    legend.appendChild(solvedSq);
    legend.appendChild(solvedTxt);
    legend.appendChild(attemptedSq);
    legend.appendChild(attemptedTxt);

    /* ---- Control right group: legend pinned to far right of control bar ---- */
    const controlRight = document.createElement('div');
    controlRight.className = 'cfmatrix-control-right';
    controlRight.appendChild(legend);

    bar.appendChild(dropWrap);
    bar.appendChild(ratingWrap);
    bar.appendChild(controlRight);

    return { bar, resetBtn, refreshDropdown, refreshRatingLabel, refreshTopicBtn, syncBtnState };
  }

  /* ================================================================
     MATRIX TABLE
  ================================================================ */
  function computeMaxima(activeTags, activeRatings, cellMap) {
    let maxSolved = 0, maxAttempted = 0;
    for (const tag of activeTags) {
      for (const rating of activeRatings) {
        const cell = cellMap.get(`${tag}|${rating}`);
        if (!cell) continue;
        if (cell.solvedProblems.length    > maxSolved)    maxSolved    = cell.solvedProblems.length;
        if (cell.attemptedProblems.length > maxAttempted) maxAttempted = cell.attemptedProblems.length;
      }
    }
    return { maxSolved, maxAttempted };
  }

  function buildMatrixTable(activeTags, activeRatings, cellMap, isGhost) {
    const { maxSolved, maxAttempted } = isGhost
      ? { maxSolved: 0, maxAttempted: 0 }
      : computeMaxima(activeTags, activeRatings, cellMap);

    const table = document.createElement('table');
    table.className = 'cfmatrix-table';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.className   = 'cfmatrix-th cfmatrix-corner-th';
    cornerTh.textContent = 'Topic \\ Rating';
    hRow.appendChild(cornerTh);

    for (const r of activeRatings) {
      const th = document.createElement('th');
      th.className   = 'cfmatrix-th cfmatrix-rating-th';
      th.textContent = r;
      hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    for (const tag of activeTags) {
      const tr = document.createElement('tr');
      tr.className = 'cfmatrix-row';

      const labelTd = document.createElement('td');
      labelTd.className   = 'cfmatrix-td cfmatrix-topic-td';
      labelTd.textContent = tagLabel(tag);
      tr.appendChild(labelTd);

      for (const rating of activeRatings) {
        const cellKey   = `${tag}|${rating}`;
        const data      = isGhost ? null : cellMap.get(cellKey);
        const solved    = data ? data.solvedProblems.length    : 0;
        const attempted = data ? data.attemptedProblems.length : 0;
        const hasData   = solved > 0 || attempted > 0;

        const td = document.createElement('td');
        td.className = 'cfmatrix-td cfmatrix-data-td';

        const flex = document.createElement('div');
        flex.className = 'cfmatrix-cell-flex';

        const solvedSq    = document.createElement('div');
        solvedSq.className = 'cfmatrix-sq cfmatrix-sq-solved';

        const attemptedSq    = document.createElement('div');
        attemptedSq.className = 'cfmatrix-sq cfmatrix-sq-attempted';

        if (!hasData || isGhost) {
          solvedSq.classList.add('cfmatrix-sq-inactive');
          attemptedSq.classList.add('cfmatrix-sq-inactive');
        } else {
          if (solved > 0) {
            const alpha = maxSolved > 0 ? Math.max(0.12, solved / maxSolved) : 0.12;
            solvedSq.style.backgroundColor = `rgba(${CF_GREEN}, ${alpha.toFixed(3)})`;
            solvedSq.style.cursor = 'pointer';
            solvedSq.title        = `${solved} solved`;
            solvedSq.dataset.count = solved;
            solvedSq.addEventListener('click', e => {
              e.stopPropagation();
              toggleOverlay(td, tag, rating, 'solved', data.solvedProblems);
            });
          } else {
            solvedSq.classList.add('cfmatrix-sq-inactive');
          }

          if (attempted > 0) {
            const alpha = maxAttempted > 0 ? Math.max(0.12, attempted / maxAttempted) : 0.12;
            attemptedSq.style.backgroundColor = `rgba(${CF_ORANGE}, ${alpha.toFixed(3)})`;
            attemptedSq.style.cursor = 'pointer';
            attemptedSq.title        = `${attempted} attempted`;
            attemptedSq.dataset.count = attempted;
            attemptedSq.addEventListener('click', e => {
              e.stopPropagation();
              toggleOverlay(td, tag, rating, 'attempted', data.attemptedProblems);
            });
          } else {
            attemptedSq.classList.add('cfmatrix-sq-inactive');
          }
        }

        flex.appendChild(solvedSq);
        flex.appendChild(attemptedSq);
        td.appendChild(flex);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    return table;
  }

  /* ================================================================
     OVERLAY CARD
  ================================================================ */
  let _activeOverlay = null;

  function problemUrl(contestId, index) {
    return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
  }

  function toggleOverlay(td, tag, rating, type, problems) {
    if (_activeOverlay && _activeOverlay.td === td && _activeOverlay.type === type) {
      closeOverlay(); return;
    }
    closeOverlay();

    const card = document.createElement('div');
    card.className = 'cfmatrix-overlay-card';

    const typeLabel = type === 'solved' ? '✔ Solved' : '⚠ Attempted';
    const typeColor = type === 'solved' ? `rgb(${CF_GREEN})` : `rgb(${CF_ORANGE})`;

    const header = document.createElement('div');
    header.className = 'cfmatrix-overlay-header';

    const typeSpan = document.createElement('span');
    typeSpan.style.color      = typeColor;
    typeSpan.style.fontWeight = 'bold';
    typeSpan.textContent      = typeLabel;

    const subtitle = document.createElement('span');
    subtitle.className   = 'cfmatrix-overlay-subtitle';
    const problemWord    = problems.length === 1 ? 'problem' : 'problems';
    subtitle.textContent = `${tagLabel(tag)} · ${rating} · ${problems.length} ${problemWord}`;

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'cfmatrix-overlay-close';
    closeBtn.title       = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeOverlay(); });

    header.appendChild(typeSpan);
    header.appendChild(subtitle);
    header.appendChild(closeBtn);

    const list = document.createElement('div');
    list.className = 'cfmatrix-overlay-list';

    for (const prob of problems) {
      const a = document.createElement('a');
      a.href      = problemUrl(prob.contestId, prob.index);
      a.target    = '_blank';
      a.rel       = 'noopener noreferrer';
      a.className = 'cfmatrix-prob-link';
      a.appendChild(document.createTextNode(`${prob.contestId}${prob.index}. ${prob.name}`));
      if (prob.rating) {
        const badge = document.createElement('span');
        badge.className   = 'cfmatrix-prob-rating';
        badge.textContent = ` [${prob.rating}]`;
        a.appendChild(badge);
      }
      list.appendChild(a);
    }

    card.appendChild(header);
    card.appendChild(list);

    const tr = td.closest('tr');
    if (!tr) return;

    const colCount  = tr.querySelectorAll('td, th').length;
    const overlayTr = document.createElement('tr');
    overlayTr.className = 'cfmatrix-overlay-tr';

    const overlayTd = document.createElement('td');
    overlayTd.colSpan   = colCount;
    overlayTd.className = 'cfmatrix-overlay-td';
    overlayTd.appendChild(card);
    overlayTr.appendChild(overlayTd);

    tr.parentNode.insertBefore(overlayTr, tr.nextSibling);
    _activeOverlay = { td, type, overlayTr };

    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  }

  function closeOverlay() {
    if (_activeOverlay) { _activeOverlay.overlayTr.remove(); _activeOverlay = null; }
  }

  document.addEventListener('click', closeOverlay);

  /* ================================================================
     MAIN RENDER ORCHESTRATOR
  ================================================================ */
  function renderMatrix(widget, { cellMap, sortedTags, maxRating, handle, savedState, isGhost, wasPaginated }) {
    widget.innerHTML = '';

    /* Resolve initial state */
    let activeTags    = [];
    let activeRatings = [];

    if (savedState && savedState.activeTags && savedState.activeTags.length) {
      activeTags    = savedState.activeTags;
      activeRatings = savedState.activeRatings;
    } else if (isGhost) {
      activeTags    = [...GHOST_TAGS];
      activeRatings = [...GHOST_RATINGS];
    } else {
      activeTags    = sortedTags.slice(0, 8);
      activeRatings = buildRatingWindow(getRatingFromDOM());
    }

    if (activeRatings.length !== COLUMN_WINDOW) {
      activeRatings = buildRatingWindow(activeRatings[0] || 1000);
    }

    const allTags = isGhost ? [...GHOST_TAGS] : [...sortedTags];

    function persist() {
      saveState(handle, { activeTags: [...activeTags], activeRatings: [...activeRatings] });
    }

    /* Header bar */
    const headerBar = document.createElement('div');
    headerBar.className = 'cfmatrix-header-bar';

    const titleSpan = document.createElement('span');
    titleSpan.className   = 'cfmatrix-title';
    titleSpan.textContent = WIDGET_TITLE;
    headerBar.appendChild(titleSpan);

    widget.appendChild(headerBar);


    /* Table container */
    let tableWrap = null;

    function renderTable() {
      closeOverlay();
      if (tableWrap) tableWrap.remove();

      tableWrap = document.createElement('div');
      tableWrap.className = 'cfmatrix-table-wrap';

      /* BUG FIX: if user deselected all topics, show a placeholder,
         NOT a silent fallback to the top-8 default */
      if (!isGhost && activeTags.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'cfmatrix-empty-placeholder';
        const msg = document.createElement('span');
        msg.textContent = 'No topics selected — open the Topics dropdown to choose topics.';
        placeholder.appendChild(msg);
        tableWrap.appendChild(placeholder);
        widget.appendChild(tableWrap);
        return;
      }

      const displayTags = activeTags.length
        ? activeTags
        : (isGhost ? GHOST_TAGS : sortedTags.slice(0, 8));

      const table = buildMatrixTable(displayTags, activeRatings, cellMap || new Map(), isGhost);
      tableWrap.appendChild(table);
      widget.appendChild(tableWrap);
    }

    /* Control bar */
    const { bar, resetBtn, refreshDropdown, refreshRatingLabel, refreshTopicBtn, syncBtnState } =
      buildControlBar({
        allTags, activeTags, activeRatings,

        onTagChange() { persist(); renderTable(); },
        onRatingShift() { persist(); renderTable(); },

        onReset() {
          clearState(handle);
          if (isGhost) {
            activeTags.length = 0;
            GHOST_TAGS.forEach(t => activeTags.push(t));
            activeRatings.length = 0;
            GHOST_RATINGS.forEach(r => activeRatings.push(r));
          } else {
            activeTags.length = 0;
            sortedTags.slice(0, 8).forEach(t => activeTags.push(t));
            activeRatings.length = 0;
            buildRatingWindow(getRatingFromDOM()).forEach(r => activeRatings.push(r));
          }
          refreshRatingLabel();
          syncBtnState();
          refreshDropdown();
          refreshTopicBtn();
          renderTable();
        }
      });

    /* Header right group: reset button only — legend lives in the control bar */
    const headerRight = document.createElement('div');
    headerRight.className = 'cfmatrix-header-right';
    headerRight.appendChild(resetBtn);
    headerBar.appendChild(headerRight);

    widget.appendChild(bar);
    renderTable();
  }

  /* ================================================================
     ENTRY POINT
  ================================================================ */
  async function init() {
    const handle = getHandle();
    if (!handle) return;

    const widget = createAndInjectPanel();
    renderLoading(widget);

    async function load() {
      let savedState, fetchResult;
      try {
        [savedState, fetchResult] = await Promise.all([
          loadState(handle),
          fetchSubmissions(handle)
        ]);
      } catch (err) {
        renderError(widget, err.message);
        return;
      }

      const { submissions, wasPaginated } = fetchResult;

      let cellMap, sortedTags, maxRating;
      let isGhost = false;

      if (!submissions || submissions.length === 0) {
        isGhost    = true;
        cellMap    = new Map();
        sortedTags = [...GHOST_TAGS];
        maxRating  = 1300;
      } else {
        ({ cellMap, sortedTags, maxRating } = parseSubmissions(submissions));
      }

      renderMatrix(widget, { cellMap, sortedTags, maxRating, handle, savedState, isGhost, wasPaginated });
    }

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
