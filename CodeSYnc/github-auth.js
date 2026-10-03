// ============================================================
// CodeSync - GitHub authentication (Milestone 7)
//
// Uses GitHub's OAuth "device flow". It needs NO client secret.
// This file is loaded by background.js with importScripts().
// ============================================================

// ---------- Settings ----------

// SAFE TO PUT HERE: the Client ID is a public identifier (not a secret).
// Paste the Client ID of your own GitHub OAuth App between the quotes.
const GITHUB_CLIENT_ID = "Ov23li4pwBKuNgPdSV2E";

// What CodeSync is allowed to do on GitHub. "repo" lets later milestones
// write to the user's repositories. Use "public_repo" to limit it to public ones.
const GITHUB_SCOPE = "repo";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

// Where things are stored
const GITHUB_AUTH_KEY = "githubAuth"; // chrome.storage.local   -> token + username (survives reloads)
const GITHUB_FLOW_KEY = "githubFlow"; // chrome.storage.session -> a sign-in that is in progress
const GITHUB_REPO_KEY = "githubRepo"; // chrome.storage.local   -> the chosen repository: { owner, repo }

// Repository listing (Milestone 8A)
const GITHUB_REPOS_URL = "https://api.github.com/user/repos";
const GITHUB_REPO_PAGE_SIZE = 100;     // the most GitHub allows per page
const GITHUB_MAX_REPO_PAGES = 10;      // safety limit: at most 1000 repositories

// ---------- Storage hardening ----------

// Only extension pages (popup, background) may read local storage.
// Content scripts that run inside web pages are NOT allowed to.
try {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => {});
} catch (error) {
  // Older Chrome versions do not have this setting. That is fine.
}

// ---------- Small helpers ----------

function githubSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Send a form-style POST and read the JSON answer.
// NOTE: never log the answer, it can contain the access token.
async function githubPostForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields)
  });
  return response.json();
}

async function getSavedAuth() {
  const stored = await chrome.storage.local.get(GITHUB_AUTH_KEY);
  return stored[GITHUB_AUTH_KEY] || null;
}

async function getFlow() {
  const stored = await chrome.storage.session.get(GITHUB_FLOW_KEY);
  return stored[GITHUB_FLOW_KEY] || null;
}

async function setFlow(flow) {
  await chrome.storage.session.set({ [GITHUB_FLOW_KEY]: flow });
}

async function clearFlow() {
  await chrome.storage.session.remove(GITHUB_FLOW_KEY);
}

async function failFlow(message) {
  console.warn("[CodeSync] GitHub authorization failed: " + message);
  await setFlow({ status: "failed", error: message });
}

// Fail only if this sign-in is still the current one (the user may have
// cancelled or started over while we were waiting for GitHub).
async function failFlowFor(deviceCode, message) {
  const flow = await getFlow();
  if (flow && flow.status === "pending" && flow.deviceCode === deviceCode) {
    await failFlow(message);
  }
}

// ---------- Step 1: ask GitHub for a code ----------

async function startGitHubConnect() {
  if (GITHUB_CLIENT_ID.startsWith("PASTE_")) {
    await failFlow("CodeSync is not configured yet: put your GitHub Client ID in github-auth.js.");
    return;
  }

  // Starting again replaces any sign-in that was already in progress
  await clearFlow();

  let data;
  try {
    data = await githubPostForm(GITHUB_DEVICE_CODE_URL, {
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE
    });
  } catch (error) {
    await failFlow("Could not reach GitHub. Check your internet connection.");
    return;
  }

  if (data.error) {
    if (data.error === "device_flow_disabled") {
      await failFlow('"Enable Device Flow" is not turned on in your GitHub OAuth App settings.');
    } else if (data.error === "incorrect_client_credentials") {
      await failFlow("The GitHub Client ID in github-auth.js is not correct.");
    } else {
      await failFlow("GitHub refused the request (" + data.error + ").");
    }
    return;
  }

  // Only ever send the user to a real github.com page
  if (
    !data.device_code ||
    !data.user_code ||
    typeof data.verification_uri !== "string" ||
    !data.verification_uri.startsWith("https://github.com/")
  ) {
    await failFlow("GitHub sent an unexpected answer.");
    return;
  }

  await setFlow({
    status: "pending",
    deviceCode: data.device_code,            // private, short-lived, never sent to the popup
    userCode: data.user_code,                // the short code the user types on GitHub
    verificationUri: data.verification_uri,  // https://github.com/login/device
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    interval: data.interval || 5             // seconds between checks
  });

  console.log("[CodeSync] GitHub sign-in started");
  pollForGitHubToken(); // keeps running in the background
}

// ---------- Step 2: wait until the user approves ----------

let githubPollingFor = null; // the device code we are currently polling for

async function pollForGitHubToken() {
  const startFlow = await getFlow();
  if (!startFlow || startFlow.status !== "pending") return;
  if (githubPollingFor === startFlow.deviceCode) return; // already polling
  githubPollingFor = startFlow.deviceCode;

  let interval = startFlow.interval;
  let networkErrors = 0;

  try {
    while (Date.now() < startFlow.expiresAt) {
      await githubSleep(interval * 1000);
      await chrome.runtime.getPlatformInfo(); // resets Chrome's idle timer for the worker

      // Stop quietly if the user cancelled or started a new sign-in
      const flow = await getFlow();
      if (!flow || flow.status !== "pending" || flow.deviceCode !== startFlow.deviceCode) {
        return;
      }

      let data;
      try {
        data = await githubPostForm(GITHUB_TOKEN_URL, {
          client_id: GITHUB_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        });
        networkErrors = 0;
      } catch (error) {
        networkErrors++;
        if (networkErrors >= 5) {
          await failFlowFor(startFlow.deviceCode, "Lost connection to GitHub.");
          return;
        }
        continue;
      }

      if (data.access_token) {
        await finishSignIn(data.access_token, startFlow.deviceCode);
        return;
      }

      switch (data.error) {
        case "authorization_pending":
          break; // the user has not approved yet, keep waiting
        case "slow_down":
          interval = data.interval || interval + 5; // GitHub asked us to check less often
          break;
        case "expired_token":
          await failFlowFor(startFlow.deviceCode, "The code expired. Click Connect GitHub to try again.");
          return;
        case "access_denied":
          await failFlowFor(startFlow.deviceCode, "Authorization was cancelled on GitHub.");
          return;
        default:
          await failFlowFor(
            startFlow.deviceCode,
            "GitHub sign-in failed (" + (data.error || "unknown error") + ")."
          );
          return;
      }
    }

    await failFlowFor(startFlow.deviceCode, "The code expired. Click Connect GitHub to try again.");
  } finally {
    if (githubPollingFor === startFlow.deviceCode) githubPollingFor = null;
  }
}

// ---------- Step 3: find out who signed in, then save ----------

async function finishSignIn(accessToken, deviceCode) {
  let username;
  try {
    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      await failFlowFor(deviceCode, "GitHub did not accept the new login (HTTP " + response.status + ").");
      return;
    }
    const user = await response.json();
    username = user.login;
  } catch (error) {
    await failFlowFor(deviceCode, "Could not read your GitHub account.");
    return;
  }

  if (!username) {
    await failFlowFor(deviceCode, "Could not read your GitHub username.");
    return;
  }

  // The user may have cancelled while we were checking
  const flow = await getFlow();
  if (!flow || flow.deviceCode !== deviceCode) return;

  await chrome.storage.local.remove(GITHUB_REPO_KEY); // a new login starts with no repository
  await chrome.storage.local.set({
    [GITHUB_AUTH_KEY]: {
      accessToken: accessToken,
      username: username,
      connectedAt: Date.now()
    }
  });
  await clearFlow();
  console.log("[CodeSync] GitHub connected");
}

// ---------- Cancel and disconnect ----------

async function cancelGitHubConnect() {
  await clearFlow();
}

async function disconnectGitHub() {
  await chrome.storage.local.remove(GITHUB_AUTH_KEY);
  await chrome.storage.local.remove(GITHUB_REPO_KEY); // the choice is no longer valid
  await clearFlow();
  console.log("[CodeSync] GitHub disconnected");
}

// ---------- What the popup is allowed to see ----------

// Never includes the access token or the device code.
async function getGitHubStatus() {
  const auth = await getSavedAuth();
  if (auth) {
    return {
      state: "connected",
      username: auth.username,
      repository: await getSelectedRepository() // { owner, repo } or null
    };
  }

  const flow = await getFlow();
  if (flow && flow.status === "pending") {
    return {
      state: "pending",
      userCode: flow.userCode,
      verificationUri: flow.verificationUri
    };
  }
  if (flow && flow.status === "failed") {
    return { state: "disconnected", error: flow.error };
  }
  return { state: "disconnected" };
}

// For LATER milestones (uploading). Only code inside the service worker can call
// this. It is deliberately NOT available through messages.
async function getGitHubToken() {
  const auth = await getSavedAuth();
  return auth ? auth.accessToken : null;
}

// ---------- Milestone 8A: choosing a repository ----------

// Talk to the GitHub API using the saved token. The token is read here, inside the
// service worker, and is never returned to the caller.
// Returns { ok: true, data } or { ok: false, status, error, githubMessage }.
// (githubMessage is only for the worker's own decisions. It is never sent to the popup.)
async function githubApiRequest(method, url, body) {
  const token = await getGitHubToken();
  if (!token) {
    return { ok: false, status: 0, error: "GitHub is not connected." };
  }

  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const options = { method: method, headers: headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    return { ok: false, status: 0, error: "Could not reach GitHub. Check your internet connection." };
  }

  if (!response.ok) {
    // GitHub explains most errors in a "message" field
    let githubMessage = "";
    try {
      const errorBody = await response.json();
      if (errorBody && typeof errorBody.message === "string") githubMessage = errorBody.message;
    } catch (error) {
      // no readable body, that is fine
    }

    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        githubMessage: githubMessage,
        error: "GitHub no longer accepts your login. Click Disconnect, then connect again."
      };
    }
    if (response.status === 403 || response.status === 429) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0";
      return {
        ok: false,
        status: response.status,
        githubMessage: githubMessage,
        error: limited
          ? "GitHub rate limit reached. Try again in a few minutes."
          : "GitHub denied this request (HTTP " + response.status + "). If the repository belongs to an organization, the organization may need to approve CodeSync."
      };
    }
    return {
      ok: false,
      status: response.status,
      githubMessage: githubMessage,
      error: "GitHub returned an error (HTTP " + response.status + ")."
    };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, status: response.status, error: "GitHub sent an unreadable answer." };
  }
}

async function githubApiGet(url) {
  return githubApiRequest("GET", url);
}

// A repository CodeSync can reasonably write to: you can push, and it is not
// archived (read-only) or disabled.
function isUsableRepository(repo) {
  return Boolean(repo && repo.permissions && repo.permissions.push) && !repo.archived && !repo.disabled;
}

// GITHUB_LIST_REPOSITORIES
// Returns { ok: true, repositories: [...], truncated } or { ok: false, error }.
async function listGitHubRepositories() {
  const repositories = [];
  let truncated = false;

  for (let page = 1; page <= GITHUB_MAX_REPO_PAGES; page++) {
    const url =
      GITHUB_REPOS_URL +
      "?per_page=" + GITHUB_REPO_PAGE_SIZE +
      "&sort=full_name" +
      "&affiliation=owner,collaborator,organization_member" +
      "&page=" + page;

    const result = await githubApiGet(url);
    if (!result.ok) return { ok: false, error: result.error };
    if (!Array.isArray(result.data)) {
      return { ok: false, error: "GitHub sent an unexpected answer." };
    }

    for (const repo of result.data) {
      if (!isUsableRepository(repo)) continue;
      // Only safe, simple facts. Never anything related to the token.
      repositories.push({
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        private: Boolean(repo.private),
        canPush: true
      });
    }

    if (result.data.length < GITHUB_REPO_PAGE_SIZE) break; // that was the last page
    if (page === GITHUB_MAX_REPO_PAGES) truncated = true;
  }

  return { ok: true, repositories: repositories, truncated: truncated };
}

// GITHUB_SAVE_REPOSITORY
// Checks the repository with GitHub first, then stores ONLY { owner, repo }.
async function saveGitHubRepository(owner, repo) {
  const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;
  const onlyDots = /^\.+$/;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !namePattern.test(owner) ||
    !namePattern.test(repo) ||
    onlyDots.test(owner) ||
    onlyDots.test(repo)
  ) {
    return { ok: false, error: "That repository name is not valid." };
  }

  const result = await githubApiGet(
    "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo)
  );
  if (!result.ok) {
    if (result.status === 404) {
      return { ok: false, error: "That repository was not found, or you no longer have access to it." };
    }
    return { ok: false, error: result.error };
  }
  if (!isUsableRepository(result.data)) {
    return { ok: false, error: "You cannot push to that repository, or it is archived." };
  }

  // The user may have disconnected while we were checking
  if (!(await getSavedAuth())) {
    return { ok: false, error: "GitHub is not connected." };
  }

  await chrome.storage.local.set({
    [GITHUB_REPO_KEY]: { owner: result.data.owner.login, repo: result.data.name }
  });
  return { ok: true };
}

// For LATER milestones (uploading): which repository did the user choose?
async function getSelectedRepository() {
  const stored = await chrome.storage.local.get(GITHUB_REPO_KEY);
  const saved = stored[GITHUB_REPO_KEY];
  if (saved && saved.owner && saved.repo) {
    return { owner: saved.owner, repo: saved.repo };
  }
  return null;
}

// ---------- Milestone 8B-2: upload an accepted solution ----------

const GITHUB_MAX_NAME_ATTEMPTS = 500; // safety limit for solution, solution_1, solution_2, ...

// GitHub wants file contents as Base64 text. TextEncoder turns the text into
// UTF-8 bytes (so accents, symbols and emoji survive), then btoa turns the bytes
// into Base64. Nothing in the text is changed: spaces, tabs and line endings stay.
function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000; // build the string in pieces so big files are fine
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// "800/A_Watermelon/solution.cpp" -> each part is URL-encoded, the "/" stays a "/"
function encodeRepoPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Put the number BEFORE the extension of the file name:
//   ("800/A_Watermelon/solution.cpp", 0) -> "800/A_Watermelon/solution.cpp"
//   ("800/A_Watermelon/solution.cpp", 1) -> "800/A_Watermelon/solution_1.cpp"
//   ("800/A_Watermelon/solution.py", 2)  -> "800/A_Watermelon/solution_2.py"
function pathWithNumber(path, number) {
  if (number === 0) return path;
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= lastSlash) return path + "_" + number; // file name has no extension
  return path.slice(0, lastDot) + "_" + number + path.slice(lastDot);
}

// A path we are willing to write: no empty parts, no "." or ".." parts
function isSafeRepoPath(path) {
  if (typeof path !== "string" || path === "") return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function githubContentsUrl(owner, repo, path) {
  return (
    "https://api.github.com/repos/" +
    encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/contents/" +
    encodeRepoPath(path)
  );
}

// Does this path already exist in the repository? Asks GitHub every time.
//   200 -> { exists: true }    404 -> { exists: false }
//   anything else -> { error }  (we never guess that a file is missing)
async function repoPathExists(owner, repo, path) {
  const result = await githubApiRequest("GET", githubContentsUrl(owner, repo, path));
  if (result.ok) return { exists: true };
  if (result.status === 404) return { exists: false };
  return { error: result.error };
}

// A readable reason for a failed write (the raw GitHub text is not echoed)
function describeWriteError(write, repositoryName) {
  if (write.status === 422) return "GitHub rejected the file (HTTP 422).";
  if (write.status === 409) return "GitHub reported a conflict while saving the file.";
  if (write.status === 404) {
    return "Repository not found, or CodeSync does not have write access to " + repositoryName + ".";
  }
  if (write.status === 403 && !/rate limit/i.test(write.error)) {
    return "Permission denied: GitHub refused the write to " + repositoryName + ". You may not have write access, branch protection may block direct commits, or an organization may need to approve CodeSync.";
  }
  return write.error;
}

// Uploads are done one at a time, so two accepted submissions for the same
// problem can never fight over the same file name inside this worker.
let githubUploadChain = Promise.resolve();

// Called by background.js after an accepted submission.
// details = { submissionId, path, source }. Never throws.
function uploadSolutionToGitHub(details) {
  const run = githubUploadChain.then(() => runGitHubUpload(details));
  githubUploadChain = run.catch(() => {});
  return run;
}

async function runGitHubUpload(details) {
  const fail = (message) => {
    console.error("[CodeSync] GitHub upload failed: " + message);
    return { success: false, error: message };
  };

  try {
    const submissionId = details && details.submissionId;
    const path = details && details.path;
    const source = details && details.source;

    if (typeof source !== "string" || source.length === 0) {
      return fail("Unable to retrieve source code.");
    }
    if (!isSafeRepoPath(path)) {
      return fail("The generated path is not valid.");
    }

    // 1. Is GitHub connected?
    if (!(await getSavedAuth())) {
      console.warn("[CodeSync] GitHub upload skipped: GitHub is not connected. Open CodeSync and click Connect GitHub.");
      return { success: false, error: "GitHub is not connected." };
    }

    // 2. Which repository did the user choose?
    const selected = await getSelectedRepository();
    if (!selected) {
      console.warn("[CodeSync] GitHub upload skipped: no repository is selected. Open CodeSync and choose one.");
      return { success: false, error: "No repository is selected." };
    }
    const repositoryName = selected.owner + "/" + selected.repo;

    // 3. Can we write to it? (also tells us the default branch, for the log)
    const info = await githubApiRequest(
      "GET",
      "https://api.github.com/repos/" + encodeURIComponent(selected.owner) + "/" + encodeURIComponent(selected.repo)
    );
    if (!info.ok) {
      if (info.status === 404) {
        return fail("Repository not found: " + repositoryName + " (or you no longer have access to it).");
      }
      return fail(info.error);
    }
    if (!isUsableRepository(info.data)) {
      return fail("Permission denied: you cannot push to " + repositoryName + ", or it is archived.");
    }
    const defaultBranch = typeof info.data.default_branch === "string" ? info.data.default_branch : "";

    // 4. Encode the exact source once
    const content = utf8ToBase64(source);

    // 5. Find the first unused name and create the file there
    for (let number = 0; number < GITHUB_MAX_NAME_ATTEMPTS; number++) {
      const candidate = pathWithNumber(path, number);

      const lookup = await repoPathExists(selected.owner, selected.repo, candidate);
      if (lookup.error) {
        return fail("Unable to determine whether " + candidate + " exists: " + lookup.error);
      }
      if (lookup.exists) continue; // taken, try the next number

      // No "sha" is sent, so GitHub can only CREATE a file here, never replace one.
      // No "branch" is sent, so GitHub uses the repository's default branch.
      const write = await githubApiRequest(
        "PUT",
        githubContentsUrl(selected.owner, selected.repo, candidate),
        {
          message: "Add " + candidate + " (Codeforces submission " + submissionId + ")",
          content: content
        }
      );

      if (write.ok) {
        console.log("[CodeSync] GitHub upload successful");
        console.log("[CodeSync] Repository: " + repositoryName);
        console.log("[CodeSync] Path: " + candidate);
        console.log("[CodeSync] Submission ID: " + submissionId);
        if (defaultBranch) console.log("[CodeSync] Branch: " + defaultBranch);
        return { success: true, path: candidate, repository: repositoryName };
      }

      // Someone created this exact file between our check and our write.
      // GitHub refused to overwrite it, so move on to the next name (and say so).
      if (write.status === 422 && /sha/i.test(write.githubMessage || "")) {
        console.warn("[CodeSync] " + candidate + " was created a moment ago by someone else. Trying the next name.");
        continue;
      }

      return fail(describeWriteError(write, repositoryName));
    }

    return fail("Too many existing solution files for this problem (" + GITHUB_MAX_NAME_ATTEMPTS + " names checked).");
  } catch (error) {
    return fail("Unexpected error (" + (error && error.name ? error.name : "unknown") + ").");
  }
}

// ---------- Messages from the popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (!message.type.startsWith("GITHUB_")) return; // not ours (Codeforces messages)

  // Only our own popup may control sign-in, never a content script on a web page
  if (sender.id !== chrome.runtime.id || sender.tab) return;

  let work;
  if (message.type === "GITHUB_GET_STATUS") {
    work = getGitHubStatus();
  } else if (message.type === "GITHUB_CONNECT") {
    work = startGitHubConnect().then(() => getGitHubStatus());
  } else if (message.type === "GITHUB_CANCEL") {
    work = cancelGitHubConnect().then(() => getGitHubStatus());
  } else if (message.type === "GITHUB_DISCONNECT") {
    work = disconnectGitHub().then(() => getGitHubStatus());
  } else if (message.type === "GITHUB_LIST_REPOSITORIES") {
    work = listGitHubRepositories();
  } else if (message.type === "GITHUB_SAVE_REPOSITORY") {
    work = saveGitHubRepository(message.owner, message.repo).then(async (result) => ({
      ok: result.ok,
      error: result.error,
      status: await getGitHubStatus()
    }));
  } else {
    return;
  }

  work
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, success: false, state: "disconnected", error: "Something went wrong." }));

  return true; // we will answer asynchronously
});

// ---------- Service worker restarts ----------

// Chrome may stop the service worker while the user is on GitHub.
// When it starts again, continue waiting if a sign-in is still in progress.
pollForGitHubToken().catch(() => {});