const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const readFileSync = require("fs").readFileSync;

const { debug, formatLineNumbers } = require("./index.utils");

class Variables {
  static _instance = null;
  _variables = {};

  constructor() {
    if (Variables._instance) {
      return Variables._instance;
    }

    const token = core.getInput("github-token", { required: true });

    const quietInput = core.getInput("quiet", { required: false }) || "false";
    const quiet = ["true", "yes", "on"].includes(quietInput.toLowerCase());

    const pullRequest = github.context.payload.pull_request;

    this._variables = {
      mainBranch: core.getInput("main-branch", { required: false }) || "main",
      octokit: github.getOctokit(token),
      pullRequestAuthor: pullRequest.user.login,
      pullRequestName: null,
      pullRequestNumber: pullRequest.number,
      quiet,
      repo: github.context.repo,
      token,
    };

    Variables._instance = this;
  }

  set(name, value) {
    this._variables[name] = value;
  }

  get(name) {
    return this._variables[name];
  }
}

async function main() {
  try {
    await setup();

    const conflictArray = await getConflictArrayData();

    if (conflictArray.length > 0) {
      const quiet = new Variables().get("quiet");
      if (!quiet) {
        await createConflictComment(conflictArray);
      }

      await requestReviews(conflictArray);

      await requestReviewsInConflictingPRs(conflictArray);
    }
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    cleanup();
  }
}

async function setup() {
  const variables = new Variables();
  const pullRequestNumber = variables.get("pullRequestNumber");
  const mainBranch = variables.get("mainBranch");

  try {
    const pullRequestName = await getBranchName(pullRequestNumber);

    variables.set("pullRequestName", pullRequestName);

    // Configure Git with a dummy user identity
    execSync(`git config user.email "action@github.com"`);
    execSync(`git config user.name "GitHub Action"`);

    execSync(`git fetch origin ${mainBranch}:${mainBranch}`);

    // Fetch PR branches into temporary refs
    execSync(
      `git fetch origin ${pullRequestName}:refs/remotes/origin/tmp_${pullRequestName}`
    );

    // Merge main into pull request branch in memory
    execSync(`git checkout refs/remotes/origin/tmp_${pullRequestName}`);
    execSync(`git merge ${mainBranch} --no-commit --no-ff`);
    execSync(`git reset --hard HEAD`);
  } catch (error) {
    console.error(`Error during setup: ${error.message}`);
    throw error;
  }
}

function cleanup() {
  try {
    const pullRequest = github.context.payload.pull_request;

    execSync(`git update-ref -d refs/remotes/origin/tmp_${pullRequest.number}`);
  } catch (e) {
    console.error(`Error during cleanup: ${error.message}`);
    throw error;
  }
}

async function getOpenPullRequests() {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const repo = variables.get("repo");

  try {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      per_page: 100,
    });

    // Map the list to only contain relevant information (PR number and author)
    const openPullRequests = pullRequests.map((pr) => ({
      number: pr.number,
      author: pr.user.login,
    }));

    return openPullRequests;
  } catch (error) {
    console.error(`Error fetching open pull requests: ${error.message}`);
    throw error;
  }
}

async function getConflictArrayData() {
  const variables = new Variables();
  const pullRequestNumber = variables.get("pullRequestNumber");

  const openPullRequests = await getOpenPullRequests();
  const otherOpenPullRequests = openPullRequests.filter(
    (pr) => pr.number !== pullRequestNumber
  );

  const conflictArray = [];

  for (const openPullRequest of otherOpenPullRequests) {
    const conflictData = await checkForConflicts(openPullRequest.number);

    if (Object.keys(conflictData).length > 0) {
      conflictArray.push({
        number: openPullRequest.number,
        author: openPullRequest.author,
        conflictData,
      });
    }
  }

  return conflictArray;
}

async function checkForConflicts(otherPullRequestNumber) {
  const variables = new Variables();
  const pullRequestName = variables.get("pullRequestName");
  const pullRequestNumber = variables.get("pullRequestNumber");

  const otherPullRequestName = await getBranchName(otherPullRequestNumber);

  if (!pullRequestName || !otherPullRequestName) {
    throw new Error("Failed to fetch branch name for one or both PRs.");
  }

  const pullRequestFiles = await getChangedFiles(pullRequestNumber);

  const otherPullRequestFiles = await getChangedFiles(otherPullRequestNumber);

  const overlappingFiles = pullRequestFiles.filter((file) =>
    otherPullRequestFiles.includes(file)
  );

  if (!overlappingFiles.length) {
    return [];
  }

  const conflictData = await attemptMerge(otherPullRequestName);

  return conflictData;
}

async function getBranchName(anyPullRequestNumber) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const repo = variables.get("repo");

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: anyPullRequestNumber,
  });

  return pr.head.ref;
}

async function getChangedFiles(anyPullRequestNumber) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const repo = variables.get("repo");

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: anyPullRequestNumber,
  });

  return files.map((file) => file.filename);
}

function extractConflictingLineNumbers(filePath) {
  const fileContent = readFileSync(filePath, "utf8");
  const lines = fileContent.split("\n");

  let lineCounter = 0;
  const conflictLines = [];
  let oursBlock = [];
  let theirsBlock = [];
  let inOursBlock = false;
  let inTheirsBlock = false;
  let conflictStartLine = 0;

  for (const line of lines) {
    if (!inOursBlock && !inTheirsBlock) {
      lineCounter++; // Increment only outside of conflict blocks.
    }

    debug(lineCounter, line);

    if (line.startsWith("<<<<<<< HEAD")) {
      inOursBlock = true;
      conflictStartLine = lineCounter;
      continue;
    }

    if (line.startsWith("=======")) {
      inOursBlock = false;
      inTheirsBlock = true;
      continue;
    }

    if (line.startsWith(">>>>>>>")) {
      inTheirsBlock = false;

      oursBlock.forEach((ourLine, index) => {
        if (
          theirsBlock[index] !== undefined &&
          ourLine !== theirsBlock[index]
        ) {
          const actualLineNumber = conflictStartLine + index;
          conflictLines.push(actualLineNumber);
        }
      });

      oursBlock = [];
      theirsBlock = [];

      lineCounter += theirsBlock.length;
      continue;
    }

    if (inOursBlock) {
      oursBlock.push(line);
    } else if (inTheirsBlock) {
      theirsBlock.push(line);
    }
  }

  return conflictLines;
}

async function attemptMerge(otherPullRequestName) {
  const variables = new Variables();
  const mainBranch = variables.get("mainBranch");
  const pullRequestName = variables.get("pullRequestName");

  const conflictData = {};

  try {
    debug(
      `Attempting to merge #${otherPullRequestName} into #${pullRequestName}`
    );

    execSync(
      `git fetch origin ${otherPullRequestName}:refs/remotes/origin/tmp_${otherPullRequestName}`
    );

    // Merge main into other pull request in memory
    execSync(`git checkout refs/remotes/origin/tmp_${otherPullRequestName}`);
    execSync(`git merge ${mainBranch} --no-commit --no-ff`);
    execSync(`git reset --hard HEAD`);

    execSync(`git checkout refs/remotes/origin/tmp_${pullRequestName}`);

    try {
      // Attempt to merge other pull request branch in memory without committing or fast-forwarding
      execSync(
        `git merge refs/remotes/origin/tmp_${otherPullRequestName} --no-commit --no-ff`
      );

      debug(`${otherPullRequestName} merge successful. No conflicts found.`);
    } catch (mergeError) {
      const stdoutStr = mergeError.stdout.toString();
      if (stdoutStr.includes("Automatic merge failed")) {
        const output = execSync(
          "git diff --name-only --diff-filter=U"
        ).toString();
        const conflictFileNames = output.split("\n").filter(Boolean);

        for (const filename of conflictFileNames) {
          debug(`Extracting conflicting line numbers for ${filename}`);
          conflictData[filename] = extractConflictingLineNumbers(filename);
        }
      }
    }
  } catch (error) {
    console.error(`Error during merge process: ${error.message}`);
  } finally {
    execSync(`git reset --hard HEAD`); // Reset any changes
    // Cleanup by deleting temporary refs
    execSync(
      `git update-ref -d refs/remotes/origin/tmp_${otherPullRequestName}`
    );
  }

  return conflictData;
}

async function createConflictComment(conflictArray) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const pullRequestNumber = variables.get("pullRequestNumber");
  const repo = variables.get("repo");

  try {
    let conflictMessage = "### 🤖 Merge Issues Detected\n\n";

    for (const data of conflictArray) {
      conflictMessage += `<details>\n`;
      conflictMessage += `  <summary><strong>Pull Request #${data.number}</strong></summary>\n`;

      for (const [fileName, lineNumbers] of Object.entries(data.conflictData)) {
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: data.number,
        });

        const blobUrl = files.find(
          (file) => file.filename === fileName
        ).blob_url;

        conflictMessage += `\u00A0\u00A0\u00A0 <strong><a href="${blobUrl}">${fileName}</a> \u2015 </strong> ${formatLineNumbers(
          lineNumbers
        )}<br />`;
      }

      conflictMessage += `</details>\n\n`;
    }

    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: pullRequestNumber,
      body: conflictMessage,
    });
  } catch (error) {
    console.error(`Error creating conflict comment: ${error.message}`);
    throw error;
  }
}

async function requestReviews(conflictArray) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const pullRequestAuthor = variables.get("pullRequestAuthor");
  const pullRequestNumber = variables.get("pullRequestNumber");
  const repo = variables.get("repo");

  try {
    const reviewers = [
      ...new Set(
        conflictArray
          .map((conflict) => conflict.author)
          .filter((author) => author !== pullRequestAuthor)
      ),
    ];

    debug(`Requesting reviews from ${reviewers.join(", ")}`);

    await octokit.rest.pulls.requestReviewers({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullRequestNumber,
      reviewers: reviewers,
    });
  } catch (error) {
    console.error(`Error requesting reviews: ${error.message}`);
    throw error;
  }
}

async function requestReviewsInConflictingPRs(conflictArray) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const pullRequestAuthor = variables.get("pullRequestAuthor");
  const repo = variables.get("repo");

  try {
    for (const conflict of conflictArray) {
      if (conflict.author !== pullRequestAuthor) {
        debug(
          `Requesting review from ${pullRequestAuthor} in #${conflict.number}`
        );

        await octokit.rest.pulls.requestReviewers({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: conflict.number,
          reviewers: [pullRequestAuthor],
        });
      }
    }
  } catch (error) {
    console.error(
      `Error requesting reviews in conflicting PRs: ${error.message}`
    );
    throw error;
  }
}

main();
