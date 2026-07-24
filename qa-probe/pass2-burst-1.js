// DeepSource Pass-2 QA probe -- burst arm, PR 1 of 2 (created back-to-back)

function renderUserBio(bio) {
    document.getElementById("bio").innerHTML = bio; // reflected XSS via innerHTML
}

function runShellCommand(userInput) {
    const { exec } = require("child_process");
    exec("echo " + userInput); // command injection via string concat
}

module.exports = { renderUserBio, runShellCommand };
