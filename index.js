const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const readFileSync = require("fs").readFileSync;

const { debug, formatLineNumbers } = require("./index.utils");
const excludedFiles = ["go.mod", "go.sum", "vendor/"];

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
      pullRequestBranch: pullRequest.head.ref,
      pullRequestNumber: pullRequest.number,
      quiet,
      repo: github.context.repo,
      token,
      isFork: pullRequest.head.repo.fork,
      headRepo: pullRequest.head.repo.full_name,
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
  if (github.context.payload.pull_request.draft) {
    debug(`Not running any checks because this pull request is a draft.`)
    return
  }

  try {
    await setup();

    const conflictArray = await getConflictArrayData();

    if (conflictArray.length > 0) {
      const quiet = new Variables().get("quiet");

      // Request reviews from conflicting PR authors for this PR.
      const reviews_requested_on_pr = await requestReviews(conflictArray);
      // Add this PR's author as a reviewer on conflicting PRs.
      const reviews_requested_on_conflicting_prs = await requestReviewsInConflictingPRs(conflictArray);

      if (!quiet && (reviews_requested_on_pr > 0 || reviews_requested_on_conflicting_prs > 0)) {
        await createConflictComment(conflictArray);
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    cleanup();
  }
}

async function setup() {
  const variables = new Variables();
  const mainBranch = variables.get("mainBranch");
  const pullRequestBranch = variables.get("pullRequestBranch");
  const pullRequestAuthor = variables.get("pullRequestAuthor");
  const headRepo = variables.get("headRepo"); 

  try {
    // Configure Git with a dummy user identity.
    execSync(`git config user.email "action@github.com"`);
    execSync(`git config user.name "GitHub Action"`);

    execSync(`git fetch origin ${mainBranch}:${mainBranch}`);

    // Fetch PR branches into temporary refs.
    if (variables.get("isFork")) {
      execSync(
        `git remote add ${pullRequestAuthor} https://github.com/${headRepo}.git`
      );
      execSync(
        `git fetch ${pullRequestAuthor} ${pullRequestBranch}:refs/remotes/origin/tmp_${pullRequestBranch}`
      );
    } else {
      execSync(
        `git fetch origin ${pullRequestBranch}:refs/remotes/origin/tmp_${pullRequestBranch}`
      );
    } 

    // Merge main into pull request branch in memory.
    execSync(`git checkout refs/remotes/origin/tmp_${pullRequestBranch}`);
    execSync(`git merge ${mainBranch} --no-commit --no-ff`);
    execSync(`git reset --hard HEAD`);
  } catch (error) {
    console.error(`Error during setup: ${error.message}`);
    throw error;
  }
}

async function getConflictArrayData() {
  const variables = new Variables();
  const pullRequestNumber = variables.get("pullRequestNumber");

  const openPullRequests = await getOpenPullRequests();
  const otherPullRequests = openPullRequests.filter(
    (pr) => pr.number !== pullRequestNumber
  );

  debug(
    `Checking for conflicts against ${otherPullRequests.length} other pull requests`
  );

  const conflictArray = [];

  for (const otherPullRequest of otherPullRequests) {
    const conflictData = await checkForConflicts(otherPullRequest);

    if (Object.keys(conflictData).length > 0) {
      conflictArray.push({
        author: otherPullRequest.author,
        conflictData,
        number: otherPullRequest.number,
        title: otherPullRequest.title,
        reviewers: otherPullRequest.reviewers,
      });
    } 
  }

  return conflictArray;
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
    const allPullRequests = []
    let page = 1;
    while (true) {
      const { data: pullRequests } = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: "open",
        per_page: 100,
        page: page,
      });

      if (pullRequests.length > 0) {
        allPullRequests.push(...pullRequests);
        page++;
      } else {
        break
      }
    }

    const openPullRequests = []

    for (const pr of allPullRequests) {
      if (pr.draft) {
        continue
      }

      openPullRequests.push({
        number: pr.number,
        author: pr.user.login,
        branch: pr.head.ref,
        title: pr.title,
        reviewers: await getAllReviewers(pr.number),
        isFork: pr.head.repo.fork,
        repo: pr.head.repo.full_name,
      })
    }

    return openPullRequests;
  } catch (error) {
    console.error(`Error fetching open pull requests: ${error.message}`);
    throw error;
  }
}


async function checkForConflicts(otherPullRequest) {
  const variables = new Variables();
  const pullRequestBranch = variables.get("pullRequestBranch");
  const pullRequestNumber = variables.get("pullRequestNumber");

  if (!pullRequestBranch || !otherPullRequest.branch) {
    throw new Error("Failed to fetch branch name for one or both PRs.");
  }

  const pullRequestFiles = await getChangedFiles(pullRequestNumber);

  const otherPullRequestFiles = await getChangedFiles(otherPullRequest.number);

  const overlappingFiles = pullRequestFiles.filter((file) =>
    otherPullRequestFiles.includes(file)
  );

  if (!overlappingFiles.length) {
    debug(`No overlapping files with #${otherPullRequest.branch}, will not attempt merge`)
    return [];
  }

  const conflictData = await attemptMerge(otherPullRequest);

  return conflictData;
}

async function getChangedFiles(anyPullRequestNumber) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const repo = variables.get("repo");

  const allFiles = []
  let page = 1;
  while (true) {
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: anyPullRequestNumber,
      per_page: 100,
      page: page,
    });

    if (files.length > 0) {
      allFiles.push(...files);
      page++;
    } else {
      break
    }
  }

  return allFiles.map((file) => file.filename).filter((file) => !ignoreFile(file));
}

async function attemptMerge(otherPullRequest) {
  const variables = new Variables();
  const mainBranch = variables.get("mainBranch");
  const pullRequestBranch = variables.get("pullRequestBranch");
  const quiet = variables.get("quiet");

  const conflictData = {};

  try {
    debug(
      `Attempting to merge #${otherPullRequest.branch} into #${pullRequestBranch}`
    );

    if (otherPullRequest.isFork) {
      // This is in another try catch because we may have already fetched this fork.
      try {
        execSync(
          `git remote add ${otherPullRequest.author} https://github.com/${otherPullRequest.repo}.git`
        );
      } catch(error) {
        console.log(error)
      }

      execSync(
        `git fetch ${otherPullRequest.author} ${otherPullRequest.branch}:refs/remotes/origin/tmp_${otherPullRequest.branch}`
      );
    } else {
      execSync(
        `git fetch origin ${otherPullRequest.branch}:refs/remotes/origin/tmp_${otherPullRequest.branch}`
      );
    }

    // Merge main into other pull request in memory.
    execSync(`git checkout refs/remotes/origin/tmp_${otherPullRequest.branch}`);
    execSync(`git merge ${mainBranch} --no-commit --no-ff`);
    execSync(`git reset --hard HEAD`);

    try {
      // Attempt to merge other pull request branch in memory without committing or fast-forwarding.
      execSync(
        `git merge refs/remotes/origin/tmp_${pullRequestBranch} --no-commit --no-ff`
      );

      debug(`${otherPullRequest.branch} merge successful. No conflicts found.`);
    } catch (mergeError) {
      const stdoutStr = mergeError.stdout.toString();
      if (stdoutStr.includes("Automatic merge failed")) {
        if (quiet) {
          return {
            0: "Extracting data is unnecessary if commenting is disabled.",
          };
        }

        const output = execSync(
          "git diff --name-only --diff-filter=U"
        ).toString();
        const conflictFileNames = output.split("\n").filter(Boolean);

        for (const filename of conflictFileNames) {
          debug(`Extracting conflicting line numbers for ${filename}`);
          conflictData[filename] = extractConflictingLineNumbers(
            otherPullRequest.branch,
            filename
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error during merge process: ${error.message}`);
  } finally {
    // Reset any changes.
    execSync(`git reset --hard HEAD`);
    // Cleanup by deleting temporary refs.
    execSync(
      `git update-ref -d refs/remotes/origin/tmp_${otherPullRequest.branch}`
    );
  }

  return conflictData;
}

function extractConflictingLineNumbers(otherPullRequestBranch, filePath) {
  const fileContentWithoutConflicts = execSync(
    `git show refs/remotes/origin/tmp_${otherPullRequestBranch}:${filePath}`
  ).toString();

  const linesFromNormalFile = fileContentWithoutConflicts.split("\n");

  const fileContentWithConflicts = readFileSync(filePath, "utf8");
  const linesFromConflictFile = fileContentWithConflicts.split("\n");

  const conflictLines = [];
  let oursBlock = [];
  let inOursBlock = false;

  for (const lineFromConflictFile of linesFromConflictFile) {
    if (lineFromConflictFile.startsWith("<<<<<<< HEAD")) {
      inOursBlock = true;
      oursBlock = [];
      continue;
    }

    if (lineFromConflictFile.startsWith("=======")) {
      inOursBlock = false;
      const startIndex = linesFromNormalFile.indexOf(oursBlock[0]);
      if (startIndex !== -1) {
        // Verify that the block matches.
        const doesMatch = oursBlock.every(
          (ourLine, index) =>
            ourLine === linesFromNormalFile[startIndex + index]
        );
        if (doesMatch) {
          for (let i = 0; i < oursBlock.length; i++) {
            conflictLines.push(startIndex + i + 1); // +1 for 1-indexed line numbers
          }
        }
      }
      continue;
    }

    if (lineFromConflictFile.startsWith(">>>>>>>")) {
      oursBlock = [];
      continue;
    }

    if (inOursBlock) {
      oursBlock.push(lineFromConflictFile);
    }
  }

  return conflictLines;
}

async function createConflictComment(conflictArray) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const pullRequestNumber = variables.get("pullRequestNumber");
  const repo = variables.get("repo");

  try {
    let totalFilesWithConflicts = 0;
    let conflictMessage = "";

    for (const data of conflictArray) {
      totalFilesWithConflicts += Object.keys(data.conflictData).length;
      conflictMessage += `<details>\n`;
      conflictMessage += `  <summary>${data.title} (#${data.number}) by @${data.author}</summary>\n`;

      for (const [fileName, lineNumbers] of Object.entries(data.conflictData)) {
        const allFiles = []
        let page = 1;
        while (true) {
          const { data: files } = await octokit.rest.pulls.listFiles({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: data.number,
            per_page: 100,
            page: page,
          });

          if (files.length > 0) {
            allFiles.push(...files);
            page++;
          } else {
            break
          }
        }

        const blobUrl = allFiles.find(
          (file) => file.filename === fileName
        ).blob_url;

        conflictMessage += `\u00A0\u00A0\u00A0 <a href="${blobUrl}">${fileName}</a> \u2015 ${formatLineNumbers(
          lineNumbers
        )}<br />`;
      }

      conflictMessage += `</details>\n\n`;
    }

    const prs = conflictArray.length === 1 ? "PR" : "PRs";
    const files = totalFilesWithConflicts === 1 ? "file" : "files";

    conflictMessage =
      `Conflicts detected in ${totalFilesWithConflicts} ${files} across ${conflictArray.length} ${prs}\n\n` +
      conflictMessage;

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
    const existing_reviewers = await getAllReviewers(pullRequestNumber)
    const reviewers = [
      ...new Set(
        conflictArray
          .map((conflict) => conflict.author)
          .filter((author) => author !== pullRequestAuthor && !existing_reviewers.has(author))
      ),
    ];

    if (reviewers.length > 0) {
      debug(`Requesting reviews from ${reviewers.join(", ")}`);

      await octokit.rest.pulls.requestReviewers({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullRequestNumber,
        reviewers: reviewers,
      });
    } else {
      debug(`No new reviews to request.`)
    }

    return reviewers.length
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

  let requestedReviews = 0;
  try {
    for (const conflict of conflictArray) {
      if (conflict.author !== pullRequestAuthor && !conflict.reviewers.has(pullRequestAuthor)) {
        debug(
          `Requesting review from ${pullRequestAuthor} in #${conflict.number}`
        );

        await octokit.rest.pulls.requestReviewers({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: conflict.number,
          reviewers: [pullRequestAuthor],
        });
        requestedReviews++;
      }
    }

    return requestedReviews;
  } catch (error) {
    console.error(
      `Error requesting reviews in conflicting PRs: ${error.message}`
    );
    throw error;
  }
}

// This function gets all reviewers on the conflicting pull requests.
// The reviewers include requested reviewers and those who have left a review.
async function getAllReviewers(pr_number) {
  const variables = new Variables();
  const octokit = variables.get("octokit");
  const repo = variables.get("repo");

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pr_number,
  });

  const { data: requested_reviewers } = await octokit.rest.pulls.listRequestedReviewers({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pr_number,
  });

  const viewed_reviewers = reviews.map((r) => r.user.login)
  const req_reviewers = requested_reviewers.users.map((r) => r.login)

  return new Set (viewed_reviewers.concat(req_reviewers))
}

function ignoreFile(filename) {
    for (const excluded of excludedFiles) {
      if (filename.includes(excluded)) {
        return true
      }
    }
    return false
}

main();
