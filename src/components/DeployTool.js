"use client";

import { useState } from "react";
import styles from "./DeployTool.module.css";

const STEPS = ["Cloning", "Installing", "Building", "Tunneling", "Live!"];
const STEP_ICONS = ["📦", "⚙️", "🏗️", "🌐", "✅"];

export default function DeployTool() {
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [currentStep, setCurrentStep] = useState(-1);
    const [liveUrl, setLiveUrl] = useState("");
    const [deployedRepoUrl, setDeployedRepoUrl] = useState("");
    const [error, setError] = useState("");
    const [logs, setLogs] = useState([]);

    const addLog = (msg) => setLogs((prev) => [...prev, msg]);

    const deploy = async () => {
        if (!url.trim()) {
            setError("Please enter a GitHub repository URL.");
            return;
        }
        setError("");
        setLiveUrl("");
        setDeployedRepoUrl("");
        setLogs([]);
        setLoading(true);
        setCurrentStep(0);
        addLog(`🚀 Starting deployment for: ${url}`);

        try {
            const res = await fetch("/api/deploy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repoUrl: url }),
            });

            const data = await res.json();

            if (!res.ok || data.error) {
                setError(data.error || "Deployment failed.");
                setLoading(false);
                setCurrentStep(-1);
                addLog(`❌ Error: ${data.error}`);
                if (data.details) addLog(`Details: ${data.details}`);
                return;
            }

            // Animate through steps quickly
            for (let i = 0; i < STEPS.length; i++) {
                setCurrentStep(i);
                await new Promise((r) => setTimeout(r, 50));
            }

            addLog(`✅ Tunnel active: ${data.url}`);
            setLiveUrl(data.url);
            setDeployedRepoUrl(data.repoUrl);
            setLoading(false);
        } catch (err) {
            setError("Network error: " + err.message);
            setLoading(false);
            setCurrentStep(-1);
        }
    };

    const reset = () => {
        setUrl("");
        setLoading(false);
        setCurrentStep(-1);
        setLiveUrl("");
        setDeployedRepoUrl("");
        setError("");
        setLogs([]);
    };

    return (
        <div className={styles.page}>
            {/* Header */}
            <div className={styles.header}>
                <div className={styles.logo}>
                    <span className={styles.logoIcon}>🚀</span>
                    <span className={styles.logoText}>LiveDeploy</span>
                </div>
                <p className={styles.tagline}>
                    Paste any GitHub URL → Get a live public website instantly
                </p>
            </div>

            {/* Main Card */}
            <div className={styles.card}>
                {/* Input Row */}
                <div className={styles.inputRow}>
                    <div className={styles.inputWrapper}>
                        <span className={styles.inputIcon}>🔗</span>
                        <input
                            className={styles.input}
                            type="text"
                            placeholder="https://github.com/username/repo"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && !loading && deploy()}
                            disabled={loading}
                        />
                    </div>
                    <button
                        className={`${styles.btn} ${loading ? styles.btnLoading : ""}`}
                        onClick={deploy}
                        disabled={loading}
                    >
                        {loading ? (
                            <>
                                <span className={styles.spinner} />
                                Deploying…
                            </>
                        ) : (
                            "Deploy Live"
                        )}
                    </button>
                </div>

                {/* Error */}
                {error && (
                    <div className={styles.errorBox}>
                        <span>⚠️</span> {error}
                    </div>
                )}

                {/* Steps Progress */}
                {(loading || liveUrl) && (
                    <div className={styles.steps}>
                        {STEPS.map((step, i) => {
                            const done = currentStep > i || (currentStep === 4 && i === 4);
                            const active = currentStep === i && !liveUrl;
                            return (
                                <div
                                    key={step}
                                    className={`${styles.step} ${done || (i <= currentStep && liveUrl) ? styles.stepDone : ""} ${active ? styles.stepActive : ""}`}
                                >
                                    <div className={styles.stepCircle}>
                                        {done || (i <= currentStep && liveUrl) ? "✓" : STEP_ICONS[i]}
                                    </div>
                                    <span className={styles.stepLabel}>{step}</span>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Live URL Result */}
                {liveUrl && (
                    <div className={styles.resultBox}>
                        <div className={styles.resultHeader}>
                            <span className={styles.pulse} />
                            <span className={styles.liveTag}>LIVE</span>
                            <span className={styles.resultTitle}>Your site is live!</span>
                        </div>
                        <div className={styles.urlRow}>
                            <a
                                href={liveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.liveLink}
                            >
                                {liveUrl}
                            </a>
                            <button
                                className={styles.copyBtn}
                                onClick={() => navigator.clipboard.writeText(liveUrl)}
                            >
                                Copy
                            </button>
                        </div>
                        <div className={styles.iframeWrapper}>
                            <iframe
                                src={liveUrl}
                                className={styles.iframe}
                                title="Live Preview"
                                sandbox="allow-scripts allow-same-origin allow-forms"
                            />
                        </div>
                        <div className={styles.persistenceNote}>
                            <span>💡</span> Local site remains live as long as this computer is <strong>ON</strong>.
                        </div>
                        <div className={styles.actionRow}>
                            <a
                                href={`https://vercel.com/new/clone?repository-url=${encodeURIComponent(deployedRepoUrl)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.permanentBtn}
                            >
                                ☁️ Make it Permanent (Cloud Hosting)
                            </a>
                            <button className={styles.resetBtn} onClick={reset}>
                                Deploy Another Site
                            </button>
                        </div>
                    </div>
                )}

                {/* Logs */}
                {logs.length > 0 && (
                    <div className={styles.logBox}>
                        {logs.map((l, i) => (
                            <div key={i} className={styles.logLine}>
                                {l}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className={styles.footer}>
                Powered by <strong>cloudflared</strong> · No account required
            </div>
        </div>
    );
}
