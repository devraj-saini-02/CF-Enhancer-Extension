/**
 * Codeforces Matrix Analyzer — content.js  v2.0
 * Manifest V3 · Vanilla JS · Zero dependencies
 *
 * Key architecture changes from v1:
 *  - NO navigation tab. Widget is injected automatically into #pageContent
 *    below the profile header / activity calendar on page load.
 *  - Unlimited topic rows (no cap).
 *  - Color blocks are strict 16×16 squares (border-radius: 0).
 *  - Permanent chrome.storage.local persistence per handle.
 *  - Reset is the ONLY way to return to baseline defaults.
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

  /** Human-readable labels for every known CF tag */
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

  /* ================================================================
     UTILITIES
  ================================================================ */
  /** Extract CF handle from /profile/<handle> */
  function getHandle() {
    const parts = window.location.pathname.split('/');
    return parts[2] ? decodeURIComponent(parts[2]) : null;
  }

  function storageKey(handle) {
    return STORAGE_PREFIX + handle.toLowerCase();
  }

  function tagLabel(tag) {
    return TAG_LABELS[tag]
      || tag.replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Scrape the user's contest rating from the profile DOM.
   * Codeforces renders it inside `.info ul li` as "Contest rating: 1542"
   * or inside a coloured <span> in .userbox.
   */
  function getRatingFromDOM() {
    // Strategy 1: structured list item
    for (const li of document.querySelectorAll('.info ul li')) {
      if (/contest rating/i.test(li.textContent)) {
        const m = li.textContent.match(/\b(\d{3,4})\b/);
        if (m) return parseInt(m[1], 10);
      }
    }
    // Strategy 2: coloured rating span (Codeforces adds class like "user-red")
    for (const span of document.querySelectorAll('.userbox span[class], .info span[class]')) {
      const m = span.textContent.match(/\b(\d{3,4})\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 800 && n <= 4000) return n;
      }
    }
    // Strategy 3: any bold number in the info block
    for (const b of document.querySelectorAll('.info b, .userbox b')) {
      const n = parseInt(b.textContent.trim(), 10);
      if (n >= 800 && n <= 4000) return n;
    }
    return null;
  }

  /**
   * Build an array of COLUMN_WINDOW consecutive 100-point rating bands
   * centred roughly around the user's current rating.
   * e.g. rating=972  → [800, 900, 1000, 1100, 1200, 1300]
   *      rating=3400 → [3000,3100,3200,3300,3400,3500]
   */
  function buildRatingWindow(userRating) {
    if (!userRating || userRating < 800) userRating = 800;
    // Lower bound = floor to nearest 100, then step back 2 columns so the
    // user's band sits roughly in the middle of the 6-column window.
    const floorHundred = Math.floor(userRating / 100) * 100;
    const start = Math.max(800, floorHundred - 200);
    return Array.from({ length: COLUMN_WINDOW }, (_, i) => start + i * RATING_STEP);
  }

  /* ================================================================
     DATA ENGINE
  ================================================================ */
  async function fetchSubmissions(handle) {
    const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.status !== 'OK') throw new Error(json.comment || 'CF API returned non-OK');
    return json.result; // raw submission array
  }

  /**
   * Parse raw CF submissions into the cell map.
   *
   * Deduplication rule:
   *   - Key = contestId + "_" + problemIndex  (one entry per unique problem)
   *   - If ANY submission for that key has verdict "OK" → Solved
   *   - Else → Attempted
   *
   * Returns:
   *   cellMap    : Map<"tag|band", { solvedProblems[], attemptedProblems[] }>
   *   sortedTags : string[] — all tags sorted by total solves descending
   *   maxRating  : number   — highest rated band seen in data
   */
  function parseSubmissions(submissions) {
    /* Step 1 — deduplicate by problem key */
    const problemMap = new Map(); // key → entry

    for (const sub of submissions) {
      const prob = sub.problem;
      if (!prob) continue;

      const key = `${sub.contestId || prob.contestId || 0}_${prob.index}`;
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
        problemMap.get(key).verdict = 'OK'; // upgrade to solved
      }
    }

    /* Step 2 — build cell map */
    const cellMap        = new Map();
    const tagSolveCount  = new Map();
    let   maxRating      = 0;

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

    /* Step 3 — sort tags */
    const sortedTags = [...tagSolveCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);

    return { cellMap, sortedTags, maxRating };
  }

  /* ================================================================
     STORAGE HELPERS
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
     DOM INJECTION — auto-place widget below profile header
  ================================================================ */
  /**
   * Find the best insertion anchor inside #pageContent and return the
   * element after which the widget should be inserted.
   *
   * Codeforces profile page structure (approximate):
   *   #pageContent
   *     .userbox / .roundbox  ← profile header card
   *     div (activity/calendar strip)
   *     ...rest of page
   */
  function findInsertionAnchor() {
    const pageContent = document.getElementById('pageContent');
    if (!pageContent) return null;

    // Prefer the user activity / heatmap block that appears just below header
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

    // Fallback: last child of pageContent
    return pageContent.lastElementChild || null;
  }

  function createAndInjectPanel() {
    if (document.getElementById('cfmatrix-widget')) {
      return document.getElementById('cfmatrix-widget');
    }

    const widget = document.createElement('div');
    widget.id = 'cfmatrix-widget';
    widget.className = 'cfmatrix-widget';

    const anchor = findInsertionAnchor();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(widget, anchor.nextSibling);
    } else {
      // Absolute fallback: append to #pageContent or body
      const pc = document.getElementById('pageContent') || document.body;
      pc.appendChild(widget);
    }

    return widget;
  }

  /* ================================================================
     LOADING / ERROR STATES
  ================================================================ */
  function renderLoading(widget) {
    widget.innerHTML = `
      <div class="cfmatrix-header-bar">
        <span class="cfmatrix-title">Matrix Analysis</span>
      </div>
      <div class="cfmatrix-loading">
        <div class="cfmatrix-spinner"></div>
        <span>Loading submission data…</span>
      </div>`;
  }

  function renderError(widget, msg) {
    widget.innerHTML = `
      <div class="cfmatrix-header-bar">
        <span class="cfmatrix-title">Matrix Analysis</span>
      </div>
      <div class="cfmatrix-error">
        <strong>Matrix Analysis — fetch error:</strong> ${msg}
      </div>`;
  }

  /* ================================================================
     CONTROL BAR
  ================================================================ */
  /**
   * Builds the control bar and returns { bar, refreshDropdown, refreshRatingLabel, refreshTopicBtn }
   * so the reset handler can update UI state without a full re-render.
   *
   * activeTags  and  activeRatings  are mutated in-place by callbacks.
   */
  function buildControlBar({ allTags, activeTags, activeRatings, onTagChange, onRatingShift, onReset }) {
    const bar = document.createElement('div');
    bar.className = 'cfmatrix-control-bar';

    /* ---- Topic dropdown ---- */
    const dropWrap = document.createElement('div');
    dropWrap.className = 'cfmatrix-dropdown-wrap';

    const topicBtn = document.createElement('button');
    topicBtn.type = 'button';
    topicBtn.className = 'cfmatrix-dropdown-btn';

    function refreshTopicBtn() {
      topicBtn.textContent = `Topics ▾`;
    }
    refreshTopicBtn();

    const dropList = document.createElement('div');
    dropList.className = 'cfmatrix-dropdown-list';
    dropList.style.display = 'none';

    /* Search inside dropdown */
    const searchBox = document.createElement('input');
    searchBox.type = 'text';
    searchBox.placeholder = 'Filter topics…';
    searchBox.className = 'cfmatrix-dropdown-search';
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
      // Show ALL tags (unlimited)
      for (const tag of allTags) {
        const label = document.createElement('label');
        label.className = 'cfmatrix-dropdown-item';
        label.dataset.tag = tag;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = tag;
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

    // Close on outside click
    document.addEventListener('click', () => { dropList.style.display = 'none'; });
    dropList.addEventListener('click', e => e.stopPropagation());

    dropWrap.appendChild(topicBtn);
    dropWrap.appendChild(dropList);

    /* ---- Rating window shifter ---- */
    const ratingWrap = document.createElement('div');
    ratingWrap.className = 'cfmatrix-rating-wrap';

    const btnLeft = document.createElement('button');
    btnLeft.type = 'button';
    btnLeft.className = 'cfmatrix-shift-btn';
    btnLeft.textContent = '◀';
    btnLeft.title = 'Shift window −100';

    const ratingLabel = document.createElement('span');
    ratingLabel.className = 'cfmatrix-rating-label';

    function refreshRatingLabel() {
      if (activeRatings.length) {
        ratingLabel.textContent =
          `${activeRatings[0]} – ${activeRatings[activeRatings.length - 1]}`;
      }
    }
    refreshRatingLabel();

    const btnRight = document.createElement('button');
    btnRight.type = 'button';
    btnRight.className = 'cfmatrix-shift-btn';
    btnRight.textContent = '▶';
    btnRight.title = 'Shift window +100';

    btnLeft.addEventListener('click', () => {
      if (activeRatings[0] <= 800) return;
      for (let i = 0; i < activeRatings.length; i++) activeRatings[i] -= RATING_STEP;
      refreshRatingLabel();
      onRatingShift();
    });

    btnRight.addEventListener('click', () => {
      for (let i = 0; i < activeRatings.length; i++) activeRatings[i] += RATING_STEP;
      refreshRatingLabel();
      onRatingShift();
    });

    ratingWrap.appendChild(btnLeft);
    ratingWrap.appendChild(ratingLabel);
    ratingWrap.appendChild(btnRight);

    /* ---- Reset button (emoji only — lives in the header bar, not here) ---- */
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'cfmatrix-reset-btn';
    resetBtn.textContent = '🔄';
    resetBtn.title = 'Reset Defaults — clear saved state and restore baseline';
    resetBtn.addEventListener('click', onReset);

    /* ---- Legend (lives in the header bar, not here) ---- */
    const legend = document.createElement('div');
    legend.className = 'cfmatrix-legend';
    legend.innerHTML =
      `<span class="cfmatrix-legend-sq cfmatrix-legend-solved"></span><span>Solved</span>` +
      `<span class="cfmatrix-legend-sq cfmatrix-legend-attempted"></span><span>Attempted</span>`;

    /* ---- Legend pinned to far right of control bar ---- */
    const controlRight = document.createElement('div');
    controlRight.className = 'cfmatrix-control-right';
    controlRight.appendChild(legend);

    bar.appendChild(dropWrap);
    bar.appendChild(ratingWrap);
    bar.appendChild(controlRight);

    return { bar, resetBtn, legend, refreshDropdown, refreshRatingLabel, refreshTopicBtn };
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
        if (cell.solvedProblems.length   > maxSolved)   maxSolved   = cell.solvedProblems.length;
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

    /* ----- THEAD ----- */
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');

    const cornerTh = document.createElement('th');
    cornerTh.className = 'cfmatrix-th cfmatrix-corner-th';
    cornerTh.textContent = 'Topic \\ Rating';
    hRow.appendChild(cornerTh);

    for (const r of activeRatings) {
      const th = document.createElement('th');
      th.className = 'cfmatrix-th cfmatrix-rating-th';
      th.textContent = r;
      hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    table.appendChild(thead);

    /* ----- TBODY ----- */
    const tbody = document.createElement('tbody');

    for (const tag of activeTags) {
      const tr = document.createElement('tr');
      tr.className = 'cfmatrix-row';

      /* Topic label */
      const labelTd = document.createElement('td');
      labelTd.className = 'cfmatrix-td cfmatrix-topic-td';
      labelTd.textContent = tagLabel(tag);
      tr.appendChild(labelTd);

      /* Data cells */
      for (const rating of activeRatings) {
        const cellKey = `${tag}|${rating}`;
        const data    = isGhost ? null : cellMap.get(cellKey);
        const solved    = data ? data.solvedProblems.length   : 0;
        const attempted = data ? data.attemptedProblems.length : 0;
        const hasData   = solved > 0 || attempted > 0;

        const td = document.createElement('td');
        td.className = 'cfmatrix-td cfmatrix-data-td';

        const flex = document.createElement('div');
        flex.className = 'cfmatrix-cell-flex';

        /* Solved square */
        const solvedSq = document.createElement('div');
        solvedSq.className = 'cfmatrix-sq cfmatrix-sq-solved';

        /* Attempted square */
        const attemptedSq = document.createElement('div');
        attemptedSq.className = 'cfmatrix-sq cfmatrix-sq-attempted';

        if (!hasData || isGhost) {
          /* ---- INACTIVE (zero data) ---- */
          solvedSq.classList.add('cfmatrix-sq-inactive');
          attemptedSq.classList.add('cfmatrix-sq-inactive');
        } else {
          /* ---- ACTIVE ---- */
          // Solved square
          if (solved > 0) {
            const alpha = maxSolved > 0 ? Math.max(0.12, solved / maxSolved) : 0.12;
            solvedSq.style.backgroundColor = `rgba(${CF_GREEN}, ${alpha.toFixed(3)})`;
            solvedSq.style.cursor = 'pointer';
            solvedSq.title = `${solved} solved`;
            solvedSq.dataset.count = solved;
            solvedSq.addEventListener('click', e => {
              e.stopPropagation();
              toggleOverlay(td, tag, rating, 'solved', data.solvedProblems);
            });
          } else {
            solvedSq.classList.add('cfmatrix-sq-inactive');
          }

          // Attempted square
          if (attempted > 0) {
            const alpha = maxAttempted > 0 ? Math.max(0.12, attempted / maxAttempted) : 0.12;
            attemptedSq.style.backgroundColor = `rgba(${CF_ORANGE}, ${alpha.toFixed(3)})`;
            attemptedSq.style.cursor = 'pointer';
            attemptedSq.title = `${attempted} attempted`;
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
     OVERLAY CARD (problem list)
  ================================================================ */
  let _activeOverlay = null; // { td, type, overlayTr }

  function problemUrl(contestId, index) {
    return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
  }

  function toggleOverlay(td, tag, rating, type, problems) {
    // Toggle off if same cell+type
    if (_activeOverlay && _activeOverlay.td === td && _activeOverlay.type === type) {
      closeOverlay();
      return;
    }
    closeOverlay();

    /* Build card */
    const card = document.createElement('div');
    card.className = 'cfmatrix-overlay-card';

    const typeLabel = type === 'solved' ? '✔ Solved' : '⚠ Attempted';
    const typeColor = type === 'solved' ? `rgb(${CF_GREEN})` : `rgb(${CF_ORANGE})`;

    const header = document.createElement('div');
    header.className = 'cfmatrix-overlay-header';
    header.innerHTML =
      `<span style="color:${typeColor};font-weight:bold;">${typeLabel}</span>` +
      `<span class="cfmatrix-overlay-subtitle">${tagLabel(tag)} · ${rating}</span>` +
      `<button class="cfmatrix-overlay-close" title="Close">✕</button>`;

    header.querySelector('.cfmatrix-overlay-close').addEventListener('click', e => {
      e.stopPropagation();
      closeOverlay();
    });

    const list = document.createElement('div');
    list.className = 'cfmatrix-overlay-list';

    for (const prob of problems) {
      const a = document.createElement('a');
      a.href = problemUrl(prob.contestId, prob.index);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'cfmatrix-prob-link';

      // Plain text node so long names wrap naturally (white-space: normal on the <a>).
      // The rating badge is a separate inline <span> that never forces line breaks.
      a.appendChild(document.createTextNode(`${prob.contestId}${prob.index}. ${prob.name}`));

      if (prob.rating) {
        const badge = document.createElement('span');
        badge.className = 'cfmatrix-prob-rating';
        badge.textContent = ` [${prob.rating}]`;
        a.appendChild(badge);
      }

      list.appendChild(a);
    }

    card.appendChild(header);
    card.appendChild(list);

    /* Inject as new <tr> directly beneath current row */
    const tr = td.closest('tr');
    if (!tr) return;

    const colCount  = tr.querySelectorAll('td, th').length;
    const overlayTr = document.createElement('tr');
    overlayTr.className = 'cfmatrix-overlay-tr';

    const overlayTd = document.createElement('td');
    overlayTd.colSpan = colCount;
    overlayTd.className = 'cfmatrix-overlay-td';
    overlayTd.appendChild(card);
    overlayTr.appendChild(overlayTd);

    tr.parentNode.insertBefore(overlayTr, tr.nextSibling);
    _activeOverlay = { td, type, overlayTr };

    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  }

  function closeOverlay() {
    if (_activeOverlay) {
      _activeOverlay.overlayTr.remove();
      _activeOverlay = null;
    }
  }

  document.addEventListener('click', closeOverlay);

  /* ================================================================
     MAIN RENDER ORCHESTRATOR
  ================================================================ */
  function renderMatrix(widget, { cellMap, sortedTags, maxRating, handle, savedState, isGhost }) {
    widget.innerHTML = '';

    /* ---- Resolve initial active state ---- */
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

    // Safety: ensure window is always exactly 6 columns
    if (activeRatings.length !== COLUMN_WINDOW) {
      activeRatings = buildRatingWindow(activeRatings[0] || 1000);
    }

    const allTags = isGhost ? [...GHOST_TAGS] : [...sortedTags];

    /* ---- Persistence ---- */
    function persist() {
      saveState(handle, {
        activeTags    : [...activeTags],
        activeRatings : [...activeRatings]
      });
    }

    /* ---- Widget header strip ---- */
    const headerBar = document.createElement('div');
    headerBar.className = 'cfmatrix-header-bar';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'cfmatrix-title';
    titleSpan.textContent = 'Matrix Analysis';
    headerBar.appendChild(titleSpan);

    // Right-side group: legend + reset emoji — built after buildControlBar runs
    widget.appendChild(headerBar);

    /* ---- Table container (re-built on every state change) ---- */
    let tableWrap = null;

    function renderTable() {
      closeOverlay();
      if (tableWrap) tableWrap.remove();

      tableWrap = document.createElement('div');
      tableWrap.className = 'cfmatrix-table-wrap';

      const displayTags = activeTags.length
        ? activeTags
        : (isGhost ? GHOST_TAGS : sortedTags.slice(0, 8));

      const table = buildMatrixTable(displayTags, activeRatings, cellMap || new Map(), isGhost);
      tableWrap.appendChild(table);
      widget.appendChild(tableWrap);
    }

    /* ---- Control bar ---- */
    const { bar, resetBtn, legend, refreshDropdown, refreshRatingLabel, refreshTopicBtn } = buildControlBar({
      allTags,
      activeTags,
      activeRatings,

      onTagChange() {
        persist();
        renderTable();
      },

      onRatingShift() {
        persist();
        renderTable();
      },

      onReset() {
        clearState(handle);

        // Restore baseline
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

        // Sync control bar UI
        refreshRatingLabel();
        refreshDropdown();
        refreshTopicBtn();
        renderTable();
      }
    });

    // Header right group: reset emoji pinned to far right of header
    const headerRight = document.createElement('div');
    headerRight.className = 'cfmatrix-header-right';
    headerRight.appendChild(resetBtn);
    headerBar.appendChild(headerRight);

    widget.appendChild(bar);
    renderTable();
  }

  /* ================================================================
     ENTRY POINT — runs automatically on page load
  ================================================================ */
  async function init() {
    const handle = getHandle();
    if (!handle) return;

    /* Inject panel immediately so user sees it straight away */
    const widget = createAndInjectPanel();
    renderLoading(widget);

    /* Load persisted state and fetch API in parallel */
    let savedState, submissions;
    try {
      [savedState, submissions] = await Promise.all([
        loadState(handle),
        fetchSubmissions(handle)
      ]);
    } catch (err) {
      renderError(widget, err.message);
      return;
    }

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

    renderMatrix(widget, { cellMap, sortedTags, maxRating, handle, savedState, isGhost });
  }

  /* Boot */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();