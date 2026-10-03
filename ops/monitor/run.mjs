import nodemailer from "nodemailer";
import { MonitorError, readConfig, createIssueStore, checkReady, runMonitor } from "./monitor.mjs";

try {
  const config = readConfig(process.env);
  const transport = nodemailer.createTransport(config.smtp);
  try {
    const result = await runMonitor({
      store: createIssueStore(config),
      check: () => checkReady(config.url),
      send: async event => {
        const recovery = event.kind === "recovery";
        const result = await transport.sendMail({
          from: config.from,
          to: config.to,
          subject: recovery ? "[Lek Mint] Readiness recovered" : "[Lek Mint] Outage detected",
          text: [
            recovery ? "The configured readiness endpoint is ready and active again."
              : "The configured readiness endpoint failed two consecutive scheduled checks.",
            `Observed at: ${event.at}`,
            `Incident detected at: ${event.incident}`,
            "Checks run outside Start9 via GitHub Actions; scheduling is best-effort.",
            "This tests application readiness, not successful end-to-end mint transactions.",
          ].join("\n"),
        });
        if (!result.accepted?.length || result.rejected?.length) throw new Error("Not accepted");
      },
    });
    console.log(`Readiness: ${result.ready ? "ready" : "not ready"}; consecutive failures: ${result.failures}; outage: ${result.outage}`);
  } finally {
    transport.close();
  }
} catch (error) {
  console.error(error instanceof MonitorError ? error.message : "Monitor failed unexpectedly; details suppressed to protect credentials");
  process.exitCode = 1;
}