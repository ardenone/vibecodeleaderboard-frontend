// API Configuration
const API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:8080'
    : `https://api.${window.location.hostname.replace(/^www\./, '')}`;

// State
let leaderboardData = null;
let filteredData = [];
let currentToolFilter = 'all';
let currentPage = 1;
const pageSize = 50;

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

    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });

    // Tool filters
    document.querySelectorAll('.tool-filter').forEach(btn => {
        btn.addEventListener('click', () => handleToolFilter(btn));
    });

    // Load more
    document.getElementById('loadMoreBtn').addEventListener('click', loadMore);
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

    // Search in current leaderboard
    const user = leaderboardData.rankings.find(u =>
        u.username.toLowerCase() === query.toLowerCase()
    );

    if (user) {
        showUserResult(user, resultDiv);
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
                <img src="${user.avatar_url}" alt="${user.username}" class="user-result-avatar" onerror="this.style.display='none'">
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

function showGenerateReportOption(username, container) {
    // Validate avatar exists
    const avatarUrl = `https://github.com/${username}.png`;

    container.innerHTML = `
        <div class="user-result-card">
            <div class="user-result-header">
                <img src="${avatarUrl}" alt="${username}" class="user-result-avatar" onerror="this.parentElement.innerHTML='<div class=\\\"user-result-avatar\\\"></div>'">
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
    currentPage = 1;
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
    renderLeaderboard();
}

function renderLeaderboard() {
    const tbody = document.getElementById('leaderboardBody');
    const loadMoreBtn = document.getElementById('loadMoreBtn');

    if (filteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="no-results">No users found for this filter</td></tr>';
        loadMoreBtn.style.display = 'none';
        return;
    }

    const start = 0;
    const end = currentPage * pageSize;
    const pageData = filteredData.slice(start, end);

    tbody.innerHTML = pageData.map(user => renderUserRow(user)).join('');

    // Show/hide load more
    loadMoreBtn.style.display = end < filteredData.length ? 'inline-block' : 'none';
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
    currentPage++;
    renderLeaderboard();
}

function showNoResults(message) {
    const tbody = document.getElementById('leaderboardBody');
    tbody.innerHTML = `<tr><td colspan="6" class="no-results">${message}</td></tr>`;
}
