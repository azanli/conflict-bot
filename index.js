const core = require("@actions/core");
const github = require("@actions/github");

async function run2() {
  try {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);

    const pullRequest = github.context.payload.pull_request;
    const repo = github.context.repo;

    const changedFilesData = await getChangedFilesData({
      octokit,
      repo,
      prNumber: pullRequest.number,
    });
    const openPullRequests = await getOpenPullRequests(octokit, repo);
    const otherOpenPullRequests = openPullRequests.filter(
      (pr) => pr.number !== pullRequest.number
    );

    let conflictArray = [];

    for (const openPullRequest of otherOpenPullRequests) {
      const openPRChangedFilesData = await getChangedFilesData({
        octokit,
        repo,
        prNumber: openPullRequest.number,
      });

      const conflictInfo = checkForConflicts(
        changedFilesData,
        openPRChangedFilesData
      );

      if (conflictInfo.hasConflict) {
        conflictArray.push({
          number: openPullRequest.number,
          user: openPullRequest.user.login,
          conflicts: conflictInfo.conflicts,
        });
      }
    }

    if (conflictArray.length > 0) {
      await createConflictComment({
        octokit,
        repo,
        prNumber: pullRequest.number,
        conflictArray,
      });
      await requestReviews({
        octokit,
        repo,
        prNumber: pullRequest.number,
        conflictArray,
        prAuthor: pullRequest.user.login,
      });
      await requestReviewsInConflictingPRs({
        octokit,
        repo,
        conflictArray,
        prAuthor: pullRequest.user.login,
      });
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getChangedFilesData({ octokit, repo, prNumber }) {
  try {
    // Fetch the list of files changed in the PR
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
    });

    // Initialize an object to store file paths and the lines changed
    let changedFilesData = {};

    for (const file of files) {
      // Get the patch text which contains info about the lines changed
      const patchText = file.patch;

      // Check if patch text is available (it might not be for binary files)
      if (patchText) {
        // Parse the patch text to get the changed lines
        const changedLines = parsePatchText(patchText);

        // Add the file path and changed lines to the data structure
        changedFilesData[file.filename] = changedLines;
      }
    }

    return changedFilesData;
  } catch (error) {
    console.error(`Error fetching changed files data: ${error.message}`);
    throw error;
  }
}

function parsePatchText(patchText) {
  let changedLines = [];
  const lines = patchText.split("\n");

  let currentOriginalLineNumber = 0;

  for (const line of lines) {
    // Capture the start line number of the new hunk
    const lineNumberMatch = line.match(/@@ -(\d+),\d+ \+\d+,\d+ @@/);
    if (lineNumberMatch) {
      currentOriginalLineNumber = parseInt(lineNumberMatch[1], 10) - 1;
      continue;
    }

    // If the line is a deletion or unchanged, increment the original line number
    if (
      line.startsWith("-") ||
      (!line.startsWith("-") && !line.startsWith("+"))
    ) {
      currentOriginalLineNumber++;
    }

    // If the line is an addition or a modification, add the current line number to the changed lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLines.push(currentOriginalLineNumber);
    }
  }

  return Array.from(new Set(changedLines));
}

async function getOpenPullRequests(octokit, repo) {
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
      user: pr.user,
    }));

    return openPullRequests;
  } catch (error) {
    console.error(`Error fetching open pull requests: ${error.message}`);
    throw error;
  }
}

function checkForConflicts(changedFilesData, openPRChangedFilesData) {
  let conflictInfo = {
    hasConflict: false,
    conflicts: [],
  };

  // Iterate through each file in changedFilesData
  for (const [filePath, changedLines] of Object.entries(changedFilesData)) {
    // Check if the file is also present in openPRChangedFilesData
    if (openPRChangedFilesData.hasOwnProperty(filePath)) {
      // Get the lines changed in the open PR for the same file
      const openPRChangedLines = openPRChangedFilesData[filePath];

      // Check for overlapping line changes
      const overlappingLines = changedLines.filter((line) =>
        openPRChangedLines.includes(line)
      );

      if (overlappingLines.length > 0) {
        // If there are any overlapping lines, add this to the conflict info
        conflictInfo.hasConflict = true;
        conflictInfo.conflicts.push({
          file: filePath,
          lines: overlappingLines,
        });
      }
    }
  }

  return conflictInfo;
}

async function createConflictComment({
  octokit,
  repo,
  prNumber,
  conflictArray,
}) {
  try {
    let conflictMessage = "### Conflicts Found\n\n";

    conflictArray.forEach((conflict) => {
      conflictMessage += `<details>\n`;
      conflictMessage += `  <summary><strong>Author:</strong> ${conflict.author} - <strong>PR:</strong> #${conflict.prNumber}</summary>\n`;
      conflictMessage += `  <p><strong>File:</strong> ${conflict.file}</p>\n`;
      conflictMessage += `  <p><strong>Lines:</strong> ${conflict.lines.join(
        ", "
      )}</p>\n`;
      conflictMessage += `</details>\n\n`;
    });

    await octokit.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      body: conflictMessage,
    });
  } catch (error) {
    console.error(`Error creating conflict comment: ${error.message}`);
    throw error;
  }
}

async function requestReviews({
  octokit,
  repo,
  prNumber,
  conflictArray,
  prAuthor,
}) {
  try {
    const reviewers = [
      ...new Set(
        conflictArray
          .map((conflict) => conflict.user)
          .filter((user) => user !== prAuthor)
      ),
    ];

    await octokit.rest.pulls.requestReviewers({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      reviewers: reviewers,
    });
  } catch (error) {
    console.error(`Error requesting reviews: ${error.message}`);
    throw error;
  }
}

async function requestReviewsInConflictingPRs({
  octokit,
  repo,
  conflictArray,
  prAuthor,
}) {
  try {
    for (const conflict of conflictArray) {
      if (conflict.user !== prAuthor) {
        // Request a review from the current PR author in each conflicting PR
        await octokit.rest.pulls.requestReviewers({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: conflict.number,
          reviewers: [prAuthor],
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

run2();
