// Apply the stored/system theme before first paint to avoid a flash.
// Loaded as a classic script from index.html so the CSP can stay `script-src 'self'`.
;(function () {
  try {
    var key = 'nvnmchain-multisig:theme:v1'
    var stored = localStorage.getItem(key)
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
    document.documentElement.setAttribute('data-theme', theme)
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark')
  }
})()
