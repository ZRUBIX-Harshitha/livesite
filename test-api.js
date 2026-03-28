fetch("http://localhost:3000/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/octocat/Spoon-Knife" })
})
    .then(r => r.json())
    .then(d => console.log("Result:", d))
    .catch(e => console.error("Error:", e));
