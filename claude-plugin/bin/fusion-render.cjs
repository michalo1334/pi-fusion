#!/usr/bin/env node
// Renders claude stream-json: one progress line per sidekick tool call (stderr),
// then the final report (stdout).
const rl = require("node:readline").createInterface({ input: process.stdin });

function summarize(name, input) {
	let d =
		(input &&
			(input.command ??
				input.file_path ??
				input.path ??
				input.pattern ??
				input.query ??
				Object.values(input).find((v) => typeof v === "string"))) ??
		"";
	d = String(d).replace(/\s+/g, " ").trim();
	if (d.length > 80) d = `${d.slice(0, 77)}...`;
	return d ? `${name}: ${d}` : name;
}

rl.on("line", (line) => {
	let j;
	try {
		j = JSON.parse(line);
	} catch {
		return;
	}
	if (j.type === "assistant") {
		for (const b of j.message?.content ?? []) {
			if (b.type === "tool_use")
				process.stderr.write(`→ ${summarize(b.name, b.input)}\n`);
		}
	} else if (j.type === "result") {
		const cost =
			j.total_cost_usd != null
				? `\ncost_usd: ${j.total_cost_usd.toFixed(4)}`
				: "";
		console.log(
			`session_id: ${j.session_id}\nstatus: ${j.subtype || "ok"}${cost}\n\n${j.result || "(sidekick produced no report)"}`,
		);
	}
});
