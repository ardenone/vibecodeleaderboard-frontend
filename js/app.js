// API Configuration
const API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:8080'
    : `https://api.${window.location.hostname.replace(/^www\./, '')}`;

// State
let leaderboardData = null;
let filteredData = [];
let currentToolFilter = 'all';
let currentPage = 1;
let loadedCount = 0;
const pageSize = 50;
const virtualOverscan = 5;
const defaultRowHeight = 73;
let virtualRowHeight = defaultRowHeight;
let virtualStart = 0;
let virtualEnd = 0;
let virtualRows = new Map();
let topSpacer = null;
let bottomSpacer = null;
let virtualRenderFrame = null;
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 200;

// Tool colors
const TOOL_COLORS = {
    claude: '#a78bfa',
    cursor: '#60a5fa',
    aider: '#4ade80',
    codex: '#facc15',
    gemini: '#f87171',
    opencode: '#fb923c'
};

// Tool icons
const TOOL_ICONS = {
    claude: '🟣',
    cursor: '🔵',
    aider: '🟢',
    codex: '🟡',
    gemini: '🔴',
    opencode: '🟠'
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadLeaderboard();
});

function setupEventListeners() {
    // Search
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');

    searchBtn.addEventListener('click', () => {
        clearTimeout(searchDebounceTimer);
        handleSearch();
    });
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(searchDebounceTimer);
            handleSearch();
        }
    });
    // Debounced input search
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(handleSearch, SEARCH_DEBOUNCE_MS);
    });

    // Tool filters
    document.querySelectorAll('.tool-filter').forEach(btn => {
        btn.addEventListener('click', () => handleToolFilter(btn));
    });

    // Load more
    document.getElementById('loadMoreBtn').addEventListener('click', loadMore);

    // Recalculate the bounded row window as the page viewport moves.
    window.addEventListener('scroll', scheduleVirtualRender, { passive: true });
    window.addEventListener('resize', scheduleVirtualRender);
}

async function loadLeaderboard() {
    try {
        // Try to load from baked-in JSON first (faster, always available)
        const response = await fetch('/leaderboard.json');
        if (!response.ok) throw new Error('Failed to load leaderboard');

        leaderboardData = await response.json();
        applyFilters();
        updateStats();
    } catch (error) {
        console.error('Error loading leaderboard:', error);
        showNoResults('Failed to load leaderboard data');
    }
}

function handleSearch() {
    const query = document.getElementById('searchInput').value.trim();
    const resultDiv = document.getElementById('searchResult');

    if (!query) {
        resultDiv.innerHTML = '';
        return;
    }

    if (!leaderboardData) {
        resultDiv.innerHTML = '<div class="user-result-card">Loading leaderboard data...</div>';
        return;
    }

    // Search for substring matches (case-insensitive)
    const queryLower = query.toLowerCase();
    const matchingUsers = leaderboardData.rankings.filter(u =>
        u.username.toLowerCase().includes(queryLower)
    ).sort((a, b) => a.rank - b.rank); // Sort by rank ascending

    if (matchingUsers.length > 0) {
        // Show top 10 results
        const topResults = matchingUsers.slice(0, 10);
        showMultipleUserResults(topResults, matchingUsers.length, resultDiv);
    } else {
        showGenerateReportOption(query, resultDiv);
    }
}

function showUserResult(user, container) {
    const totalCommits = user.by_tool || {};
    const toolMix = generateToolMix(totalCommits);

    container.innerHTML = `
        <div class="user-result-card">
            <div class="user-result-header">
                <img src="${user.avatar_url}" alt="${user.username}" class="user-result-avatar" width="60" height="60" onerror="this.style.display='none'">
                <div class="user-result-info">
                    <h3>
                        <a href="${user.profile_url}" target="_blank" rel="noopener">${user.username}</a>
                    </h3>
                    <div class="rank">#${user.rank} of ${leaderboardData.rankings.length.toLocaleString()}</div>
                </div>
            </div>
            <div class="user-result-stats">
                <div class="stat-item">
                    <div class="stat-label">30 Days</div>
                    <div class="stat-value">${user.commits_30d?.toLocaleString() || '0'}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Total</div>
                    <div class="stat-value">${user.commit_count.toLocaleString()}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Repos</div>
                    <div class="stat-value">${user.unique_repos}</div>
                </div>
            </div>
            ${toolMix ? `
            <div style="margin-top: 1rem;">
                <div class="tool-mix" title="${getMixTooltip(totalCommits)}">${toolMix}</div>
            </div>
            ` : ''}
        </div>
    `;
}

function showMultipleUserResults(users, totalCount, container) {
    const resultsList = users.map(user => {
        const totalCommits = user.by_tool || {};
        const toolMix = generateToolMix(totalCommits);
        return `
            <div class="user-result-card user-result-card-compact">
                <div class="user-result-header">
                    <img src="${user.avatar_url}" alt="${user.username}" class="user-result-avatar" width="60" height="60" onerror="this.style.display='none'">
                    <div class="user-result-info">
                        <h3>
                            <a href="${user.profile_url}" target="_blank" rel="noopener">${user.username}</a>
                        </h3>
                        <div class="rank">#${user.rank} of ${leaderboardData.rankings.length.toLocaleString()}</div>
                    </div>
                </div>
                <div class="user-result-stats">
                    <div class="stat-item">
                        <div class="stat-label">30 Days</div>
                        <div class="stat-value">${user.commits_30d?.toLocaleString() || '0'}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Total</div>
                        <div class="stat-value">${user.commit_count.toLocaleString()}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Repos</div>
                        <div class="stat-value">${user.unique_repos}</div>
                    </div>
                </div>
                ${toolMix ? `
                <div style="margin-top: 0.5rem;">
                    <div class="tool-mix" title="${getMixTooltip(totalCommits)}">${toolMix}</div>
                </div>
                ` : ''}
            </div>
        `;
    }).join('');

    const showingMore = totalCount > users.length;
    const moreText = showingMore ? `<div class="search-results-more">and ${totalCount - users.length} more...</div>` : '';

    container.innerHTML = `
        <div class="search-results-list">
            ${resultsList}
            ${moreText}
        </div>
    `;
}

function showGenerateReportOption(username, container) {
    // Validate avatar exists
    const avatarUrl = `https://github.com/${username}.png`;

    container.innerHTML = `
        <div class="user-result-card">
            <div class="user-result-header">
                <img src="${avatarUrl}" alt="${username}" class="user-result-avatar" width="60" height="60" onerror="this.parentElement.innerHTML='<div class=\\\"user-result-avatar\\\"></div>'">
                <div class="user-result-info">
                    <h3>${username}</h3>
                    <div class="not-found">Not on the leaderboard yet</div>
                </div>
            </div>
            <button class="btn-generate-report" data-username="${username}">Generate Report</button>
        </div>
    `;

    container.querySelector('.btn-generate-report').addEventListener('click', () => {
        window.ReportGenerator.generate(username);
    });
}

function handleToolFilter(btn) {
    // Update active state
    document.querySelectorAll('.tool-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Update filter
    currentToolFilter = btn.dataset.tool;
    applyFilters();
}

function applyFilters() {
    if (!leaderboardData) return;

    let data = [...leaderboardData.rankings];

    // Apply tool filter
    if (currentToolFilter !== 'all') {
        data = data.filter(user => {
            const toolData = user.by_tool || {};
            return toolData[currentToolFilter] > 0;
        });
    }

    filteredData = data;
    resetVirtualRows();
    currentPage = 1;
    renderLeaderboard();
}

function renderLeaderboard() {
    const tbody = document.getElementById('leaderboardBody');

    if (filteredData.length === 0) {
        resetVirtualRows();
        tbody.innerHTML = '<tr><td colspan="6" class="no-results">No users found for this filter</td></tr>';
        updateLoadMoreButton();
        return;
    }

    // The loaded page is still capped by Load More, but the DOM is capped by
    // the viewport window inside that page.
    if (loadedCount === 0) {
        loadedCount = Math.min(pageSize, filteredData.length);
    }
    loadedCount = Math.min(loadedCount, filteredData.length);
    currentPage = Math.ceil(loadedCount / pageSize);

    updateVirtualWindow();
    updateLoadMoreButton();
}

function resetVirtualRows() {
    if (virtualRenderFrame !== null) {
        window.cancelAnimationFrame(virtualRenderFrame);
        virtualRenderFrame = null;
    }

    virtualStart = 0;
    virtualEnd = 0;
    loadedCount = 0;
    virtualRows = new Map();
    topSpacer = null;
    bottomSpacer = null;

    const tbody = document.getElementById('leaderboardBody');
    if (tbody) tbody.replaceChildren();
}

function updateLoadMoreButton() {
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (!loadMoreBtn) return;

    loadMoreBtn.style.display = loadedCount < filteredData.length ? 'inline-block' : 'none';
}

function scheduleVirtualRender() {
    if (virtualRenderFrame !== null) return;

    virtualRenderFrame = window.requestAnimationFrame(() => {
        virtualRenderFrame = null;
        updateVirtualWindow();
    });
}

function getVirtualRange(tbody) {
    const bodyTop = tbody.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
    const scrollTop = Math.max(0, (window.scrollY || window.pageYOffset || 0) - bodyTop);
    const viewportHeight = Math.max(window.innerHeight || 0, virtualRowHeight);
    const firstVisible = Math.floor(scrollTop / virtualRowHeight);
    const visibleRows = Math.ceil(viewportHeight / virtualRowHeight);

    return {
        start: Math.max(0, firstVisible - virtualOverscan),
        end: Math.min(
            loadedCount,
            firstVisible + visibleRows + virtualOverscan
        )
    };
}

function createVirtualSpacer(className, height) {
    const row = document.createElement('tr');
    row.className = `leaderboard-virtual-spacer ${className}`;
    row.setAttribute('aria-hidden', 'true');

    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.style.height = `${Math.max(0, height)}px`;
    cell.style.padding = '0';
    cell.style.border = '0';
    cell.style.lineHeight = '0';
    cell.textContent = '';
    row.appendChild(cell);

    return row;
}

function setVirtualSpacerHeight(spacer, height) {
    if (spacer?.firstElementChild) {
        spacer.firstElementChild.style.height = `${Math.max(0, height)}px`;
    }
}

function createLeaderboardRow(index) {
    const template = document.createElement('template');
    template.innerHTML = renderUserRow(filteredData[index]).trim();
    const row = template.content.firstElementChild;
    row.dataset.virtualIndex = index;
    return row;
}

function renderVirtualWindow(start, end) {
    const tbody = document.getElementById('leaderboardBody');
    const fragment = document.createDocumentFragment();
    const nextRows = new Map();

    topSpacer = createVirtualSpacer('virtual-spacer-top', start * virtualRowHeight);
    fragment.appendChild(topSpacer);

    for (let index = start; index < end; index++) {
        const row = createLeaderboardRow(index);
        nextRows.set(index, row);
        fragment.appendChild(row);
    }

    bottomSpacer = createVirtualSpacer(
        'virtual-spacer-bottom',
        (loadedCount - end) * virtualRowHeight
    );
    fragment.appendChild(bottomSpacer);

    // This replaces only the bounded viewport window, never the full loaded
    // slice. Load More can therefore extend the existing window incrementally.
    tbody.replaceChildren(fragment);
    virtualRows = nextRows;
    virtualStart = start;
    virtualEnd = end;
}

function syncVirtualWindow(start, end) {
    if (!topSpacer || !bottomSpacer) {
        renderVirtualWindow(start, end);
        return;
    }

    if (start === virtualStart && end === virtualEnd) {
        setVirtualSpacerHeight(topSpacer, start * virtualRowHeight);
        setVirtualSpacerHeight(bottomSpacer, (loadedCount - end) * virtualRowHeight);
        return;
    }

    const overlaps = start < virtualEnd && end > virtualStart;
    if (!overlaps) {
        renderVirtualWindow(start, end);
        return;
    }

    const previousStart = virtualStart;
    const previousEnd = virtualEnd;

    // Discard rows that scrolled out of the window.
    for (let index = previousStart; index < Math.min(start, previousEnd); index++) {
        virtualRows.get(index)?.remove();
        virtualRows.delete(index);
    }
    for (let index = Math.max(end, previousStart); index < previousEnd; index++) {
        virtualRows.get(index)?.remove();
        virtualRows.delete(index);
    }

    // Add rows entering at the top/bottom without touching rows that remain.
    if (start < previousStart) {
        const fragment = document.createDocumentFragment();
        for (let index = start; index < previousStart; index++) {
            const row = createLeaderboardRow(index);
            virtualRows.set(index, row);
            fragment.appendChild(row);
        }
        tbody.insertBefore(fragment, virtualRows.get(previousStart) || bottomSpacer);
    }

    if (end > previousEnd) {
        const fragment = document.createDocumentFragment();
        for (let index = previousEnd; index < end; index++) {
            const row = createLeaderboardRow(index);
            virtualRows.set(index, row);
            fragment.appendChild(row);
        }
        tbody.insertBefore(fragment, bottomSpacer);
    }

    virtualStart = start;
    virtualEnd = end;
    setVirtualSpacerHeight(topSpacer, start * virtualRowHeight);
    setVirtualSpacerHeight(bottomSpacer, (loadedCount - end) * virtualRowHeight);
}

function updateVirtualWindow() {
    const tbody = document.getElementById('leaderboardBody');
    if (!tbody || loadedCount === 0) return;

    const range = getVirtualRange(tbody);
    syncVirtualWindow(range.start, range.end);

    // Account for responsive/font changes instead of relying solely on the
    // initial estimate. All rows use the same layout, so one measurement is
    // enough to keep the spacer offsets accurate.
    const firstRow = virtualRows.values().next().value;
    const measuredHeight = firstRow?.getBoundingClientRect().height || 0;
    if (measuredHeight > 0 && Math.abs(measuredHeight - virtualRowHeight) > 0.5) {
        virtualRowHeight = measuredHeight;
        const updatedRange = getVirtualRange(tbody);
        syncVirtualWindow(updatedRange.start, updatedRange.end);
    }
}

function renderUserRow(user) {
    const totalCommits = user.by_tool || {};
    const toolMix = generateToolMix(totalCommits);

    return `
        <tr>
            <td class="col-rank">#${user.rank}</td>
            <td class="col-user">
                <img src="${user.avatar_url}" alt="" class="user-avatar" loading="lazy" onerror="this.style.display='none'">
                <a href="${user.profile_url}" target="_blank" rel="noopener" class="user-link">${user.username}</a>
            </td>
            <td class="col-tools">
                <div class="tool-mix" title="${getMixTooltip(totalCommits)}">${toolMix}</div>
            </td>
            <td class="col-commits-30d">${user.commits_30d?.toLocaleString() || '0'}</td>
            <td class="col-commits-total">${user.commit_count.toLocaleString()}</td>
            <td class="col-repos">${user.unique_repos}</td>
        </tr>
    `;
}

function generateToolMix(toolData) {
    const total = Object.values(toolData).reduce((sum, count) => sum + count, 0);
    if (total === 0) return '<span style="font-size:0.8rem;color:var(--text-muted)">No data</span>';

    const sortedTools = Object.entries(toolData)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

    return sortedTools.map(([tool, count]) => {
        const percentage = (count / total) * 100;
        return `<div class="tool-mix-segment ${tool}" style="width: ${percentage}%"></div>`;
    }).join('');
}

function getMixTooltip(toolData) {
    const entries = Object.entries(toolData)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

    return entries.map(([tool, count]) => {
        const icon = TOOL_ICONS[tool] || '⬜';
        return `${icon} ${tool.charAt(0).toUpperCase() + tool.slice(1)}: ${count.toLocaleString()}`;
    }).join('\n');
}

function updateStats() {
    if (!leaderboardData) return;

    // Calculate totals from rankings
    const totalCommits = leaderboardData.rankings.reduce((sum, u) => sum + u.commit_count, 0);
    const uniqueRepos = new Set();
    leaderboardData.rankings.forEach(u => {
        (u.recent_repos || []).forEach(repo => uniqueRepos.add(repo));
    });

    document.getElementById('totalUsers').textContent = `${leaderboardData.rankings.length.toLocaleString()} users`;
    document.getElementById('totalCommits').textContent = `${totalCommits.toLocaleString()} commits`;
    document.getElementById('totalRepos').textContent = `${uniqueRepos.size.toLocaleString()} repos`;
}

function loadMore() {
    if (loadedCount >= filteredData.length) return;

    const previousCount = loadedCount;
    loadedCount = Math.min(loadedCount + pageSize, filteredData.length);
    currentPage = Math.ceil(loadedCount / pageSize);

    if (loadedCount === previousCount) return;

    updateVirtualWindow();
    updateLoadMoreButton();
}

function showNoResults(message) {
    const tbody = document.getElementById('leaderboardBody');
    tbody.innerHTML = `<tr><td colspan="6" class="no-results">${message}</td></tr>`;
}
