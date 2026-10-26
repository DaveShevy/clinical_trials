// Runs before the page first draws. A shared link (?q=...) opens on its
// results with a compact header; setting the class here, not in app.js,
// means the header does not shrink under the reader a moment later.
if ((new URLSearchParams(window.location.search).get("q") || "").trim()) {
  document.documentElement.classList.add("has-query");
}
