/**
 * pi-fusion — lead/sidekick multi-model harness.
 *
 * The lead (this pi session, frontier model) gets two tools:
 *   - delegate(brief): spawn a fresh sidekick agent (cheap model) that runs the
 *     full task loop in its own persistent, cached context and reports back.
 *   - follow_up(task_id, message): continue an existing sidekick's context.
 *
 * Sidekick sessions run in-process via the pi SDK, persist to normal session
 * files (inspect with `pi --resume`), and inherit project AGENTS.md context.
 * See skills/fusion/SKILL.md for the delegation playbook.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentSession,
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULTS = {
	sidekickModel: "anthropic/claude-sonnet-4-6:high",
	timeoutMinutes: 10,
};

const MAX_LOG_LINES = 30;
const SHORT_REPORT_CHARS = 200;

const PREAMBLE = `You are a sidekick agent executing a task brief from a lead engineer.

Rules:
- Carry out the complete task yourself: implement, verify (run tests/linters where applicable), and iterate until it works.
- Work autonomously. Make reasonable decisions when details are ambiguous.
- Do not commit unless the brief explicitly asks you to; the lead owns commits.
- Your FINAL message must be a complete report: what you did and why, files changed, commands run with their results, and any decisions made or open questions. Never end with a bare "Done."

TASK BRIEF
----------
`;

interface FusionConfig {
	sidekickModel: string;
	timeoutMinutes: number;
}

interface Task {
	id: string;
	session: AgentSession;
	log: string[];
}

function readConfig(cwd: string, modelOverride?: string): FusionConfig {
	const cfg = { ...DEFAULTS };
	if (process.env.PI_FUSION_MODEL)
		cfg.sidekickModel = process.env.PI_FUSION_MODEL;
	for (const file of [
		path.join(getAgentDir(), "settings.json"),
		path.join(cwd, CONFIG_DIR_NAME, "settings.json"),
	]) {
		try {
			const json = JSON.parse(fs.readFileSync(file, "utf8"));
			if (json.fusion && typeof json.fusion === "object")
				Object.assign(cfg, json.fusion);
		} catch {
			// missing or invalid file: use defaults
		}
	}
	if (modelOverride) cfg.sidekickModel = modelOverride;
	return cfg;
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block: any) =>
					block?.type === "text" && typeof block.text === "string",
			)
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}

/** Final report = last assistant text; if trivially short, include the last few. */
function extractReport(session: AgentSession, sinceIndex: number): string {
	const texts = session.messages
		.slice(sinceIndex)
		.filter((m: any) => m.role === "assistant")
		.map(messageText)
		.map((t) => t.trim())
		.filter(Boolean);
	if (texts.length === 0) return "(sidekick produced no report)";
	const last = texts[texts.length - 1];
	if (last.length >= SHORT_REPORT_CHARS) return last;
	return texts.slice(-3).join("\n\n");
}

function summarizeArgs(toolName: string, args: any): string {
	let detail = "";
	if (args && typeof args === "object") {
		detail =
			args.command ??
			args.path ??
			args.pattern ??
			args.query ??
			Object.values(args).find((v) => typeof v === "string") ??
			"";
	}
	detail = String(detail).replace(/\s+/g, " ").trim();
	if (detail.length > 80) detail = `${detail.slice(0, 77)}...`;
	return detail ? `${toolName}: ${detail}` : toolName;
}

async function spawnSidekick(
	ctx: ExtensionContext,
	cfg: FusionConfig,
): Promise<AgentSession> {
	const resolved = resolveCliModel({
		cliModel: cfg.sidekickModel,
		modelRegistry: ctx.modelRegistry,
	});
	if (resolved.error || !resolved.model) {
		throw new Error(
			`pi-fusion: cannot resolve sidekick model "${cfg.sidekickModel}"${resolved.error ? `: ${resolved.error}` : ""}. Set "fusion": { "sidekickModel": "provider/model[:thinking]" } in settings.json.`,
		);
	}

	// Context files (AGENTS.md) yes; extensions/skills/prompts no — the sidekick
	// is a plain agent with the built-in toolset and no delegation of its own.
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel ?? "off",
		modelRegistry: ctx.modelRegistry,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		resourceLoader: loader,
		sessionManager: SessionManager.create(ctx.cwd),
	});
	return session;
}

/** Run one prompt against a sidekick with live log streaming, timeout, and lead-abort wiring. */
async function runSidekick(options: {
	task: Task;
	message: string;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	onUpdate:
		| ((partial: {
				content: [{ type: "text"; text: string }];
				details: any;
		  }) => void)
		| undefined;
}): Promise<{ report: string; status: string }> {
	const { task, message, timeoutMs, signal, onUpdate } = options;
	const sinceIndex = task.session.messages.length;
	let status = "ok";

	const pushLog = (line: string) => {
		task.log.push(line);
		onUpdate?.({
			content: [
				{ type: "text", text: task.log.slice(-MAX_LOG_LINES).join("\n") },
			],
			details: {},
		});
	};

	const unsubscribe = task.session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			pushLog(`→ ${summarizeArgs(event.toolName, (event as any).args)}`);
		}
	});

	const timer = setTimeout(() => {
		status = "timeout";
		void task.session.abort();
	}, timeoutMs);
	const onAbort = () => {
		status = "aborted";
		void task.session.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await task.session.prompt(message);
	} catch (error) {
		if (status === "ok") status = "error";
		pushLog(
			`sidekick error: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	const errorMessage = task.session.agent.state.errorMessage;
	if (status === "ok" && errorMessage) status = `error: ${errorMessage}`;

	return { report: extractReport(task.session, sinceIndex), status };
}

function formatResult(
	task: Task,
	status: string,
	report: string,
): { content: [{ type: "text"; text: string }]; details: any } {
	const header = [
		`task_id: ${task.id}`,
		`status: ${status}`,
		task.session.sessionFile
			? `sidekick session: ${task.session.sessionFile}`
			: undefined,
		status !== "ok"
			? "The sidekick was interrupted; the report below may be partial. Judge whether to follow_up, re-delegate, or handle it yourself."
			: undefined,
	]
		.filter(Boolean)
		.join("\n");
	return {
		content: [{ type: "text", text: `${header}\n\n${report}` }],
		details: { taskId: task.id, status, sessionFile: task.session.sessionFile },
	};
}

export default function (pi: ExtensionAPI) {
	const tasks = new Map<string, Task>();
	let nextId = 1;
	let modelOverride: string | undefined;

	pi.registerCommand("fusion-model", {
		description:
			"Show or set the sidekick model for this session (provider/model[:thinking])",
		handler: async (args, ctx) => {
			const arg = args?.trim();
			if (!arg) {
				ctx.ui.notify(
					`sidekick model: ${readConfig(ctx.cwd, modelOverride).sidekickModel}`,
					"info",
				);
				return;
			}
			const resolved = resolveCliModel({
				cliModel: arg,
				modelRegistry: ctx.modelRegistry,
			});
			if (resolved.error || !resolved.model) {
				ctx.ui.notify(
					`Cannot resolve "${arg}"${resolved.error ? `: ${resolved.error}` : ""}`,
					"error",
				);
				return;
			}
			modelOverride = arg;
			ctx.ui.notify(`Sidekick model set to ${arg} for this session`, "info");
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate to sidekick",
		description:
			"Delegate a task to a fresh sidekick agent (cheaper model, full toolset, own context). Returns its report plus a task_id for follow_up. Load the 'fusion' skill before first use for the delegation playbook.",
		parameters: Type.Object({
			brief: Type.String({
				description:
					"Task brief written like a spec, not step-by-step instructions: goal, explicit constraints and edge cases, definition of done (e.g. tests/lint that must pass). An unstated constraint is a lost constraint.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cfg = readConfig(ctx.cwd, modelOverride);
			const session = await spawnSidekick(ctx, cfg);
			const task: Task = { id: `t${nextId++}`, session, log: [] };
			tasks.set(task.id, task);
			const { report, status } = await runSidekick({
				task,
				message: PREAMBLE + params.brief,
				timeoutMs: cfg.timeoutMinutes * 60_000,
				signal,
				onUpdate,
			});
			return formatResult(task, status, report);
		},
	});

	pi.registerTool({
		name: "follow_up",
		label: "Follow up with sidekick",
		description:
			"Continue an existing sidekick task in its same context — it already knows the brief and everything it did so far. Use for review feedback or scope additions instead of redoing the work yourself.",
		parameters: Type.Object({
			task_id: Type.String({ description: "task_id returned by delegate" }),
			message: Type.String({
				description: "Feedback or additional instructions for the sidekick",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = tasks.get(params.task_id);
			if (!task) {
				const known = [...tasks.keys()].join(", ") || "none";
				throw new Error(
					`Unknown task_id "${params.task_id}". Live tasks: ${known}. Use delegate to start a new task.`,
				);
			}
			const cfg = readConfig(ctx.cwd, modelOverride);
			const { report, status } = await runSidekick({
				task,
				message: params.message,
				timeoutMs: cfg.timeoutMinutes * 60_000,
				signal,
				onUpdate,
			});
			return formatResult(task, status, report);
		},
	});

	pi.on("session_shutdown", async () => {
		for (const task of tasks.values()) {
			try {
				task.session.dispose();
			} catch {
				// best effort
			}
		}
		tasks.clear();
	});
}
