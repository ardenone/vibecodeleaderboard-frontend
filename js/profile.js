// Profile page - Shareable user report card
(function() {
    'use strict';

    // Tool icons and colors (matching app.js)
    const TOOL_ICONS = {
        claude: '🟣',
        cursor: '🔵',
        aider: '🟢',
        codex: '🟡',
        gemini: '🔴',
        opencode: '🟠'
    };

    const TOOL_COLORS = {
        claude: '#a78bfa',
        cursor: '#60a5fa',
        aider: '#4ade80',
        codex: '#facc15',
        gemini: '#f87171',
        opencode: '#fb923c'
    };

    // API configuration
    const API_BASE = window.location.hostname === 'localhost'
        ? 'http://localhost:8080'
        : `https://api.${window.location.hostname.replace(/^www\./, '')}`;

    // State
    let username = null;
    let userData = null;

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        // Extract username from URL path
        username = extractUsernameFromPath();

        if (!username) {
            showError('No username specified in URL');
            return;
        }

        // Load user data
        loadUserData(username);
    }

    function extractUsernameFromPath() {
        // Get path from URL (e.g., /u/johndoe)
        const path = window.location.pathname;

        // Handle both /u/username and /username formats
        const match = path.match(/^\/u\/([^\/]+)$/) || path.match(/^\/([^\/]+)$/);

        if (match) {
            return match[1];
        }

        return null;
    }

    async function loadUserData(username) {
        try {
            updateMetaTags('loading', username);

            // Try to load from cached leaderboard data first
            const leaderboardData = await loadLeaderboardData();

            if (leaderboardData) {
                const user = leaderboardData.rankings.find(
                    u => u.username.toLowerCase() === username.toLowerCase()
                );

                if (user) {
                    userData = user;
                    renderProfile(user);
                    updateMetaTags('success', username, user);
                    return;
                }
            }

            // If not found in leaderboard, try API endpoint
            await loadFromAPI(username);

        } catch (error) {
            console.error('Error loading user data:', error);
            showError('Failed to load user profile');
            updateMetaTags('error', username);
        }
    }

    async function loadLeaderboardData() {
        try {
            const response = await fetch('/leaderboard.json');
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            console.error('Error loading leaderboard data:', error);
            return null;
        }
    }

    async function loadFromAPI(username) {
        try {
            const response = await fetch(`${API_BASE}/user/${username}`);

            if (!response.ok) {
                if (response.status === 404) {
                    showUserNotFound(username);
                    updateMetaTags('not_found', username);
                } else {
                    throw new Error(`API error: ${response.status}`);
                }
                return;
            }

            userData = await response.json();
            renderProfile(userData);
            updateMetaTags('success', username, userData);

        } catch (error) {
            console.error('Error loading from API:', error);
            // Fall back to showing "not found" rather than error
            showUserNotFound(username);
            updateMetaTags('not_found', username);
        }
    }

    function renderProfile(user) {
        const container = document.getElementById('profileContent');

        if (!user) {
            showUserNotFound(username);
            return;
        }

        const totalCommits = user.by_tool || {};
        const toolMix = generateToolMix(totalCommits);
        const toolBreakdown = generateToolBreakdown(totalCommits, user.commit_count);

        container.innerHTML = `
            <div class="profile-card">
                <div class="profile-header">
                    <img src="${user.avatar_url}" alt="${user.username}" class="profile-avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👤</text></svg>'">
                    <div class="profile-info">
                        <h1 class="profile-name">
                            <a href="${user.profile_url}" target="_blank" rel="noopener">${user.username}</a>
                        </h1>
                        <div class="profile-rank">#${user.rank} of ${user.total_ranked?.toLocaleString() || 'N/A'}</div>
                    </div>
                </div>

                <div class="profile-stats">
                    <div class="stat-card">
                        <div class="stat-label">30 Days</div>
                        <div class="stat-value">${user.commits_30d?.toLocaleString() || '0'}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Total Commits</div>
                        <div class="stat-value">${user.commit_count.toLocaleString()}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Repos</div>
                        <div class="stat-value">${user.unique_repos}</div>
                    </div>
                </div>

                ${toolMix ? `
                <div class="tool-mix-section">
                    <h3>Tool Mix</h3>
                    <div class="tool-mix-large" title="${getMixTooltip(totalCommits)}">${toolMix}</div>
                </div>
                ` : ''}

                ${toolBreakdown ? `
                <div class="tool-breakdown-section">
                    <h3>Tools Used</h3>
                    <div class="tool-breakdown">${toolBreakdown}</div>
                </div>
                ` : ''}

                <div class="share-section">
                    <h3>Share This Profile</h3>
                    <p>Share this URL to show off your AI-assisted coding stats:</p>
                    <div class="share-url">
                        <input type="text" value="${window.location.href}" readonly id="shareUrl">
                        <button onclick="copyShareUrl()">Copy</button>
                    </div>
                </div>

                <div class="back-to-leaderboard">
                    <a href="/">← View Full Leaderboard</a>
                </div>
            </div>
        `;
    }

    function generateToolMix(toolData) {
        const total = Object.values(toolData).reduce((sum, count) => sum + count, 0);
        if (total === 0) return null;

        const sortedTools = Object.entries(toolData)
            .filter(([_, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]);

        return sortedTools.map(([tool, count]) => {
            const percentage = (count / total) * 100;
            return `<div class="tool-mix-segment ${tool}" style="width: ${percentage}%"></div>`;
        }).join('');
    }

    function generateToolBreakdown(toolData, totalCommits) {
        const entries = Object.entries(toolData)
            .filter(([_, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]);

        if (entries.length === 0) return null;

        return entries.map(([tool, count]) => {
            const percentage = ((count / totalCommits) * 100).toFixed(1);
            return `
                <div class="tool-bar-wrapper">
                    <div class="tool-name">${TOOL_ICONS[tool] || '⬜'} ${tool.charAt(0).toUpperCase() + tool.slice(1)}</div>
                    <div class="tool-bar">
                        <div class="tool-bar-fill ${tool}" style="width: ${percentage}%">${count} (${percentage}%)</div>
                    </div>
                </div>
            `;
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

    function showUserNotFound(username) {
        const container = document.getElementById('profileContent');
        container.innerHTML = `
            <div class="profile-card not-found">
                <h2>User Not Found</h2>
                <p>The user <strong>${username}</strong> is not on the leaderboard yet.</p>
                <div class="not-found-actions">
                    <p>Want to generate a report for this user?</p>
                    <a href="/?search=${encodeURIComponent(username)}" class="btn-primary">
                        Search on Leaderboard
                    </a>
                </div>
                <div class="back-to-leaderboard">
                    <a href="/">← Back to Leaderboard</a>
                </div>
            </div>
        `;
    }

    function showError(message) {
        const container = document.getElementById('profileContent');
        container.innerHTML = `
            <div class="profile-card error">
                <h2>Error</h2>
                <p>${message}</p>
                <div class="back-to-leaderboard">
                    <a href="/">← Back to Leaderboard</a>
                </div>
            </div>
        `;
    }

    function updateMetaTags(status, username, userData = null) {
        // Update document title
        if (status === 'loading') {
            document.title = `Loading ${username}... - Vibe Code Leaderboard`;
        } else if (status === 'success' && userData) {
            document.title = `#${userData.rank} ${userData.username} - Vibe Code Leaderboard`;
        } else if (status === 'not_found') {
            document.title = `${username} Not Found - Vibe Code Leaderboard`;
        } else {
            document.title = 'Error - Vibe Code Leaderboard';
        }

        // Update OG meta tags
        const ogTitle = document.querySelector('meta[property="og:title"]');
        const ogDesc = document.querySelector('meta[property="og:description"]');
        const ogImage = document.querySelector('meta[property="og:image"]');
        const ogUrl = document.querySelector('meta[property="og:url"]');
        const twitterTitle = document.querySelector('meta[name="twitter:title"]');
        const twitterDesc = document.querySelector('meta[name="twitter:description"]');
        const twitterImage = document.querySelector('meta[name="twitter:image"]');
        const canonical = document.querySelector('link[rel="canonical"]');

        if (status === 'success' && userData) {
            const description = `${userData.username} has ${userData.commit_count.toLocaleString()} AI-assisted commits across ${userData.unique_repos} repos. Ranked #${userData.rank} on the Vibe Code Leaderboard.`;

            ogTitle?.setAttribute('content', `#${userData.rank} ${userData.username} - Vibe Code Leaderboard`);
            ogDesc?.setAttribute('content', description);
            ogImage?.setAttribute('content', generateOGImageUrl(userData));
            ogUrl?.setAttribute('content', window.location.href);
            twitterTitle?.setAttribute('content', `#${userData.rank} ${userData.username} - Vibe Code Leaderboard`);
            twitterDesc?.setAttribute('content', description);
            twitterImage?.setAttribute('content', generateOGImageUrl(userData));
            canonical?.setAttribute('href', window.location.href);
        } else if (status === 'not_found') {
            const description = `${username} is not yet on the Vibe Code Leaderboard. Check the full leaderboard to see top AI-assisted developers.`;

            ogTitle?.setAttribute('content', `${username} - Vibe Code Leaderboard`);
            ogDesc?.setAttribute('content', description);
            ogImage?.setAttribute('content', 'https://vibecodeleaderboard.com/og-image.png');
            ogUrl?.setAttribute('content', window.location.href);
            twitterTitle?.setAttribute('content', `${username} - Vibe Code Leaderboard`);
            twitterDesc?.setAttribute('content', description);
            twitterImage?.setAttribute('content', 'https://vibecodeleaderboard.com/og-image.png');
            canonical?.setAttribute('href', window.location.href);
        } else {
            // Default/loading state
            ogTitle?.setAttribute('content', 'Vibe Code Leaderboard');
            ogDesc?.setAttribute('content', 'Tracking AI-assisted coding across GitHub');
            ogImage?.setAttribute('content', 'https://vibecodeleaderboard.com/og-image.png');
            ogUrl?.setAttribute('content', window.location.href);
            twitterTitle?.setAttribute('content', 'Vibe Code Leaderboard');
            twitterDesc?.setAttribute('content', 'Tracking AI-assisted coding across GitHub');
            twitterImage?.setAttribute('content', 'https://vibecodeleaderboard.com/og-image.png');
            canonical?.setAttribute('href', window.location.href);
        }
    }

    function generateOGImageUrl(userData) {
        // Use a service to generate OG image or return default
        // For now, return the default OG image
        // In the future, this could use a service like:
        // https://api.vibecodeleaderboard.com/og/${userData.username}.png
        return 'https://vibecodeleaderboard.com/og-image.png';
    }

    // Global function for copy button
    window.copyShareUrl = function() {
        const input = document.getElementById('shareUrl');
        input.select();
        document.execCommand('copy');

        // Show feedback
        const btn = input.nextElementSibling;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    };
})();
