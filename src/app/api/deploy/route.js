import { NextResponse } from "next/server";
import { execSync, spawn } from "child_process";
import fs, { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import net from "net";
import AdmZip from "adm-zip";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Global process tracking to allow persistence and cleanup
let globalSiteProcess = null;
let globalTunnelProcess = null;

function cleanupExistingProcesses() {
    if (globalSiteProcess) {
        console.log("[deploy] Killing existing site process...");
        try {
            // On Windows, taskkill is often more reliable for killing process trees
            if (process.platform === "win32") {
                execSync(`taskkill /pid ${globalSiteProcess.pid} /f /t`, { stdio: "ignore" });
            } else {
                process.kill(-globalSiteProcess.pid); // Kill process group
            }
        } catch (e) {
            globalSiteProcess.kill();
        }
        globalSiteProcess = null;
    }
    if (globalTunnelProcess) {
        console.log("[deploy] Killing existing tunnel process...");
        try {
            if (process.platform === "win32") {
                execSync(`taskkill /pid ${globalTunnelProcess.pid} /f /t`, { stdio: "ignore" });
            } else {
                process.kill(-globalTunnelProcess.pid);
            }
        } catch (e) {
            globalTunnelProcess.kill();
        }
        globalTunnelProcess = null;
    }
}

/* ───────────────────────────────────────────────────────────
   Utility: find a free TCP port
─────────────────────────────────────────────────────────── */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}


/* ───────────────────────────────────────────────────────────
   Utility: poll until a port is accepting TCP connections
─────────────────────────────────────────────────────────── */
function waitForPort(port, timeoutMs = 60_000, intervalMs = 300) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const sock = new net.Socket();
            sock.setTimeout(500);
            sock
                .once("connect", () => { sock.destroy(); resolve(); })
                .once("error", () => {
                    sock.destroy();
                    if (Date.now() - start >= timeoutMs) {
                        reject(new Error(`Port ${port} did not open within ${timeoutMs}ms`));
                    } else {
                        setTimeout(check, intervalMs);
                    }
                })
                .once("timeout", () => {
                    sock.destroy();
                    if (Date.now() - start >= timeoutMs) {
                        reject(new Error(`Port ${port} timed out`));
                    } else {
                        setTimeout(check, intervalMs);
                    }
                })
                .connect(port, "127.0.0.1");
        };
        check();
    });
}

/* ───────────────────────────────────────────────────────────
   Utility: detect project type & build commands
─────────────────────────────────────────────────────────── */
function detectProject(dir) {
    const pkg = existsSync(path.join(dir, "package.json"))
        ? JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
        : null;

    if (!pkg) {
        // Pure static site
        return { type: "static", startCmd: null, outDir: dir, name: path.basename(dir) };
    }

    const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
    };

    let projectInfo = {
        type: "npm",
        startCmd: pkg.scripts?.start ? "npm start" : (pkg.scripts?.dev ? "npm run dev" : null),
        name: pkg.name || path.basename(dir)
    };

    if (deps["next"]) {
        projectInfo = { ...projectInfo, type: "next", startCmd: "next start", buildCmd: "next build" };
    } else if (deps["vite"]) {
        projectInfo = { ...projectInfo, type: "vite", startCmd: "vite preview", buildCmd: "vite build" };
    } else if (deps["react-scripts"]) {
        projectInfo = { ...projectInfo, type: "cra", startCmd: "react-scripts start", buildCmd: "react-scripts build" };
    }

    if (!projectInfo.startCmd) {
        return { type: "static", startCmd: null, outDir: dir, name: projectInfo.name };
    }

    return projectInfo;
}

/* ───────────────────────────────────────────────────────────
   Utility: run a shell command synchronously
─────────────────────────────────────────────────────────── */
function run(cmd, cwd) {
    const tmpCache = path.join(os.tmpdir(), ".npm-cache");
    execSync(cmd, {
        cwd,
        stdio: "pipe",
        timeout: 300_000, // 5 min max
        env: { 
            ...process.env, 
            CI: "false",
            HOME: os.tmpdir(),
            npm_config_cache: tmpCache,
        },
    });
}

/* ───────────────────────────────────────────────────────────
   Utility: start a process and return the child
─────────────────────────────────────────────────────────── */
function spawnProcess(cmd, args, cwd, env = {}) {
    const tmpCache = path.join(os.tmpdir(), ".npm-cache");
    return spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { 
            ...process.env, 
            ...env,
            HOME: os.tmpdir(),
            npm_config_cache: tmpCache,
        },
        shell: true,
        detached: true, // Persist even if main process exits (on some OSes)
    });
}

/* ───────────────────────────────────────────────────────────
   Utility: wait for cloudflared to emit a trycloudflare URL
─────────────────────────────────────────────────────────── */
function waitForTunnelUrl(proc, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for tunnel URL after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        let outputBuffer = "";

        const parse = (chunk) => {
            const data = chunk.toString();
            outputBuffer += data;
            // cloudflared prints the URL on stderr
            const match = outputBuffer.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
            if (match) {
                console.log(`[cloudflared] Tunnel URL detected: ${match[1]}`);
                clearTimeout(timer);
                resolve(match[1]);
            }
        };

        if (proc.stdout) proc.stdout.on("data", parse);
        if (proc.stderr) proc.stderr.on("data", parse);

        proc.on("error", (err) => {
            clearTimeout(timer);
            console.error("[cloudflared error]", err);
            reject(err);
        });

        proc.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                clearTimeout(timer);
                console.error("[cloudflared exit]", code, outputBuffer);
                reject(new Error(`cloudflared exited with code ${code}. Output: ${outputBuffer.slice(-200)}`));
            }
        });
    });
}

/**
 * Download a GitHub repository as a ZIP file and extract it
 */
async function downloadGithubZip(repoUrl, targetDir) {
    console.log(`[deploy] Downloading ZIP from GitHub: ${repoUrl}`);
    
    // Convert github.com/user/repo to codeload.github.com/user/repo/zip/refs/heads/main
    // Handle both https://github.com/user/repo and repo.git 
    const cleanUrl = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const parts = cleanUrl.split("/");
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    
    // Try main then master
    const branches = ["main", "master"];
    let lastError;

    for (const branch of branches) {
        try {
            const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
            const response = await fetch(zipUrl);
            
            if (!response.ok) {
                throw new Error(`GitHub returned ${response.status} for branch ${branch}`);
            }

            const buffer = await response.arrayBuffer();
            const zip = new AdmZip(Buffer.from(buffer));
            
            // GitHub Zips have a root folder like "repo-main", we need to strip it
            const zipEntries = zip.getEntries();
            const rootFolder = zipEntries[0].entryName.split("/")[0];
            
            console.log(`[deploy] Extracting ZIP (root: ${rootFolder})...`);
            zip.extractAllTo(targetDir, true);
            
            // Move contents from rootFolder to targetDir
            const extractedPath = path.join(targetDir, rootFolder);
            const files = fs.readdirSync(extractedPath);
            
            for (const file of files) {
                const src = path.join(extractedPath, file);
                const dest = path.join(targetDir, file);
                if (fs.existsSync(dest)) {
                    if (fs.lstatSync(dest).isDirectory()) {
                        fs.rmSync(dest, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(dest);
                    }
                }
                fs.renameSync(src, dest);
            }
            
            // Cleanup empty root folder
            fs.rmSync(extractedPath, { recursive: true, force: true });
            
            return true;
        } catch (err) {
            console.warn(`[deploy] Failed to fetch branch ${branch}:`, err.message);
            lastError = err;
        }
    }
    
    throw new Error(`Could not download repository ZIP: ${lastError.message}`);
}

/* ───────────────────────────────────────────────────────────
   POST /api/deploy
─────────────────────────────────────────────────────────── */
export async function POST(request) {
    let repoUrl;

    // Clean up any old deployment before starting a new one
    cleanupExistingProcesses();

    let siteProcess = null;
    let tunnelProc = null;

    try {
        try {
            ({ repoUrl } = await request.json());
        } catch {
            return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!repoUrl || !repoUrl.startsWith("http")) {
            return NextResponse.json({ error: "Invalid GitHub URL" }, { status: 400 });
        }

        // ── 1. Check prerequisites ──────────────────────────────
        let hasGit = false;
        try { 
            execSync("git --version", { stdio: "pipe" }); 
            hasGit = true;
        } catch { 
            console.warn("[deploy] git is not installed. Will fallback to ZIP download.");
        }

        // ── 2. Clone/Fetch the repo ──────────────────────────────
        const tmpBase = path.join(os.tmpdir(), "livesite-deploys");
        // Aggressively clean up previous deployments to free up space
        if (existsSync(tmpBase)) {
            console.log("[deploy] Cleaning up old deployment folders to free up space...");
            try { 
                fs.rmSync(tmpBase, { recursive: true, force: true });
            } catch (e) {
                console.warn("[deploy] Cleanup failed:", e.message);
            }
        }
        mkdirSync(tmpBase, { recursive: true });

        const repoName = repoUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(-30);
        const cloneDir = path.join(tmpBase, `${repoName}_${Date.now()}`);
        if (!existsSync(cloneDir)) mkdirSync(cloneDir, { recursive: true });

        try {
            if (hasGit) {
                console.log("[deploy] Cloning via Git...");
                run(`git clone --depth=1 "${repoUrl}" "${cloneDir}"`, tmpBase);
            } else {
                await downloadGithubZip(repoUrl, cloneDir);
            }
        } catch (err) {
            console.error("[deploy] Clone/Download failed:", err);
            return NextResponse.json({
                error: "Failed to fetch repository code. Make sure the URL is a valid public GitHub repo.",
                details: err.message,
            }, { status: 500 });
        }

        // ── 3. Detect project type ───────────────────────────────
        const project = detectProject(cloneDir);

        // ── 4. Install dependencies ──────────────────────────────
        if (existsSync(path.join(cloneDir, "package.json"))) {
            console.log("[deploy] Installing dependencies (minimal space)...");
            try {
                // Use no-cache and no-package-lock to save space on Vercel's small disk
                run(`npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error --prefer-offline --no-cache --no-package-lock --omit=dev`, cloneDir);
            } catch (err) {
                return NextResponse.json({
                    error: "Dependency installation failed (possibly out of space).",
                    details: err.message,
                }, { status: 500 });
            }
        }

        // ── 5. Build the project ─────────────────────────────────
        let buildFailed = false;
        if (project.buildCmd) {
            console.log(`[deploy] Building project: ${project.buildCmd}`);
            try {
                run(`npx --prefer-offline ${project.buildCmd}`, cloneDir);
            } catch (err) {
                console.warn("Build step failed:", err.message);
                buildFailed = true;
            }
        }

        // ── 6. Start the site server ─────────────────────────────
        const port = await getFreePort();

        if (project.startCmd) {
            let startCmd = project.startCmd;
            // Fallback for Next.js: if build failed, try next dev
            if (project.type === "next" && buildFailed) {
                startCmd = "next dev";
                console.log("Falling back to 'next dev' due to build failure.");
            }

            const [cmd, ...args] = startCmd.split(" ");
            siteProcess = spawnProcess(cmd === "npm" ? "npm" : "npx", cmd === "npm" ? args : [cmd, ...args], cloneDir, {
                PORT: String(port),
                NEXT_PUBLIC_PORT: String(port),
            });

            await sleep(2000);
        } else {
            // Static site: serve with a tiny http-server
            siteProcess = spawnProcess("npx", ["--yes", "serve", "-p", String(port), cloneDir], tmpBase);
            await sleep(1000);
        }

        // ── 7. Start cloudflared tunnel ──────────────────────────
        // Wait for the server to be actually ready before starting the tunnel
        console.log(`[cloudflared] Waiting for port ${port} to be ready...`);
        try {
            await waitForPort(port, 30_000); // Wait up to 30 seconds
            console.log(`[cloudflared] Port ${port} is ready!`);
        } catch (portErr) {
            console.warn(`[cloudflared] Port ${port} didn't open in time, starting tunnel anyway...`);
        }

        console.log("[cloudflared] Starting tunnel...");
        tunnelProc = spawn(
            "npx",
            ["--yes", "--prefer-offline", "cloudflared", "tunnel", "--url", `http://localhost:${port}`],
            {
                cwd: os.tmpdir(),
                stdio: ["ignore", "pipe", "pipe"],
                shell: true,
            }
        );

        let tunnelUrl;
        try {
            tunnelUrl = await waitForTunnelUrl(tunnelProc, 60_000);
        } catch (err) {
            siteProcess?.kill();
            tunnelProc?.kill();
            return NextResponse.json({
                error: "Could not establish a public tunnel with Cloudflare.",
                details: err.message,
            }, { status: 500 });
        }

        // ── 8. Return the live URL ───────────────────────────────
        // Store references globally so they don't get garbage collected or lost
        globalSiteProcess = siteProcess;
        globalTunnelProcess = tunnelProc;

        return NextResponse.json({ url: tunnelUrl, repoUrl, port, status: "live" });

    } catch (globalError) {
        console.error("[POST /api/deploy GLOBAL ERROR]", globalError);
        siteProcess?.kill();
        tunnelProc?.kill();
        return NextResponse.json({
            error: "An unexpected internal error occurred.",
            details: globalError.message,
        }, { status: 500 });
    }
}
