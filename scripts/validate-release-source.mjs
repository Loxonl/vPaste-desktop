const { GITHUB_REF, GITHUB_SHA, SOURCE_SHA } = process.env;

if (GITHUB_REF !== "refs/heads/main") {
  console.error("Release builds must be dispatched from main.");
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/i.test(SOURCE_SHA ?? "") || !/^[0-9a-f]{40}$/i.test(GITHUB_SHA ?? "")) {
  console.error("Release source and selected commit must be full commit SHAs.");
  process.exit(1);
}

if (SOURCE_SHA.toLowerCase() !== GITHUB_SHA.toLowerCase()) {
  console.error("Release source must match the selected main commit.");
  process.exit(1);
}
