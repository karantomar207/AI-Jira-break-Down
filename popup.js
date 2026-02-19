/**
 * popup.js — Main logic for the Jira AI Breakdown Chrome Extension.
 *
 * Directly calls:
 *   - Groq API (LLaMA 3.3-70B) for AI generation
 *   - Jira REST API for issue/subtask creation
 *
 * No backend server needed. Credentials stored in chrome.storage.sync.
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────
let currentAiOutput = null;
let currentSettings = {};
let activeTab = 'breakdown';

// ─── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await detectJiraContext();
    bindEvents();
});

async function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(
            ['groq_key', 'jira_url', 'jira_email', 'jira_token'],
            (data) => {
                currentSettings = data;
                const hasAll = data.groq_key && data.jira_url && data.jira_email && data.jira_token;
                if (!hasAll) {
                    document.getElementById('no-creds-warning').style.display = 'block';
                }
                resolve();
            }
        );
    });
}

async function detectJiraContext() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;

        const url = tab.url;
        const browseMatch = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
        const projectMatch = url.match(/\/jira\/software\/projects\/([A-Z][A-Z0-9]+)/);

        if (browseMatch) {
            const issueKey = browseMatch[1];
            const projectKey = issueKey.split('-')[0];
            document.getElementById('bd-story-key').value = issueKey;
            document.getElementById('bd-project-key').value = projectKey;
            document.getElementById('cr-project-key').value = projectKey;
            document.getElementById('page-context').textContent = `📍 ${issueKey}`;
            // Auto-load all project metadata in parallel
            if (currentSettings.jira_url) loadAllProjectData(projectKey);
        } else if (projectMatch) {
            const projectKey = projectMatch[1];
            document.getElementById('bd-project-key').value = projectKey;
            document.getElementById('cr-project-key').value = projectKey;
            document.getElementById('page-context').textContent = `📁 ${projectKey}`;
            if (currentSettings.jira_url) loadAllProjectData(projectKey);
        } else if (url.includes('atlassian.net')) {
            document.getElementById('page-context').textContent = '🔗 Jira detected';
        } else {
            document.getElementById('page-context').textContent = 'Open a Jira page';
        }
    } catch {
        document.getElementById('page-context').textContent = 'Open a Jira page';
    }
}

function bindEvents() {
    // Tab switching
    document.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab;
            document.getElementById('tab-breakdown').style.display = activeTab === 'breakdown' ? 'block' : 'none';
            document.getElementById('tab-create').style.display = activeTab === 'create' ? 'block' : 'none';
            hidePreview();
            hideResult();
        });
    });

    // Generate buttons
    document.getElementById('bd-generate-btn').addEventListener('click', onBreakdownGenerate);
    document.getElementById('cr-generate-btn').addEventListener('click', onCreateGenerate);

    // Confirm button
    document.getElementById('confirm-btn').addEventListener('click', onConfirm);

    // Settings button
    document.getElementById('settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Open settings link in warning
    const openSettings = document.getElementById('open-settings-link');
    if (openSettings) {
        openSettings.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
    }

    // Copy JSON
    document.getElementById('copy-json-btn').addEventListener('click', () => {
        if (currentAiOutput) {
            navigator.clipboard.writeText(JSON.stringify(currentAiOutput, null, 2))
                .then(() => showToast('JSON copied!', 'success'));
        }
    });

    // Advanced options toggle
    document.getElementById('adv-toggle').addEventListener('click', () => {
        const sec = document.getElementById('adv-section');
        const icon = document.getElementById('adv-toggle-icon');
        const open = sec.style.display === 'none';
        sec.style.display = open ? 'block' : 'none';
        icon.textContent = open ? '▼' : '▶';
    });

    // Load project data when project key is typed manually (600ms debounce)
    let pkeyTimer;
    const onProjectKeyChange = (e) => {
        const key = e.target.value.trim().toUpperCase();
        document.getElementById('bd-project-key').value = key;
        document.getElementById('cr-project-key').value = key;
        clearTimeout(pkeyTimer);
        if (key.length >= 2 && currentSettings.jira_url) {
            pkeyTimer = setTimeout(() => loadAllProjectData(key), 600);
        }
    };
    document.getElementById('bd-project-key').addEventListener('input', onProjectKeyChange);
    document.getElementById('cr-project-key').addEventListener('input', onProjectKeyChange);
}

// ─── Load Project Data (Types, Statuses, Users, Priorities) ─────────────────

const _projectCache = {};

async function loadAllProjectData(projectKey) {
    if (!projectKey) return;

    // UI Elements
    const breakTypeSelect = document.getElementById('bd-break-type');
    const statusSelect = document.getElementById('bd-status');
    const prioritySelect = document.getElementById('bd-priority');
    const assigneeSelect = document.getElementById('bd-assignee');
    const crTypeSelect = document.getElementById('cr-issue-type');

    // Helper: set loading state
    const setL = (el) => { if (el) { el.disabled = true; el.innerHTML = '<option>Loading...</option>'; } };
    const selects = [breakTypeSelect, statusSelect, prioritySelect, assigneeSelect, crTypeSelect];
    selects.forEach(setL);

    try {
        // Fetch all independently so failure doesn't block UI
        const [typesWait, statusWait, usersWait, prioritiesWait] = await Promise.allSettled([
            fetchProjectIssueTypes(projectKey),
            fetchProjectStatuses(projectKey),
            fetchAssignableUsers(projectKey),
            fetchPriorities()
        ]);

        // 1. Issue Types (Critical)
        if (typesWait.status === 'fulfilled') {
            const types = typesWait.value;
            populateDropdown(breakTypeSelect, types.all, 'name', 'name', 'Select type...', types.subtaskType);
            populateDropdown(crTypeSelect, types.parentTypes, 'name', 'name', 'Story');
            // Update badge
            const badge = document.getElementById('bd-types-badge');
            if (badge && types.subtaskType) {
                badge.textContent = `Default: ${types.subtaskType}`;
                badge.style.display = 'inline-block';
            }
        } else {
            // Fallback: try to detect at least the subtask type via probing
            let fallbackName = 'Subtask';
            try {
                fallbackName = await detectSubtaskTypeName(projectKey);
            } catch (e) {
                console.warn('[JiraAI] Fallback detection also failed:', e);
            }

            if (breakTypeSelect) {
                breakTypeSelect.innerHTML = `<option value="${escHtml(fallbackName)}" selected>${escHtml(fallbackName)} (Detected)</option>`;
            }
            if (crTypeSelect) {
                crTypeSelect.innerHTML = '<option value="Story" selected>Story</option><option value="Task">Task</option><option value="Bug">Bug</option>';
            }
        }

        // 2. Statuses
        if (statusWait.status === 'fulfilled') {
            populateDropdown(statusSelect, statusWait.value, 'name', 'name', 'No change', '');
        } else {
            console.warn('[JiraAI] Statuses failed:', statusWait.reason);
            if (statusSelect) statusSelect.innerHTML = '<option value="">(Default)</option>';
        }

        // 3. Assignees (Common failure point if permissions missing)
        if (usersWait.status === 'fulfilled') {
            populateDropdown(assigneeSelect, usersWait.value, 'accountId', 'displayName', 'Unassigned', '');
        } else {
            console.warn('[JiraAI] Users failed:', usersWait.reason);
            if (assigneeSelect) assigneeSelect.innerHTML = '<option value="">(Assignable users unavailable)</option>';
        }

        // 4. Priorities
        if (prioritiesWait.status === 'fulfilled') {
            populateDropdown(prioritySelect, prioritiesWait.value, 'name', 'name', 'Default', '');
        } else {
            console.warn('[JiraAI] Priorities failed:', prioritiesWait.reason);
            if (prioritySelect) prioritySelect.innerHTML = '<option value="">(Default)</option>';
        }

    } catch (err) {
        console.error('[JiraAI] Critical error in loadAllProjectData:', err);
    } finally {
        selects.forEach(el => { if (el) el.disabled = false; });
    }
}

// ─── Fetchers ───

async function fetchProjectIssueTypes(projectKey) {
    if (_issueTypeCache[projectKey]) return _issueTypeCache[projectKey];
    const data = await jiraRequest('GET', `issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`);
    const proj = (data.projects || []).find(p => p.key === projectKey);
    const all = proj ? (proj.issuetypes || []) : [];

    if (!all.length) throw new Error('No issue types');

    const parentTypes = all.filter(t => !t.subtask);
    const subtaskTypes = all.filter(t => t.subtask);
    const subtaskType = subtaskTypes[0]?.name || 'Subtask';

    const result = { parentTypes, subtaskTypes, subtaskType, all };
    _issueTypeCache[projectKey] = result;
    // Also update the subtask cache for create function
    _subtaskTypeCache[projectKey] = subtaskType;

    return result;
}

async function fetchProjectStatuses(projectKey) {
    // GET /rest/api/3/project/{projectIdOrKey}/statuses
    // Returns nested structure -> issueTypes -> statuses
    // We just want a unique list of all possible statuses for simplicity
    const data = await jiraRequest('GET', `project/${projectKey}/statuses`);
    const statusMap = new Map();
    data.forEach(type => {
        type.statuses.forEach(s => {
            statusMap.set(s.name, s);
        });
    });
    return Array.from(statusMap.values());
}

async function fetchAssignableUsers(projectKey) {
    // GET /rest/api/3/user/assignable/search?project={projectKey}
    return jiraRequest('GET', `user/assignable/search?project=${projectKey}`);
}

async function fetchPriorities() {
    return jiraRequest('GET', `priority`);
}

// ─── Helper ───

function populateDropdown(select, items, valueKey, labelKey, defaultLabel, defaultValue = '') {
    if (!select) return;
    let html = '';
    if (defaultLabel) {
        html += `<option value="${defaultValue}">${defaultLabel}</option>`;
    }
    html += items.map(item => {
        const val = item[valueKey];
        const lab = item[labelKey];
        // optional icon
        const iconUrl = item.iconUrl;
        // simple text for now
        return `<option value="${escHtml(val)}">${escHtml(lab)}</option>`;
    }).join('');
    select.innerHTML = html;
}

// ─── Breakdown Flow ─────────────────────────────────────────────────────────

async function onBreakdownGenerate() {
    if (!validateSettings()) return;

    const storyKey = document.getElementById('bd-story-key').value.trim().toUpperCase();
    const projectKey = document.getElementById('bd-project-key').value.trim().toUpperCase();
    const numSubtasks = parseInt(document.getElementById('bd-num-subtasks').value, 10) || 5;
    const breakType = document.getElementById('bd-break-type').value || null;

    // Advanced Optional fields
    const jiraStatus = document.getElementById('bd-status').value || '';
    const priority = document.getElementById('bd-priority').value || '';
    const assigneeId = document.getElementById('bd-assignee').value || '';
    const dueDate = document.getElementById('bd-due-date').value || '';
    const labelsRaw = document.getElementById('bd-labels').value || '';
    const storyPts = document.getElementById('bd-story-points').value || '';
    const team = document.getElementById('bd-team').value || '';
    const watchersRaw = document.getElementById('bd-watchers').value || '';

    const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const watchers = watchersRaw ? watchersRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (team) labels.push(`team-${team.toLowerCase().replace(/\s+/g, '-')}`);

    if (!storyKey) { showToast('Please enter a Story Key (e.g. KAN-2)', 'error'); return; }
    if (!projectKey) { showToast('Please enter a Project Key (e.g. KAN)', 'error'); return; }

    setGenerateLoading('bd', true);
    hidePreview();
    hideResult();
    currentAiOutput = null;

    try {
        showToast('Fetching story from Jira…', 'info');
        const story = await jiraGetIssue(storyKey);

        showToast('Calling Groq AI…', 'info');
        const aiOutput = await groqGenerate({
            mode: 'breakdown',
            storyTitle: story.title,
            storyDescription: story.description,
            numSubtasks,
        });

        aiOutput._meta = {
            mode: 'breakdown',
            parentKey: storyKey,
            projectKey: projectKey || storyKey.split('-')[0],
            breakType,
            jiraStatus,
            priority,
            assigneeId,
            dueDate,
            labels,
            storyPoints: storyPts ? parseFloat(storyPts) : null,
            watchers,
        };

        currentAiOutput = aiOutput;
        renderPreview(aiOutput, 'breakdown');

    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    } finally {
        setGenerateLoading('bd', false);
    }
}

// ─── Create Flow ────────────────────────────────────────────────────────────

async function onCreateGenerate() {
    if (!validateSettings()) return;

    const description = document.getElementById('cr-description').value.trim();
    const projectKey = document.getElementById('cr-project-key').value.trim().toUpperCase();
    const numSubtasks = parseInt(document.getElementById('cr-num-subtasks').value, 10) || 5;
    const issueType = document.getElementById('cr-issue-type').value;
    const jiraStatus = document.getElementById('cr-status').value.trim();

    if (!description) { showToast('Please enter a description', 'error'); return; }
    if (!projectKey) { showToast('Please enter a Project Key (e.g. KAN)', 'error'); return; }

    setGenerateLoading('cr', true);
    hidePreview();
    hideResult();
    currentAiOutput = null;

    try {
        showToast('Calling Groq AI…', 'info');
        const aiOutput = await groqGenerate({
            mode: 'create',
            description,
            issueType,
            numSubtasks,
        });

        aiOutput._meta = {
            mode: 'create',
            projectKey,
            issueType,
            jiraStatus,
        };

        currentAiOutput = aiOutput;
        renderPreview(aiOutput, 'create');

    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    } finally {
        setGenerateLoading('cr', false);
    }
}

// ─── Confirm & Create in Jira ────────────────────────────────────────────────

async function onConfirm() {
    if (!currentAiOutput) return;
    if (!validateSettings()) return;

    setConfirmLoading(true);

    const meta = currentAiOutput._meta || {};
    const jiraStatus = meta.jiraStatus || '';
    const projectKey = meta.projectKey || '';
    const priority = meta.priority || '';
    const assigneeId = meta.assigneeId || '';
    const dueDate = meta.dueDate || '';
    const labels = meta.labels || [];
    const storyPoints = meta.storyPoints || null;
    const watchers = meta.watchers || [];
    const createdKeys = [];

    // Build the extra fields object — only include non-empty values
    const extraFields = {};
    if (priority) extraFields.priority = { name: priority };
    if (assigneeId) extraFields.assignee = { accountId: assigneeId };
    if (dueDate) extraFields.duedate = dueDate;

    // Handle labels & Story Points (as a label) safely
    const finalLabels = Array.isArray(labels) ? [...labels] : [];

    // Story Points -> label "sp:X"
    if (storyPoints !== null) finalLabels.push(`sp:${storyPoints}`);

    if (finalLabels.length > 0) extraFields.labels = finalLabels;

    try {
        let parentKey = meta.parentKey || '';

        if (meta.mode === 'create') {
            showToast('Creating parent issue…', 'info');
            const parentResult = await jiraCreateIssue({
                projectKey,
                issueType: meta.issueType || 'Story',
                title: currentAiOutput.title,
                description: currentAiOutput.description || '',
                acceptanceCriteria: currentAiOutput.acceptance_criteria || [],
            });
            parentKey = parentResult.key;
            createdKeys.push(parentKey);
            if (jiraStatus && parentKey) {
                await jiraTransition(parentKey, jiraStatus).catch(() => { });
            }
        } else {
            if (jiraStatus && parentKey) {
                await jiraTransition(parentKey, jiraStatus).catch(() => { });
            }
        }

        // Create subtasks with all optional fields applied
        const subtasks = currentAiOutput.subtasks || [];
        for (let i = 0; i < subtasks.length; i++) {
            const st = subtasks[i];
            showToast(`Creating ${i + 1}/${subtasks.length}: ${st.title.slice(0, 30)}…`, 'info');

            const result = await jiraCreateSubtask({
                parentKey,
                projectKey,
                title: st.title,
                description: st.description || '',
                acceptanceCriteria: st.acceptance_criteria || [],
                breakType: meta.breakType || null,
                extraFields,
            });
            const stKey = result.key;
            createdKeys.push(stKey);

            // Transition status
            if (jiraStatus && stKey) {
                await jiraTransition(stKey, jiraStatus).catch(() => { });
            }

            // Add watchers / CC
            for (const w of watchers) {
                await jiraAddWatcher(stKey, w).catch(() => { });
            }
        }

        showResult(parentKey, createdKeys, meta);

    } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
    } finally {
        setConfirmLoading(false);
    }
}

// ─── Groq API ───────────────────────────────────────────────────────────────

async function groqGenerate({ mode, storyTitle, storyDescription, description, issueType, numSubtasks }) {
    const { groq_key } = currentSettings;

    const systemPrompt = `You are a senior software engineer and agile project manager.
Your task is to break down software requirements into well-structured, actionable Jira tickets.
OUTPUT RULES:
- Respond with STRICTLY valid JSON only. No markdown, no code fences, no extra text.
- Use the exact schema provided.`;

    let userPrompt;
    if (mode === 'breakdown') {
        userPrompt = `Break the Jira story below into exactly ${numSubtasks} subtasks.

Story: ${storyTitle}
Description: ${storyDescription || '(none)'}

Return ONLY this JSON:
{
  "title": "parent story title",
  "description": "brief description",
  "acceptance_criteria": ["AC 1", "AC 2"],
  "subtasks": [
    {
      "title": "subtask title",
      "description": "what needs to be done",
      "acceptance_criteria": ["AC 1"]
    }
  ]
}`;
    } else {
        userPrompt = `Create a Jira ${issueType} with exactly ${numSubtasks} subtasks from this description:

"${description}"

Return ONLY this JSON:
{
  "title": "clear, concise issue title",
  "description": "2-3 sentence description",
  "acceptance_criteria": ["AC 1", "AC 2", "AC 3"],
  "subtasks": [
    {
      "title": "subtask title",
      "description": "what needs to be done",
      "acceptance_criteria": ["AC 1"]
    }
  ]
}`;
    }

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${groq_key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.4,
        }),
    });

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Groq API error ${resp.status}`);
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
        parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    } catch {
        throw new Error('AI returned invalid JSON. Please try again.');
    }

    if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) {
        throw new Error('AI response missing subtasks array. Please try again.');
    }

    // Trim/warn if count differs
    if (parsed.subtasks.length > numSubtasks) {
        parsed.subtasks = parsed.subtasks.slice(0, numSubtasks);
    }

    return parsed;
}

// ─── Jira API ────────────────────────────────────────────────────────────────

function jiraHeaders() {
    const { jira_email, jira_token } = currentSettings;
    return {
        'Authorization': 'Basic ' + btoa(`${jira_email}:${jira_token}`),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

async function jiraRequest(method, path, body) {
    const { jira_url } = currentSettings;
    const url = `${jira_url}/rest/api/3/${path}`;
    const opts = { method, headers: jiraHeaders() };
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const msg = err.errorMessages?.join(', ') || Object.values(err.errors || {}).join(', ') || `HTTP ${resp.status}`;
        throw new Error(`Jira error: ${msg}`);
    }

    if (resp.status === 204) return {};
    return resp.json();
}

async function jiraGetIssue(issueKey) {
    const data = await jiraRequest('GET', `issue/${issueKey}?fields=summary,description,project,issuetype`);
    const fields = data.fields || {};
    return {
        key: issueKey,
        title: fields.summary || '',
        description: extractAdfText(fields.description || {}),
        projectKey: fields.project?.key || '',
    };
}

function buildAdf(description, acceptanceCriteria) {
    const content = [];
    if (description) {
        content.push({ type: 'paragraph', content: [{ type: 'text', text: description }] });
    }
    if (acceptanceCriteria && acceptanceCriteria.length > 0) {
        content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance Criteria' }] });
        content.push({
            type: 'bulletList',
            content: acceptanceCriteria.map(ac => ({
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: ac }] }],
            })),
        });
    }
    return { version: 1, type: 'doc', content };
}

async function jiraCreateIssue({ projectKey, issueType, title, description, acceptanceCriteria }) {
    return jiraRequest('POST', 'issue', {
        fields: {
            project: { key: projectKey },
            summary: title,
            description: buildAdf(description, acceptanceCriteria),
            issuetype: { name: issueType },
        },
    });
}

async function jiraCreateSubtask({ parentKey, projectKey, title, description, acceptanceCriteria, breakType, extraFields }) {
    // If breakType is specified (and not empty), use it; otherwise auto-detect default subtask type
    const typeName = breakType ? breakType : await detectSubtaskTypeName(projectKey);

    const baseFields = {
        project: { key: projectKey },
        parent: { key: parentKey },
        summary: title,
        description: buildAdf(description, acceptanceCriteria),
        issuetype: { name: typeName },
    };

    // 1. Create with ESSENTIAL fields only (to avoid "Field not on screen" errors blocking creation)
    const result = await jiraRequest('POST', 'issue', { fields: baseFields });

    // 2. Try to update with EXTRA fields (optional) — catch errors so creation success is preserved
    if (extraFields && Object.keys(extraFields).length > 0) {
        try {
            await jiraRequest('PUT', `issue/${result.key}`, { fields: extraFields });
        } catch (err) {
            console.warn(`[JiraAI] Failed to set extra fields (e.g. Due Date) on ${result.key}. Field might be missing from Edit screen.`, err);
        }
    }

    return result;
}

async function jiraAddWatcher(issueKey, userQuery) {
    // Determine if userQuery is an accountId or string
    // Jira API requires accountId string.
    let accountId = userQuery;

    // Simple check: if it contains @, assumes email and try to search
    // (Note: /user/search may require special permissions or GDPR settings)
    if (userQuery.includes('@')) {
        try {
            const users = await jiraRequest('GET', `user/search?query=${encodeURIComponent(userQuery)}`);
            if (users && users.length > 0) {
                accountId = users[0].accountId;
            }
        } catch { /* ignore search error, try using as-is */ }
    }

    // Quote string for POST body format needed by some Jira APIs?
    // /issue/{key}/watchers POST body is just the string "accountId" (with quotes in JSON)
    return jiraRequest('POST', `issue/${issueKey}/watchers`, accountId);
}

// Cache of discovered subtask type name per project
const _subtaskTypeCache = {};

/**
 * Queries the Jira project's issue types to find the correct subtask type name.
 * Jira Cloud uses 'Subtask', 'Sub-task', or other variants depending on config.
 * Caches result so the API is only called once per project.
 */
async function detectSubtaskTypeName(projectKey) {
    if (_subtaskTypeCache[projectKey]) return _subtaskTypeCache[projectKey];

    try {
        // Use createmeta endpoint which lists all valid issue types per project
        const data = await jiraRequest(
            'GET',
            `issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`
        );
        const projects = data.projects || [];
        const proj = projects.find(p => p.key === projectKey);
        if (proj) {
            const types = proj.issuetypes || [];
            // Find any type marked as a subtask
            const subtaskType = types.find(t => t.subtask === true);
            if (subtaskType) {
                _subtaskTypeCache[projectKey] = subtaskType.name;
                console.log('[JiraAI] Detected subtask type:', subtaskType.name);
                return subtaskType.name;
            }
        }
    } catch (e) {
        console.warn('[JiraAI] createmeta failed, trying fallback names:', e.message);
    }

    // Fallback: try common names until one works
    const candidates = ['Subtask', 'Sub-task', 'subtask', 'sub-task'];
    for (const name of candidates) {
        try {
            const resp = await fetch(
                `${currentSettings.jira_url}/rest/api/3/issue`,
                {
                    method: 'POST',
                    headers: jiraHeaders(),
                    body: JSON.stringify({
                        fields: { project: { key: projectKey }, issuetype: { name }, summary: '__probe__' },
                    }),
                }
            );
            const body = await resp.json().catch(() => ({}));
            const errText = JSON.stringify(body).toLowerCase();
            // If no issuetype error, this name is valid
            if (!errText.includes('issuetype') && !errText.includes('issue type')) {
                _subtaskTypeCache[projectKey] = name;
                console.log('[JiraAI] Subtask type found via probe:', name);
                return name;
            }
        } catch { /* continue */ }
    }

    _subtaskTypeCache[projectKey] = 'Subtask';
    return 'Subtask';
}

async function jiraTransition(issueKey, targetStatus) {
    const data = await jiraRequest('GET', `issue/${issueKey}/transitions`);
    const match = (data.transitions || []).find(
        t => t.name.toLowerCase() === targetStatus.toLowerCase()
    );
    if (!match) return;
    await jiraRequest('POST', `issue/${issueKey}/transitions`, { transition: { id: match.id } });
}

function extractAdfText(adf) {
    if (!adf || !adf.content) return '';
    const texts = [];
    function walk(node) {
        if (node.type === 'text') texts.push(node.text || '');
        (node.content || []).forEach(walk);
    }
    walk(adf);
    return texts.join(' ').trim();
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────

function renderPreview(aiOutput, mode) {
    const previewSection = document.getElementById('preview-section');

    // Title (for create flow)
    const titleBox = document.getElementById('preview-issue-title');
    if (mode === 'create' && aiOutput.title) {
        titleBox.textContent = `📌 ${aiOutput.title}`;
        titleBox.style.display = 'block';
    } else {
        titleBox.style.display = 'none';
    }

    // Description
    document.getElementById('preview-description').textContent = aiOutput.description || '';

    // Acceptance criteria
    const acSection = document.getElementById('preview-ac-section');
    const acList = document.getElementById('preview-ac-list');
    const acs = aiOutput.acceptance_criteria || [];
    if (acs.length > 0) {
        acList.innerHTML = acs.map(ac => `<li>${escHtml(ac)}</li>`).join('');
        acSection.style.display = 'block';
    } else {
        acSection.style.display = 'none';
    }

    // Subtasks
    const subtasks = aiOutput.subtasks || [];
    const container = document.getElementById('subtasks-container');
    document.getElementById('subtask-count').textContent = subtasks.length;
    container.innerHTML = subtasks.map((st, i) => `
    <div class="subtask-card">
      <div class="subtask-num">Subtask ${i + 1}</div>
      <div class="subtask-title">${escHtml(st.title)}</div>
      ${st.description ? `<div class="subtask-desc">${escHtml(st.description)}</div>` : ''}
    </div>
  `).join('');

    previewSection.style.display = 'block';
    previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showResult(parentKey, allKeys, meta) {
    hidePreview();

    const resultSection = document.getElementById('result-section');
    const { jira_url } = currentSettings;

    const subtaskKeys = allKeys.filter(k => k !== parentKey);
    const subtaskCount = subtaskKeys.length;
    const mode = meta.mode;

    document.getElementById('result-message').textContent =
        mode === 'create'
            ? `✅ Created ${subtaskCount + 1} issues in Jira!`
            : `✅ Created ${subtaskCount} subtasks under ${parentKey}!`;

    const linksEl = document.getElementById('result-links');
    const allToShow = mode === 'create' ? allKeys : subtaskKeys;
    linksEl.innerHTML = allToShow.map(key =>
        `<a href="${jira_url}/browse/${key}" target="_blank" class="result-link">${key}</a>`
    ).join('');

    resultSection.style.display = 'block';
}

function hidePreview() {
    document.getElementById('preview-section').style.display = 'none';
}

function hideResult() {
    document.getElementById('result-section').style.display = 'none';
}

function setGenerateLoading(prefix, loading) {
    const btn = document.getElementById(`${prefix}-generate-btn`);
    const btnText = document.getElementById(`${prefix}-btn-text`);
    const spinner = document.getElementById(`${prefix}-btn-spinner`);

    btn.disabled = loading;
    btnText.style.display = loading ? 'none' : 'inline';
    spinner.style.display = loading ? 'inline' : 'none';
}

function setConfirmLoading(loading) {
    const btn = document.getElementById('confirm-btn');
    const btnText = document.getElementById('confirm-btn-text');
    const spinner = document.getElementById('confirm-btn-spinner');

    btn.disabled = loading;
    btnText.style.display = loading ? 'none' : 'inline';
    spinner.style.display = loading ? 'inline' : 'none';
}

function validateSettings() {
    const { groq_key, jira_url, jira_email, jira_token } = currentSettings;
    if (!groq_key || !jira_url || !jira_email || !jira_token) {
        showToast('Please configure your credentials in Settings first.', 'error');
        chrome.runtime.openOptionsPage();
        return false;
    }
    return true;
}

let toastTimer;
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast toast-${type}`;
    toast.style.display = 'block';

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
