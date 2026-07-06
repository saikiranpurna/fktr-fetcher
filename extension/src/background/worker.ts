// Service worker entry. Full fetch orchestration is added in Phase 2 (Task 2.5).
// For now it just opens the dashboard tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/index.html") });
});
