// The landing page's only script (external, so the strict CSP allows it). Runs in <head>, before the
// first paint: a browser with a signed-in account goes straight to it, and the stored theme applies.
(function () {
  var USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  try {
    var stored = JSON.parse(localStorage.getItem("sloppanizer.accounts.v1") || "null");
    if (stored && stored.version === 1 && Array.isArray(stored.accounts)) {
      var last = stored.accounts.find(function (account) {
        return account && account.username === stored.lastUsed && !account.signedOut;
      });
      if (last && USERNAME.test(last.username)) {
        location.replace("/u/" + last.username + "/");
        return;
      }
    }
  } catch {
    // Broken or blocked storage: show the landing page.
  }

  var root = document.documentElement;
  var theme = null;
  try {
    theme = localStorage.getItem("sloppanizer.theme");
  } catch {
    // Storage blocked: use the system setting.
  }
  if (theme !== "dark" && theme !== "light") {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.dataset.theme = theme;

  function label(button) {
    var next = root.dataset.theme === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", "Switch to the " + next + " theme");
    button.title = "Switch to the " + next + " theme";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;
    label(button);
    button.addEventListener("click", function () {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("sloppanizer.theme", root.dataset.theme);
      } catch {
        // Not stored; the theme still applies for this visit.
      }
      label(button);
    });
  });
})();
