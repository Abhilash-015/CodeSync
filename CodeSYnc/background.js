// Milestone 7: GitHub authentication lives in its own file
importScripts("github-auth.js");

const POLL_INTERVAL_MS = 3000;          // check every 3 seconds
const MAX_WAIT_MS = 5 * 60 * 1000;      // give up after 5 minutes
const CLOCK_TOLERANCE_MS = 30 * 1000;   // allow for small clock differences

// IDs we are already watching, so two submits never track the same one
const trackedIds = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ask the public Codeforces API for the user's most recent submissions
async function fetchRecentSubmissions(handle) {
  const url =
    "https://codeforces.com/api/user.status?handle=" +
    encodeURIComponent(handle) +
    "&from=1&count=10";
  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== "OK") {
    throw new Error(data.comment || "Codeforces API error");
  }
  return data.result; // newest submission first
}

// Find the submission the user just made
function findNewSubmission(submissions, submittedAt) {
  const candidates = submissions.filter(
    (s) =>
      s.creationTimeSeconds * 1000 >= submittedAt - CLOCK_TOLERANCE_MS &&
      !trackedIds.has(s.id)
  );
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1]; // oldest of the new ones
}

// No verdict yet, or still being tested = not finished
function isStillJudging(verdict) {
  return !verdict || verdict === "TESTING";
}

// ---------- Metadata ----------

function getProblemMetadata(submission) {
  const problem = submission.problem;
  return {
    submissionId: submission.id,
    problemName: problem.name,
    problemIndex: problem.index,
    // a number like 800, or the text "unrated" if Codeforces gave no rating
    rating: typeof problem.rating === "number" ? problem.rating : "unrated",
    language: submission.programmingLanguage
  };
}

function logAcceptedMetadata(submission) {
  const meta = getProblemMetadata(submission);

  console.log("[CodeSync] ACCEPTED submission detected");
  console.log("[CodeSync] Problem: " + meta.problemIndex + ". " + meta.problemName);
  console.log("[CodeSync] Problem Index: " + meta.problemIndex);
  console.log("[CodeSync] Rating: " + meta.rating);
  console.log("[CodeSync] Language: " + meta.language);
}

// ---------- Source code retrieval ----------

// Ask the Codeforces tab to fetch the code for this exact submission ID
async function fetchSourceCode(submission, tabId) {
  if (tabId === undefined) {
    throw new Error("no Codeforces tab to ask");
  }

  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, {
      type: "FETCH_SOURCE",
      submissionId: submission.id // the exact submission CodeSync detected
    });
  } catch (error) {
    throw new Error(
      "could not reach the Codeforces tab (was it closed, or not refreshed after reloading the extension?)"
    );
  }

  if (!reply || !reply.ok) {
    throw new Error(reply ? reply.error : "no reply from the page");
  }
  return reply.source;
}

async function retrieveAndLogSource(submission, tabId) {
  try {
    const source = await fetchSourceCode(submission, tabId);
    console.log("[CodeSync] Source code retrieved");
    console.log("[CodeSync] Source length: " + source.length);
    return source;
  } catch (error) {
    console.warn("[CodeSync] Could not retrieve source code: " + error.message);
    return null;
  }
}

// ---------- Milestone 6: GitHub path generation ----------

// Each rule is [pattern, extension]. The language name is lower-cased and
// checked against the rules from top to bottom. The FIRST match wins, so the
// order matters (for example JavaScript must be checked before Java).
const LANGUAGE_RULES = [
  [/\+\+/, "cpp"],                   // GNU C++17, GNU C++20, Clang++17, MS C++ ...
  [/f#/, "fs"],                      // F#
  [/c#/, "cs"],                      // C#, Mono C#
  [/typescript/, "ts"],              // TypeScript
  [/javascript|node\.?js/, "js"],    // JavaScript V8, Node.js (before Java!)
  [/kotlin/, "kt"],                  // Kotlin
  [/java/, "java"],                  // Java 17, Java 21 ...
  [/python|pypy/, "py"],             // Python 3, PyPy 3-64 ...
  [/rust/, "rs"],                    // Rust 2021
  [/^go\b/, "go"],                   // Go 1.22
  [/php/, "php"],                    // PHP 8.1
  [/ruby/, "rb"],                    // Ruby
  [/scala/, "scala"],                // Scala
  [/haskell/, "hs"],                 // Haskell
  [/^(gnu\s+)?(gcc\s+)?c\d*(\s|$)/, "c"] // C, GNU C11, GNU GCC C11
];

// Turn a Codeforces language name into a file extension.
// Returns null if the language is not supported.
function getFileExtension(language) {
  const name = String(language || "").toLowerCase().trim();
  for (const [pattern, extension] of LANGUAGE_RULES) {
    if (pattern.test(name)) return extension;
  }
  return null;
}

// Make a problem name safe to use as part of a path.
// "Bear and Prime 100" -> "Bear_and_Prime_100"
// "A/B\C"              -> "A_B_C"
function sanitizeProblemName(name) {
  let result = String(name || "").trim();
  result = result.replace(/['\u2019]/g, "");               // Vasya's -> Vasyas
  result = result.replace(/[^\p{L}\p{N}_-]+/gu, "_");      // spaces, / \ and symbols -> _
  result = result.replace(/_+/g, "_");                     // no repeated underscores
  result = result.replace(/^[_-]+|[_-]+$/g, "");           // trim _ and - at the ends
  return result || "Problem";                              // never an empty name
}

// Build the full path, for example "800/A_Watermelon/solution.cpp".
// Returns null (and logs a warning) if a safe path cannot be made.
function generateGitHubPath(metadata) {
  const extension = getFileExtension(metadata.language);
  if (extension === null) {
    console.warn(
      '[CodeSync] Cannot generate GitHub path: unsupported language "' +
        metadata.language +
        '"'
    );
    return null;
  }

  // Keep only letters and digits in the index (A, B, C1, ...)
  const problemIndex = String(metadata.problemIndex || "").replace(/[^A-Za-z0-9]/g, "");
  if (problemIndex === "") {
    console.warn("[CodeSync] Cannot generate GitHub path: problem index is missing");
    return null;
  }

  // A real number is used as the folder; anything else becomes "unrated"
  const ratingFolder = Number.isInteger(metadata.rating)
    ? String(metadata.rating)
    : "unrated";

  const problemFolder = problemIndex + "_" + sanitizeProblemName(metadata.problemName);

  return ratingFolder + "/" + problemFolder + "/solution." + extension;
}

// Run this from the service worker console:  runPathTests()
function runPathTests() {
  const tests = [
    {
      name: "Rated C++ problem",
      input: { problemName: "Watermelon", problemIndex: "A", rating: 800, language: "GNU C++17" },
      expected: "800/A_Watermelon/solution.cpp"
    },
    {
      name: "Rated Python problem",
      input: { problemName: "Way Too Long Words", problemIndex: "A", rating: 800, language: "Python 3.8.10" },
      expected: "800/A_Way_Too_Long_Words/solution.py"
    },
    {
      name: "Unrated C++ problem",
      input: { problemName: "Some Problem", problemIndex: "A", rating: "unrated", language: "GNU C++20 (64)" },
      expected: "unrated/A_Some_Problem/solution.cpp"
    },
    {
      name: "Name with spaces",
      input: { problemName: "Bear and Prime 100", problemIndex: "B", rating: 2000, language: "GNU C++17" },
      expected: "2000/B_Bear_and_Prime_100/solution.cpp"
    },
    {
      name: 'Name with "/" and "\\"',
      input: { problemName: "A/B \\ Game", problemIndex: "C", rating: 1200, language: "Java 21" },
      expected: "1200/C_A_B_Game/solution.java"
    },
    {
      name: "Unsupported language",
      input: { problemName: "Watermelon", problemIndex: "A", rating: 800, language: "Befunge 98" },
      expected: null
    },
    {
      name: "Other language names",
      input: { problemName: "Test", problemIndex: "D", rating: 1500, language: "PyPy 3-64" },
      expected: "1500/D_Test/solution.py"
    },
    {
      name: "C language",
      input: { problemName: "Test", problemIndex: "A", rating: 900, language: "GNU C11 5.1.0" },
      expected: "900/A_Test/solution.c"
    },
    {
      name: "JavaScript is not Java",
      input: { problemName: "Test", problemIndex: "A", rating: 900, language: "JavaScript V8 4.8.0" },
      expected: "900/A_Test/solution.js"
    },
    {
      name: "C# language",
      input: { problemName: "Test", problemIndex: "A", rating: 900, language: "C# 8, .NET Core 3.1" },
      expected: "900/A_Test/solution.cs"
    },
    {
      name: "Index with a number",
      input: { problemName: "Mr. Kitayuta's Gift", problemIndex: "C2", rating: 1600, language: "Kotlin 1.7" },
      expected: "1600/C2_Mr_Kitayutas_Gift/solution.kt"
    }
  ];

  let passed = 0;
  for (const test of tests) {
    const actual = generateGitHubPath(test.input);
    const ok = actual === test.expected;
    if (ok) passed++;
    console.log(
      (ok ? "PASS" : "FAIL") + " - " + test.name + " -> " + actual +
        (ok ? "" : " (expected " + test.expected + ")")
    );
  }
  console.log("[CodeSync] Path tests: " + passed + "/" + tests.length + " passed");
}

// ---------- Watching a submission until it is judged ----------

async function watchSubmission(handle, submittedAt, tabId) {
  const startedAt = Date.now();
  let submissionId = null;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    try {
      const submissions = await fetchRecentSubmissions(handle);
      let submission;

      if (submissionId === null) {
        // Step 1: find which submission is ours
        submission = findNewSubmission(submissions, submittedAt);
        if (submission) {
          submissionId = submission.id;
          trackedIds.add(submissionId);
          console.log("[CodeSync] Submission ID: " + submissionId);
          console.log("[CodeSync] Waiting for verdict...");
        }
      } else {
        // Step 2: look up the same submission again
        submission = submissions.find((s) => s.id === submissionId);
      }

      // Step 3: is judging finished?
      if (submission && !isStillJudging(submission.verdict)) {
        console.log("[CodeSync] Verdict: " + submission.verdict);
        if (submission.verdict === "OK") {
          logAcceptedMetadata(submission);
          const source = await retrieveAndLogSource(submission, tabId); // handles its own errors

          // Milestone 6: only make a path once we have the code
          if (source !== null) {
            const path = generateGitHubPath(getProblemMetadata(submission));
            if (path !== null) {
              console.log("[CodeSync] GitHub path: " + path);
            }
          } else {
            console.warn("[CodeSync] Skipping GitHub path: source code was not retrieved.");
          }
        } else {
          console.log("[CodeSync] Submission not accepted.");
        }
        return;
      }
    } catch (error) {
      console.warn("[CodeSync] Check failed, will retry:", error.message);
    }

    // Calling an extension API resets Chrome's idle timer for the worker
    await chrome.runtime.getPlatformInfo();
    await sleep(POLL_INTERVAL_MS);
  }

  console.warn("[CodeSync] Gave up waiting for a verdict.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUBMISSION_DETECTED") {
    console.log("[CodeSync] Submission detected");

    if (!message.handle) {
      console.warn("[CodeSync] Could not read your handle. Are you logged in?");
      sendResponse({ ok: false });
      return;
    }

    // sender.tab.id is the tab the submission came from
    const tabId = sender.tab ? sender.tab.id : undefined;
    watchSubmission(message.handle, message.submittedAt, tabId); // runs in background
    sendResponse({ ok: true });
  }
});