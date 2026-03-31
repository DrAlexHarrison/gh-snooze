// ==UserScript==
// @name         GitHub: Hide Snoozed Issues
// @namespace    https://github.com/DrAlexHarrison/gh-snooze
// @version      2.0
// @description  Adds -label:snoozed to the default GitHub Issues filter
// @match        https://github.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  function maybeRedirect() {
    const url = new URL(window.location.href);
    // Only act on /owner/repo/issues with no existing query
    if (/^\/[^/]+\/[^/]+\/issues\/?$/.test(url.pathname) && !url.search) {
      url.searchParams.set('q', 'is:issue state:open -label:snoozed');
      window.location.replace(url.toString());
    }
  }

  // Handle full page loads
  maybeRedirect();

  // Handle SPA navigation (GitHub uses Turbo)
  document.addEventListener('turbo:load', maybeRedirect);
  document.addEventListener('turbo:render', maybeRedirect);

  // Fallback: watch for URL changes via History API
  const originalPushState = history.pushState;
  history.pushState = function () {
    originalPushState.apply(this, arguments);
    maybeRedirect();
  };
})();
