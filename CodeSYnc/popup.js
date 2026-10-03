// The popup never talks to GitHub itself and never sees the access token.
// It only sends messages to the background service worker and shows the answer.

const sections = {
  disconnected: document.getElementById("disconnected"),
  pending: document.getElementById("pending"),
  connected: document.getElementById("connected")
};
const errorBox = document.getElementById("error");
const connectButton = document.getElementById("connect");
const openGitHubButton = document.getElementById("open-github");
const cancelButton = document.getElementById("cancel");
const disconnectButton = document.getElementById("disconnect");

// Repository picker
const repoCurrent = document.getElementById("repo-current");
const repoWarning = document.getElementById("repo-warning");
const changeRepoButton = document.getElementById("change-repo");
const repoPicker = document.getElementById("repo-picker");
const repoSelect = document.getElementById("repo-select");
const repoMessage = document.getElementById("repo-message");
const retryReposButton = document.getElementById("retry-repos");
const saveRepoButton = document.getElementById("save-repo");
const cancelRepoButton = document.getElementById("cancel-repo");

// TEMPORARY test button (Milestone 8B-1)
const testWriteButton = document.getElementById("test-write");
const writeResultBox = document.getElementById("write-result");

// What the popup currently knows
let latestStatus = { state: "disconnected" };
let repoList = { state: "idle", items: [], error: "", truncated: false }; // idle | loading | loaded | error
let pickerOpen = false;     // is the picker open while a repository is already saved?
let selectedFullName = "";  // what the user picked in the dropdown
let saveError = "";
let saving = false;
let testing = false;        // is a test write running?
let writeResult = null;     // { ok, text } shown under the test button

// Send a message to background.js (github-auth.js) and wait for its answer
async function ask(type, extra) {
  try {
    return await chrome.runtime.sendMessage({ type: type, ...(extra || {}) });
  } catch (error) {
    return { ok: false, state: "disconnected", error: "Could not reach the CodeSync background worker." };
  }
}

function setHidden(element, hidden) {
  if (hidden) element.classList.add("hidden");
  else element.classList.remove("hidden");
}

// ---------- Drawing the popup ----------

function render() {
  const status = latestStatus;

  for (const name in sections) {
    sections[name].classList.add("hidden");
  }
  sections[status.state].classList.remove("hidden");

  if (status.error) {
    errorBox.textContent = status.error;
    errorBox.classList.remove("hidden");
  } else {
    errorBox.classList.add("hidden");
  }

  if (status.state === "connected") {
    document.getElementById("username").textContent = status.username;
    renderRepositoryArea();
    renderWriteArea();
  }
  if (status.state === "pending") {
    document.getElementById("user-code").textContent = status.userCode;
    openGitHubButton.dataset.url = status.verificationUri;
    openGitHubButton.dataset.code = status.userCode;
  }
}

function renderRepositoryArea() {
  const saved = latestStatus.repository; // { owner, repo } or null
  repoCurrent.textContent = saved ? saved.owner + "/" + saved.repo : "none selected";

  const showPicker = !saved || pickerOpen;
  setHidden(changeRepoButton, !saved || pickerOpen);
  setHidden(repoPicker, !showPicker);
  setHidden(cancelRepoButton, !saved);

  // Warn if the saved repository is no longer in the list GitHub returned
  let warning = "";
  if (saved && repoList.state === "loaded") {
    const stillThere = repoList.items.some(
      (item) => item.owner === saved.owner && item.name === saved.repo
    );
    if (!stillThere) {
      warning = "This repository is no longer in your list (it may be archived, renamed, or you lost write access). Choose another one.";
    }
  }
  repoWarning.textContent = warning;
  setHidden(repoWarning, warning === "");

  if (!showPicker) return;

  // Fill the dropdown
  repoSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select repository";
  repoSelect.appendChild(placeholder);

  let message = "";
  let messageIsError = false;
  let canChoose = false;
  setHidden(retryReposButton, true);

  if (saveError) {
    message = saveError;
    messageIsError = true;
  }

  if (repoList.state === "idle" || repoList.state === "loading") {
    if (!message) message = "Loading your repositories...";
  } else if (repoList.state === "error") {
    if (!message) {
      message = repoList.error;
      messageIsError = true;
    }
    setHidden(retryReposButton, false);
  } else if (repoList.items.length === 0) {
    if (!message) {
      message = "No suitable repositories found. CodeSync needs a repository you can push to. Create one on GitHub, then reopen this popup.";
    }
  } else {
    canChoose = true;
    for (const item of repoList.items) {
      const option = document.createElement("option");
      option.value = item.fullName;
      option.textContent = item.fullName + (item.private ? " (private)" : "");
      repoSelect.appendChild(option);
    }
    // Pre-select what the user picked, or else the saved repository
    const wanted = selectedFullName || (saved ? saved.owner + "/" + saved.repo : "");
    if (wanted && repoList.items.some((item) => item.fullName === wanted)) {
      repoSelect.value = wanted;
    }
    if (!message && repoList.truncated) {
      message = "Showing the first 1000 repositories.";
    }
  }

  repoSelect.disabled = !canChoose;
  repoMessage.textContent = message;
  repoMessage.classList.toggle("field-error", messageIsError);
  setHidden(repoMessage, message === "");
  updateSaveButton();
}

// Shows the result of the temporary "Test GitHub Write" button
function renderWriteArea() {
  testWriteButton.disabled = testing;
  testWriteButton.textContent = testing ? "Testing..." : "Test GitHub Write";

  if (writeResult) {
    writeResultBox.textContent = writeResult.text;
    writeResultBox.classList.toggle("result-ok", writeResult.ok);
    writeResultBox.classList.toggle("field-error", !writeResult.ok);
    setHidden(writeResultBox, false);
  } else {
    setHidden(writeResultBox, true);
  }
}

function updateSaveButton() {
  saveRepoButton.disabled = saving || !repoSelect.value;
}

// ---------- Loading data from the background worker ----------

async function loadRepositories() {
  repoList = { state: "loading", items: [], error: "", truncated: false };
  render();

  const reply = await ask("GITHUB_LIST_REPOSITORIES");
  if (reply && reply.ok && Array.isArray(reply.repositories)) {
    repoList = {
      state: "loaded",
      items: reply.repositories,
      error: "",
      truncated: Boolean(reply.truncated)
    };
  } else {
    repoList = {
      state: "error",
      items: [],
      error: (reply && reply.error) || "Could not load your repositories.",
      truncated: false
    };
  }
  render();
}

async function refresh() {
  latestStatus = await ask("GITHUB_GET_STATUS");

  if (latestStatus.state !== "connected") {
    // Forget everything about repositories once GitHub is not connected
    repoList = { state: "idle", items: [], error: "", truncated: false };
    pickerOpen = false;
    selectedFullName = "";
    saveError = "";
    writeResult = null;
  }

  render();

  // When the popup opens and GitHub is connected, load the repositories
  if (latestStatus.state === "connected" && repoList.state === "idle") {
    loadRepositories();
  }
}

// ---------- Buttons ----------

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  connectButton.textContent = "Connecting...";
  latestStatus = await ask("GITHUB_CONNECT");
  connectButton.disabled = false;
  connectButton.textContent = "Connect GitHub";
  render();
});

openGitHubButton.addEventListener("click", async () => {
  // Copy first, because opening a new tab closes this popup
  try {
    await navigator.clipboard.writeText(openGitHubButton.dataset.code);
  } catch (error) {
    // Copying is only a convenience. The code is still shown on screen.
  }
  chrome.tabs.create({ url: openGitHubButton.dataset.url });
});

cancelButton.addEventListener("click", async () => {
  latestStatus = await ask("GITHUB_CANCEL");
  render();
});

disconnectButton.addEventListener("click", async () => {
  latestStatus = await ask("GITHUB_DISCONNECT");
  await refresh(); // also forgets the repository list
});

repoSelect.addEventListener("change", () => {
  selectedFullName = repoSelect.value;
  saveError = "";
  updateSaveButton();
});

changeRepoButton.addEventListener("click", () => {
  pickerOpen = true;
  selectedFullName = "";
  saveError = "";
  render();
});

cancelRepoButton.addEventListener("click", () => {
  pickerOpen = false;
  selectedFullName = "";
  saveError = "";
  render();
});

retryReposButton.addEventListener("click", () => {
  saveError = "";
  loadRepositories();
});

saveRepoButton.addEventListener("click", async () => {
  const item = repoList.items.find((entry) => entry.fullName === repoSelect.value);
  if (!item) return;

  saving = true;
  saveRepoButton.textContent = "Saving...";
  updateSaveButton();

  // Only the owner and repository NAME are sent. The worker checks them with GitHub.
  const reply = await ask("GITHUB_SAVE_REPOSITORY", { owner: item.owner, repo: item.name });

  saving = false;
  saveRepoButton.textContent = "Save Repository";

  if (reply && reply.ok) {
    if (reply.status) latestStatus = reply.status;
    pickerOpen = false;
    selectedFullName = "";
    saveError = "";
    writeResult = null; // an old test result belongs to the previous repository
  } else {
    saveError = (reply && reply.error) || "Could not save the repository.";
  }
  render();
});

// TEMPORARY: ask the background worker to create CodeSync/test.txt.
// Only the plain answer comes back: { success, path, repository } or { success: false, error }.
testWriteButton.addEventListener("click", async () => {
  testing = true;
  writeResult = null;
  renderWriteArea();

  const reply = await ask("GITHUB_TEST_WRITE");

  testing = false;
  if (reply && reply.success) {
    const where = reply.repository ? " (" + reply.repository + ")" : "";
    writeResult = { ok: true, text: "GitHub write successful: " + reply.path + where };
  } else {
    writeResult = {
      ok: false,
      text: "GitHub write failed: " + ((reply && reply.error) || "Unknown error.")
    };
  }
  renderWriteArea();
});

// Update automatically when the sign-in or the saved repository changes
chrome.storage.onChanged.addListener(refresh);

refresh();