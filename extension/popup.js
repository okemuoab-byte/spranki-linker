// Spranki Linker — Popup script

const ankiStatus = document.getElementById("anki-status");
const mappingStatus = document.getElementById("mapping-status");
const btnReload = document.getElementById("btn-reload");
const apiKeyInput = document.getElementById("api-key-input");
const btnSaveKey = document.getElementById("btn-save-key");
const btnClearKey = document.getElementById("btn-clear-key");
const claudeStatus = document.getElementById("claude-status");

function setStatus(el, text, state) {
  el.textContent = text;
  el.className = `status-badge badge-${state}`;
}

// Check AnkiConnect
chrome.runtime.sendMessage({ type: "TEST_ANKICONNECT" }, (res) => {
  if (chrome.runtime.lastError || !res) {
    setStatus(ankiStatus, "Not running", "err");
    return;
  }
  if (res.ok) {
    setStatus(ankiStatus, `v${res.version}`, "ok");
  } else {
    setStatus(ankiStatus, "Not running", "err");
  }
});

// Show mapping count
chrome.storage.local.get("customMappings", (stored) => {
  if (stored.customMappings) {
    const count = Object.keys(stored.customMappings.passMed || {}).length
                + Object.keys(stored.customMappings.quesmed || {}).length;
    setStatus(mappingStatus, `${count} custom`, "ok");
  } else {
    setStatus(mappingStatus, "Bundled", "ok");
  }
});

// Claude API key
chrome.runtime.sendMessage({ type: "GET_CACHE_STATS" }, (res) => {
  if (!res) return;
  if (res.hasKey) {
    claudeStatus.textContent = `✓ ${res.cached} topics cached`;
    apiKeyInput.placeholder = "sk-ant-… (saved)";
  } else {
    claudeStatus.textContent = "Not set";
    claudeStatus.style.color = "#9ca8c8";
  }
});

btnSaveKey.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, (res) => {
    if (res?.ok) {
      apiKeyInput.value = "";
      apiKeyInput.placeholder = "sk-ant-… (saved)";
      claudeStatus.textContent = "✓ Saved";
      claudeStatus.style.color = "#4ade80";
    }
  });
});

btnClearKey.addEventListener("click", () => {
  chrome.storage.local.remove(["claudeApiKey", "titleCache"], () => {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "sk-ant-api03-…";
    claudeStatus.textContent = "Cleared";
    claudeStatus.style.color = "#9ca8c8";
  });
});

document.getElementById("btn-clear-cache").addEventListener("click", () => {
  chrome.storage.local.remove("titleCache", () => {
    claudeStatus.textContent = "Cache cleared";
    claudeStatus.style.color = "#fbbf24";
  });
});

// Reload mappings
btnReload.addEventListener("click", () => {
  btnReload.disabled = true;
  btnReload.textContent = "Reloading…";
  chrome.runtime.sendMessage({ type: "RELOAD_MAPPINGS" }, (res) => {
    btnReload.disabled = false;
    btnReload.textContent = res?.ok ? "↻ Reload mappings" : "⚠ Failed";
    setTimeout(() => { btnReload.textContent = "↻ Reload mappings"; }, 2000);
  });
});

// Export mappings
const importStatus = document.getElementById("mapping-import-status");

document.getElementById("btn-export").addEventListener("click", () => {
  chrome.storage.local.get("customMappings", (stored) => {
    const data = stored.customMappings || { passMed: {}, quesmed: {} };
    const count = Object.keys(data.passMed || {}).length
                + Object.keys(data.quesmed || {}).length;
    if (count === 0) {
      importStatus.textContent = "Nothing to export yet";
      importStatus.style.color = "#9ca8c8";
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spranki-mappings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    importStatus.textContent = `Exported ${count} mappings`;
    importStatus.style.color = "#4ade80";
  });
});

// Import mappings
document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("import-input").click();
});

document.getElementById("import-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ""; // reset so same file can be re-imported

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (typeof imported !== "object" || Array.isArray(imported)
          || (!imported.passMed && !imported.quesmed)) {
        importStatus.textContent = "Invalid file format";
        importStatus.style.color = "#f87171";
        return;
      }
      chrome.storage.local.get("customMappings", (stored) => {
        const existing = stored.customMappings || { passMed: {}, quesmed: {} };
        // Deep merge — imported entries win per-QID
        for (const platform of ["passMed", "quesmed"]) {
          if (imported[platform] && typeof imported[platform] === "object") {
            existing[platform] = { ...(existing[platform] || {}), ...imported[platform] };
          }
        }
        const total = Object.keys(existing.passMed || {}).length
                    + Object.keys(existing.quesmed || {}).length;
        chrome.storage.local.set({ customMappings: existing }, () => {
          importStatus.textContent = `Imported — ${total} total`;
          importStatus.style.color = "#4ade80";
          setStatus(mappingStatus, `${total} custom`, "ok");
          chrome.runtime.sendMessage({ type: "RELOAD_MAPPINGS" });
        });
      });
    } catch {
      importStatus.textContent = "Could not parse file";
      importStatus.style.color = "#f87171";
    }
  };
  reader.readAsText(file);
});
