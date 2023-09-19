## Conflict-Bot: Your PR Conflict Detector

Conflict-Bot is a GitHub Action designed to help maintain a smooth and efficient code integration process within your repository. Whenever a new pull request is opened, Conflict-Bot jumps into action to check if the lines of files changed in the new pull request correspond with lines changed in other open pull requests. If a conflict is detected, the bot helps foster collaboration by creating a comment on the conflicting pull requests, referencing the conflicting lines and PR numbers, and suggesting the authors to review each other's changes.

### Getting Started

#### Pre-requisites

A GitHub repository where you intend to use Conflict-Bot.
Necessary permissions to add a GitHub Action to the repository.
Node.js (version 14 or higher is recommended).

#### Setting Up

Create a Personal Access Token: Generate a personal access token with the necessary permissions (Actions (read-only), Commit statuses (read-only), Contents (read-only), Metadata (read-only), Pull Requests (read and write)) to enable Conflict-Bot to interact with your repository.

Add the Action to Your Repository: Create a new workflow file (.yml) in the .github/workflows directory of your repository and add the configuration for Conflict-Bot.

##### Here is a basic setup for your GitHub Action workflow:

```yaml
name: PR Conflict Checker

on:
pull_request:
types: [opened, synchronize]

jobs:
check_pr_conflicts:
runs-on: ubuntu-latest
steps: - name: Check out code
uses: actions/checkout@v2

      - name: Set up Node.js
        uses: actions/setup-node@v2
        with:
          node-version: "14"

      - name: Install dependencies
        run: npm install

      - name: Run PR Conflict Checker
        uses: friendly-robot/conflict-bot
        with:
          github-token: ${{ secrets.CONFLICT_BOT_ACCESS_TOKEN }}
```

Initialize and Set Up Conflict-Bot: Clone the Conflict-Bot repository and navigate to the root directory. Run npm install to install the necessary dependencies.

### How Conflict-Bot Works

Conflict-Bot monitors your repository for newly opened or updated pull requests.
When triggered, it fetches the list of files and lines changed in the new pull request.
It then compares these changes with changes in other open pull requests to detect any conflicts.
If conflicts are detected, it comments on the conflicting pull requests, referencing the conflicting lines and PR numbers, and suggesting the authors review each other's changes.
It facilitates collaboration by assigning the authors of the conflicting PRs to review each other's changes.

### Contributing

Conflict-Bot is open-source and we welcome contributions. If you'd like to contribute, please fork the repository and make your changes, then open a pull request against the main branch.

We hope Conflict-Bot helps maintain a smooth and efficient code integration process in your repository. If you have any questions or need further assistance, feel free to open an issue in the repository.

Happy Coding!

<sub>This project is licensed under the MIT License.</sub>
