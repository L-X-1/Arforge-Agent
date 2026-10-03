;(function () {
  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch (_) {
      return null
    }
  }

  function migrate(themeId) {
    try {
      localStorage.setItem("arforge-theme-id", themeId)
      localStorage.removeItem("arforge-theme-css-light")
      localStorage.removeItem("arforge-theme-css-dark")
    } catch (_) {}
  }

  var themeId = read("arforge-theme-id") || "arforge-default"
  var legacyThemePrefix = ["o", "c"].join("")
  if (themeId === legacyThemePrefix + "-1" || themeId === legacyThemePrefix + "-2") {
    themeId = "arforge-default"
    migrate(themeId)
  }

  var savedScheme = read("arforge-color-scheme")
  var scheme = savedScheme === "dark" || savedScheme === "system" ? savedScheme : "light"
  var systemDark = false
  if (scheme === "system") {
    try {
      systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    } catch (_) {}
  }
  var isDark = scheme === "dark" || (scheme === "system" && systemDark)
  var mode = isDark ? "dark" : "light"
  var background = isDark ? "#1C1D1B" : "#FAFAF7"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.colorScheme = mode
  document.documentElement.style.backgroundColor = background

  var meta = document.querySelector("meta[name='theme-color']")
  if (meta) meta.setAttribute("content", background)

  if (themeId === "arforge-default") return
  var css = read("arforge-theme-css-" + mode)
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
