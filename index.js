const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const readFileSync = require("fs").readFileSync;

const { debug } = require("./index.utils");
const {
  Variables,
  getOpenPullRequests,
  getChangedFiles,
  requestReviews,
  requestReviewsInConflictingPRs,
  createConflictComment,
} = require("./index.requests");

async function main() {
  if (github.context.payload.pull_request.draft) {
    debug(`Not running any checks because this pull request is a draft`)
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

function cleanup() {
  try {
    const pullRequest = github.context.payload.pull_request;

    execSync(`git update-ref -d refs/remotes/origin/tmp_${pullRequest.number}`);
  } catch (e) {
    console.error(`Error during cleanup: ${error.message}`);
    throw error;
  }
}

main();
