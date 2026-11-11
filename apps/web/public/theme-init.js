// Sets the theme before the first paint (an external file, so the strict CSP allows it).
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("organizer.theme");
  } catch {
    // Storage blocked: use the system setting.
  }
  if (theme !== "dark" && theme !== "light") {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
})();
