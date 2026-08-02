;(function () {
  var key = "arforge-theme-id"
  var themeId = localStorage.getItem(key) || "arforge-default"
  var legacyThemePrefix = ["o", "c"].join("")

  if (themeId === legacyThemePrefix + "-1" || themeId === legacyThemePrefix + "-2") {
    themeId = "arforge-default"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("arforge-theme-css-light")
    localStorage.removeItem("arforge-theme-css-dark")
  }

  var scheme = localStorage.getItem("arforge-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")

  if (themeId === "arforge-default") return

  var css = localStorage.getItem("arforge-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "arforge-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
