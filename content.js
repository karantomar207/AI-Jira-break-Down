/**
 * Content script injected into Jira pages.
 * Reads the current issue key from the URL and page title.
 * Responds to messages from the popup.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getJiraContext') {
        sendResponse(getJiraContext());
    }
    return true;
});

function getJiraContext() {
    const url = window.location.href;

    // Match /browse/PROJ-123 pattern
    const browseMatch = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (browseMatch) {
        const issueKey = browseMatch[1];
        const projectKey = issueKey.split('-')[0];
        return { issueKey, projectKey, isJiraIssue: true };
    }

    // Match /jira/software/projects/PROJ/... pattern
    const projectMatch = url.match(/\/jira\/software\/projects\/([A-Z][A-Z0-9]+)/);
    if (projectMatch) {
        return { issueKey: '', projectKey: projectMatch[1], isJiraIssue: false };
    }

    return { issueKey: '', projectKey: '', isJiraIssue: false };
}
