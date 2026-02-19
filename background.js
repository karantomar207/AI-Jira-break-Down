/**
 * Background service worker.
 * Opens the options page on first install so user can set credentials.
 */

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
});
