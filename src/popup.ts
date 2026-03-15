// Spranki Linker — Popup script

const ankiStatus = document.getElementById("anki-status")!;
const mappingStatus = document.getElementById("mapping-status")!;
const btnReload = document.getElementById("btn-reload") as HTMLButtonElement;
const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
const btnSaveKey = document.getElementById("btn-save-key") as HTMLButtonElement;
const btnClearKey = document.getElementById("btn-clear-key") as HTMLButtonElement;
const claudeStatus = document.getElementById("claude-status")!;

function setStatus(el: HTMLElement, text: string, state: string): void {
  el.textContent = text;
  el.className = `status-badge badge-${state}`;
}

// Check AnkiConnect
chrome.runtime.sendMessage(
  { type: "TEST_ANKICONNECT" },
  (res: { ok: boolean; version?: number }) => {
    if (chrome.runtime.lastError || !res) {
      setStatus(ankiStatus, "Not running", "err");
      return;
    }
    if (res.ok) {
      setStatus(ankiStatus, `v${res.version}`, "ok");
    } else {
      setStatus(ankiStatus, "Not running", "err");
    }
  }
);

// Show mapping count
chrome.storage.local.get(
  "customMappings",
  (stored: { customMappings?: { passMed?: Record<string, unknown>; quesmed?: Record<string, unknown> } }) => {
    if (stored.customMappings) {
      const count =
        Object.keys(stored.customMappings.passMed || {}).length +
        Object.keys(stored.customMappings.quesmed || {}).length;
      setStatus(mappingStatus, `${count} custom`, "ok");
    } else {
      setStatus(mappingStatus, "Bundled", "ok");
    }
  }
);

// Claude API key status
chrome.runtime.sendMessage(
  { type: "GET_CACHE_STATS" },
  (res: { hasKey: boolean; cached: number }) => {
    if (!res) return;
    if (res.hasKey) {
      claudeStatus.textContent = `✓ ${res.cached} topics cached`;
      apiKeyInput.placeholder = "sk-ant-… (saved)";
    } else {
      claudeStatus.textContent = "Not set";
      (claudeStatus as HTMLElement).style.color = "#9ca8c8";
    }
  }
);

btnSaveKey.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.runtime.sendMessage(
    { type: "SAVE_API_KEY", apiKey: key },
    (res: { ok: boolean }) => {
      if (res?.ok) {
        apiKeyInput.value = "";
        apiKeyInput.placeholder = "sk-ant-… (saved)";
        claudeStatus.textContent = "✓ Saved";
        (claudeStatus as HTMLElement).style.color = "#4ade80";
      }
    }
  );
});

btnClearKey.addEventListener("click", () => {
  chrome.storage.local.remove(["claudeApiKey", "titleCache"], () => {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "sk-ant-api03-…";
    claudeStatus.textContent = "Cleared";
    (claudeStatus as HTMLElement).style.color = "#9ca8c8";
  });
});

document.getElementById("btn-clear-cache")?.addEventListener("click", () => {
  chrome.storage.local.remove("titleCache", () => {
    claudeStatus.textContent = "Cache cleared";
    (claudeStatus as HTMLElement).style.color = "#fbbf24";
  });
});

// Community sync status
const communityStatus = document.getElementById("community-status")!;

function refreshCommunityStatus(): void {
  chrome.storage.local.get("communityMappings", (stored) => {
    const cm = stored.communityMappings as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (cm) {
      const count =
        Object.keys(cm.passMed || {}).length +
        Object.keys(cm.quesmed || {}).length;
      setStatus(communityStatus, `${count} synced`, "ok");
    } else {
      setStatus(communityStatus, "Not synced", "checking");
    }
  });
}

refreshCommunityStatus();

document.getElementById("btn-sync-community")?.addEventListener("click", () => {
  const btn = document.getElementById("btn-sync-community") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  setStatus(communityStatus, "Syncing…", "checking");
  chrome.runtime.sendMessage(
    { type: "SYNC_COMMUNITY_MAPPINGS" },
    (res: { synced: number }) => {
      btn.disabled = false;
      btn.textContent = "↻ Sync community";
      if (res?.synced >= 0) {
        setStatus(communityStatus, `${res.synced} rows fetched`, "ok");
      } else {
        setStatus(communityStatus, "Failed", "err");
      }
      refreshCommunityStatus();
    }
  );
});

// Reload mappings
btnReload.addEventListener("click", () => {
  btnReload.disabled = true;
  btnReload.textContent = "Reloading…";
  chrome.runtime.sendMessage(
    { type: "RELOAD_MAPPINGS" },
    (res: { ok: boolean }) => {
      btnReload.disabled = false;
      btnReload.textContent = res?.ok ? "↻ Reload mappings" : "⚠ Failed";
      setTimeout(() => {
        btnReload.textContent = "↻ Reload mappings";
      }, 2000);
    }
  );
});

// Export mappings
const importStatus = document.getElementById("mapping-import-status")!;

document.getElementById("btn-export")?.addEventListener("click", () => {
  chrome.storage.local.get(
    "customMappings",
    (stored: {
      customMappings?: { passMed?: Record<string, unknown>; quesmed?: Record<string, unknown> };
    }) => {
      const data = stored.customMappings || { passMed: {}, quesmed: {} };
      const count =
        Object.keys(data.passMed || {}).length +
        Object.keys(data.quesmed || {}).length;
      if (count === 0) {
        importStatus.textContent = "Nothing to export yet";
        (importStatus as HTMLElement).style.color = "#9ca8c8";
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `spranki-mappings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      importStatus.textContent = `Exported ${count} mappings`;
      (importStatus as HTMLElement).style.color = "#4ade80";
    }
  );
});

// Import mappings
document.getElementById("btn-import")?.addEventListener("click", () => {
  document.getElementById("import-input")?.click();
});

document.getElementById("import-input")?.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target!.result as string) as Record<
        string,
        Record<string, unknown>
      >;
      if (
        typeof imported !== "object" ||
        Array.isArray(imported) ||
        (!imported.passMed && !imported.quesmed)
      ) {
        importStatus.textContent = "Invalid file format";
        (importStatus as HTMLElement).style.color = "#f87171";
        return;
      }

      chrome.storage.local.get(
        "customMappings",
        (stored: {
          customMappings?: {
            passMed?: Record<string, unknown>;
            quesmed?: Record<string, unknown>;
          };
        }) => {
          const existing = stored.customMappings || { passMed: {}, quesmed: {} };

          for (const platform of ["passMed", "quesmed"] as const) {
            if (imported[platform] && typeof imported[platform] === "object") {
              const normalised: Record<string, unknown> = {};
              for (const [qid, entry] of Object.entries(imported[platform])) {
                const e = entry as { noteIds?: unknown[] };
                normalised[qid] = Array.isArray(e?.noteIds)
                  ? { ...e, noteIds: e.noteIds.map(Number) }
                  : entry;
              }
              existing[platform] = { ...(existing[platform] || {}), ...normalised };
            }
          }

          const total =
            Object.keys(existing.passMed || {}).length +
            Object.keys(existing.quesmed || {}).length;

          chrome.storage.local.set({ customMappings: existing }, () => {
            importStatus.textContent = `Imported — ${total} total`;
            (importStatus as HTMLElement).style.color = "#4ade80";
            setStatus(mappingStatus, `${total} custom`, "ok");
            chrome.runtime.sendMessage({ type: "RELOAD_MAPPINGS" });
          });
        }
      );
    } catch {
      importStatus.textContent = "Could not parse file";
      (importStatus as HTMLElement).style.color = "#f87171";
    }
  };
  reader.readAsText(file);
});
