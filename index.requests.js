const core = require("@actions/core");
const github = require("@actions/github");

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

function ignoreFile(filename) {
    for (const excluded of excludedFiles) {
      if (filename.includes(excluded)) {
        return true
      }
    }
    return false
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

module.exports = {
  Variables,
  getOpenPullRequests,
  getChangedFiles,
  requestReviews,
  requestReviewsInConflictingPRs,
  createConflictComment
};