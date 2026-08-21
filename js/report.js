// Report Generator Module
window.ReportGenerator = (function() {
    const modal = document.getElementById('reportModal');
    const modalContent = document.getElementById('reportContent');
    const closeBtn = document.getElementById('closeModal');
    let eventSource = null;

    // Setup modal close
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    function closeModal() {
        modal.classList.remove('active');
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    async function checkApiReachability() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        try {
            const response = await fetch(`${getApiBaseUrl()}/health`, {
                method: 'HEAD',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response.ok || response.status === 404; // 404 means health endpoint doesn't exist but server is reachable
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                return false; // Timeout
            }
            return false; // Network error
        }
    }

    async function generate(username) {
        // Check API reachability first
        const isReachable = await checkApiReachability();
        if (!isReachable) {
            showError('Report generation is temporarily unavailable. The API service is currently unreachable.');
            return;
        }

        // Open modal
        modal.classList.add('active');
        modalContent.innerHTML = `
            <div class="progress-section">
                <div class="progress-header">
                    <div class="progress-title">Generating Report for ${username}</div>
                    <div class="progress-subtitle">Connecting to API...</div>
                </div>
            </div>
        `;

        try {
            // Start SSE stream
            const apiUrl = getApiUrl(username);
            eventSource = new EventSource(apiUrl);

            eventSource.addEventListener('queued', handleQueued);
            eventSource.addEventListener('started', handleStarted);
            eventSource.addEventListener('scanning', handleScanning);
            eventSource.addEventListener('scanned', handleScanned);
            eventSource.addEventListener('complete', handleComplete);
            eventSource.addEventListener('error', handleError);

            // Also request the report (triggers generation if not cached)
            await fetch(`${getApiBaseUrl()}/report/${username}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            showError(error.message);
        }
    }

    function getApiBaseUrl() {
        return window.location.hostname === 'localhost'
            ? 'http://localhost:8080'
            : `https://api.${window.location.hostname.replace(/^www\./, '')}`;
    }

    function getApiUrl(username) {
        return `${getApiBaseUrl()}/report/${username}/stream`;
    }

    function handleQueued(e) {
        const data = JSON.parse(e.data);
        modalContent.innerHTML = `
            <div class="progress-section">
                <div class="progress-header">
                    <div class="progress-title">Your Report is Queued</div>
                    <div class="progress-subtitle">Position: ${data.position} · Est. wait: ${data.estimated_wait_seconds}s</div>
                </div>
                <div class="repo-status scanning">⟳</div>
                <p style="color:var(--text-secondary);margin-top:1rem;">
                    Please wait while we process reports ahead of yours...
                </p>
            </div>
        `;
    }

    function handleStarted(e) {
        const data = JSON.parse(e.data);
        modalContent.innerHTML = `
            <div class="progress-section">
                <div class="progress-header">
                    <div class="progress-title">Scanning ${data.repos_found} Repos</div>
                    <div class="progress-subtitle">This may take a moment for large accounts...</div>
                </div>
                <div class="overall-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <div class="progress-text">0 / ${data.repos_found} repos scanned</div>
                </div>
                <div class="repo-list-progress" id="repoListProgress">
                    <div class="progress-subtitle">Starting scan...</div>
                </div>
            </div>
        `;
    }

    function handleScanning(e) {
        const data = JSON.parse(e.data);
        const repoList = document.getElementById('repoListProgress');
        if (!repoList) return;

        // Add pending repos if not already added
        if (!repoList.querySelector(`[data-repo="${data.repo}"]`)) {
            const existing = repoList.querySelectorAll('.repo-progress-item');

            // Add scanning item
            const scanningItem = document.createElement('div');
            scanningItem.className = 'repo-progress-item';
            scanningItem.dataset.repo = data.repo;
            scanningItem.innerHTML = `
                <div class="repo-status scanning">⟳</div>
                <div class="repo-info">
                    <div class="repo-name-progress">${data.repo}</div>
                    <div class="repo-commits-found">Scanning...</div>
                </div>
            `;
            repoList.appendChild(scanningItem);

            // Add pending placeholders
            for (let i = data.index; i < data.total; i++) {
                const pendingItem = document.createElement('div');
                pendingItem.className = 'repo-progress-item';
                pendingItem.innerHTML = `
                    <div class="repo-status pending">○</div>
                    <div class="repo-info">
                        <div class="repo-name-progress">Repo #${i + 1}</div>
                        <div class="repo-commits-found">Pending</div>
                    </div>
                `;
                repoList.appendChild(pendingItem);
            }

            // Scroll to bottom
            repoList.scrollTop = repoList.scrollHeight;
        }
    }

    function handleScanned(e) {
        const data = JSON.parse(e.data);
        const repoList = document.getElementById('repoListProgress');
        if (!repoList) return;

        const item = repoList.querySelector(`[data-repo="${data.repo}"]`);
        if (item) {
            const tools = Object.entries(data.tools || {})
                .filter(([_, count]) => count > 0)
                .map(([tool, count]) => `${TOOL_ICONS[tool] || '⬜'} ${count}`)
                .join(' · ');

            item.innerHTML = `
                <div class="repo-status done">✓</div>
                <div class="repo-info">
                    <div class="repo-name-progress">${data.repo}</div>
                    <div class="repo-commits-found">${data.commits_found} commits ${tools ? '· ' + tools : ''}</div>
                </div>
            `;

            // Update progress bar
            const progressBar = document.querySelector('.progress-fill');
            const progressText = document.querySelector('.progress-text');
            if (progressBar && progressText) {
                const total = parseInt(progressText.textContent.match(/\/ (\d+)/)[1]);
                const completed = repoList.querySelectorAll('.repo-status.done').length;
                const percentage = (completed / total) * 100;
                progressBar.style.width = `${percentage}%`;
                progressText.textContent = `${completed} / ${total} repos scanned`;
            }
        }
    }

    function handleComplete(e) {
        const data = JSON.parse(e.data);

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        showReport(data);
    }

    function handleError(e) {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        showError('Report generation failed. Please try again.');
    }

    function showError(message) {
        // Reachability is checked before opening the modal, so make failures
        // visible when the API goes down between the check and the click.
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        modal.classList.add('active');
        modalContent.innerHTML = `
            <div class="progress-section">
                <div class="repo-status error">✕</div>
                <div class="progress-title" style="color:var(--error);margin-top:1rem;">Error</div>
                <div class="progress-subtitle">${message}</div>
                <button class="btn-generate-report" style="margin-top:1.5rem;" onclick="document.getElementById('reportModal').classList.remove('active')">Close</button>
            </div>
        `;
    }

    function showReport(data) {
        const topReposHtml = data.top_repos?.map(repo => {
            const tools = (repo.tools || {})
                .map(tool => TOOL_ICONS[tool] || '⬜')
                .join(' ');

            return `
                <div class="repo-item">
                    <div>
                        <div class="repo-name">${repo.repo}</div>
                        <div class="repo-tools">${tools}</div>
                    </div>
                    <div class="repo-commits">${repo.commits} commits</div>
                </div>
            `;
        }).join('') || '<div class="no-results">No repos found</div>';

        const toolsBreakdown = Object.entries(data.by_tool || {})
            .sort((a, b) => b[1] - a[1])
            .map(([tool, count]) => {
                const percentage = ((count / data.total_commits) * 100).toFixed(1);
                return `
                    <div class="tool-bar-wrapper">
                        <div class="tool-name">${TOOL_ICONS[tool] || '⬜'} ${tool.charAt(0).toUpperCase() + tool.slice(1)}</div>
                        <div class="tool-bar">
                            <div class="tool-bar-fill ${tool}" style="width: ${percentage}%">${count} (${percentage}%)</div>
                        </div>
                    </div>
                `;
            }).join('');

        const sparklineHtml = data.sparkline_30d?.map(count => {
            const max = Math.max(...data.sparkline_30d);
            const height = max > 0 ? (count / max) * 100 : 0;
            return `<div class="sparkline-bar" style="height: ${height}%"></div>`;
        }).join('') || '<div class="no-results">No recent activity</div>';

        modalContent.innerHTML = `
            <div class="report-header">
                <img src="https://github.com/${data.username || 'unknown'}.png" alt="" class="report-avatar" onerror="this.style.display='none'">
                <div class="report-title">
                    <h2>${data.username || 'Unknown'}</h2>
                    <span class="report-badge">#${data.rank} of ${data.total_ranked?.toLocaleString() || 'N/A'}</span>
                </div>
            </div>
            <div class="report-body">
                <div style="text-align:center;margin-bottom:2rem;">
                    <div style="font-size:2.5rem;font-weight:700;color:var(--accent-purple);">
                        Top ${((data.percentile || 0) * 100).toFixed(1)}%
                    </div>
                    <div style="color:var(--text-secondary);">
                        ${data.total_commits?.toLocaleString() || '0'} commits · ${data.repos_with_commits || 0} repos
                    </div>
                </div>

                <div class="report-section">
                    <h3>Tools Used</h3>
                    <div class="tools-breakdown">
                        ${toolsBreakdown || '<div class="no-results">No tools detected</div>'}
                    </div>
                </div>

                <div class="report-section">
                    <h3>30-Day Activity</h3>
                    <div class="sparkline">${sparklineHtml}</div>
                </div>

                <div class="report-section">
                    <h3>Top Repos</h3>
                    <div class="repo-list">
                        ${topReposHtml}
                    </div>
                </div>

                ${data.first_ai_commit ? `
                <div class="report-section">
                    <h3>First AI Commit</h3>
                    <div style="color:var(--text-secondary);">${new Date(data.first_ai_commit).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                </div>
                ` : ''}

                <div style="text-align:center;margin-top:2rem;">
                    <button class="btn-generate-report" onclick="window.close()">Close</button>
                </div>
            </div>
        `;
    }

    return {
        generate
    };
})();
