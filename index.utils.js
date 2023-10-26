const core = require("@actions/core");

function formatLineNumbers(numbers) {
  if (!numbers || numbers.length === 0) return "";

  let formatted = [];
  let start = numbers[0];
  let end = start;

  for (let i = 1; i < numbers.length; i++) {
    // Check if the current number is consecutive to the previous
    if (numbers[i] === end + 1) {
      end = numbers[i];
    } else {
      if (end - start >= 2) {
        // Check if there's more than one number in between
        formatted.push(`${start}...${end}`);
      } else {
        formatted.push(start.toString());
        if (end !== start) {
          formatted.push(end.toString());
        }
      }
      start = end = numbers[i];
    }
  }

  // Add the last number or range to the formatted array
  if (end - start >= 2) {
    formatted.push(`${start}...${end}`);
  } else {
    formatted.push(start.toString());
    if (end !== start) {
      formatted.push(end.toString());
    }
  }

  return formatted.join(", ");
}

function debug(...args) {
  const debug = core.getInput("debug", { required: false });
  const enableLogging = ["true", "yes", "on"].includes(debug.toLowerCase());
  if (enableLogging) {
    core.info(...args);
  }
}

module.exports = {
  debug,
  formatLineNumbers,
};
