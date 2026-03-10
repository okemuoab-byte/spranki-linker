// Runs in the MAIN world (page JS context) — can read window.question_data directly.
// Writes the current new_question_id to a hidden meta tag so content.js can read it.
(function () {
  function emitQID() {
    const nid = window.question_data && window.question_data.new_question_id;
    if (!nid || String(nid) === "0") return;

    let el = document.getElementById("_spranki_qid");
    if (!el) {
      el = document.createElement("meta");
      el.id = "_spranki_qid";
      document.head.appendChild(el);
    }
    if (el.getAttribute("content") !== String(nid)) {
      el.setAttribute("content", String(nid));
    }
  }

  emitQID();
  setInterval(emitQID, 300);
})();
