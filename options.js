/**
 * Options page logic — MV3 compatible (no inline onclick handlers)
 * All event listeners attached via addEventListener inside DOMContentLoaded.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Load saved settings
    chrome.storage.sync.get(
        ['groq_key', 'jira_url', 'jira_email', 'jira_token'],
        (data) => {
            if (data.groq_key) document.getElementById('groq_key').value = data.groq_key;
            if (data.jira_url) document.getElementById('jira_url').value = data.jira_url;
            if (data.jira_email) document.getElementById('jira_email').value = data.jira_email;
            if (data.jira_token) document.getElementById('jira_token').value = data.jira_token;
        }
    );

    // Save button
    document.getElementById('save-btn').addEventListener('click', saveSettings);

    // Toggle visibility
    document.getElementById('toggle-groq').addEventListener('click', () => toggleVis('groq_key', 'toggle-groq'));
    document.getElementById('toggle-token').addEventListener('click', () => toggleVis('jira_token', 'toggle-token'));
});

function saveSettings() {
    const groq_key = document.getElementById('groq_key').value.trim();
    const jira_url = document.getElementById('jira_url').value.trim().replace(/\/$/, '');
    const jira_email = document.getElementById('jira_email').value.trim();
    const jira_token = document.getElementById('jira_token').value.trim();

    if (!groq_key || !jira_url || !jira_email || !jira_token) {
        showAlert('Please fill in all required fields.', 'error');
        return;
    }

    if (!jira_url.startsWith('https://')) {
        showAlert('Jira URL must start with https://', 'error');
        return;
    }

    chrome.storage.sync.set(
        { groq_key, jira_url, jira_email, jira_token },
        () => {
            showAlert('✅ Settings saved! You can close this tab.', 'success');
        }
    );
}

function toggleVis(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
    } else {
        input.type = 'password';
        btn.textContent = '👁️';
    }
}

function showAlert(msg, type) {
    const el = document.getElementById('alert');
    el.textContent = msg;
    el.className = `alert alert-${type}`;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}
