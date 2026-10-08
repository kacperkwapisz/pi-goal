/**
 * The goal loop inside a real Pi agent session (Pi's SDK), with a scripted model.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	initTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import goal from "../src/index.ts";

initTheme("dark"); // Pi does this at startup; the goal widget and status use the theme

type Script = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

async function startSession(script: Script, extra?: ExtensionFactory) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "x" } }));
	const model = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	model.setResponses(script);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		extensionFactories: [(pi) => pi.registerProvider(model.provider), goal, ...(extra ? [extra] : [])],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } }),
		model: model.getModel(),
	});
	await session.bindExtensions({});
	return { session, model, close: () => session.dispose() };
}

const until = async (check: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything the model was sent, as plain text. */
const seen = (context: Context) =>
	context.messages
		.map((m) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((c) => c.text ?? "").join("")))
		.join("\n");

test("the loop keeps working until the model calls goal_complete, then stops", { timeout: 30_000 }, async () => {
	const { session, model, close } = await startSession([
		fauxAssistantMessage("Did the first part."),
		fauxAssistantMessage("Did the second part."),
		fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "All parts done and checked." })),
		fauxAssistantMessage("this must not be needed"),
	]);
	try {
		await session.prompt("/goal Write the three parts");
		await until(() => model.state.callCount === 3 && session.isIdle);
		await pause(300);
		assert.equal(model.state.callCount, 3, "no turn after the goal is complete");
	} finally {
		close();
	}
});

test("goal_ask holds the loop; the user's reply is tagged as the answer", { timeout: 30_000 }, async () => {
	let context = "";
	const { session, model, close } = await startSession([
		fauxAssistantMessage(fauxToolCall("goal_ask", { question: "Which colour? 1. blue 2. red" })),
		(ctx) => {
			context = seen(ctx);
			return fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "Painted it blue." }));
		},
	]);
	try {
		await session.prompt("/goal Paint the fence");
		await until(() => model.state.callCount === 1 && session.isIdle);
		await pause(300);
		assert.equal(model.state.callCount, 1, "waits for the user");
		await session.prompt("blue");
		await until(() => model.state.callCount === 2);
		assert.match(context, /answers your goal_ask question:\nWhich colour\? 1\. blue 2\. red/);
	} finally {
		close();
	}
});

test("goal_wait holds the loop until a background agent or job finishes", { timeout: 30_000 }, async () => {
	let events: ExtensionAPI["events"] | undefined;
	let result = "";
	// Stands in for pi-subagents: one agent is working.
	const fakeAgents: ExtensionFactory = (pi) => {
		events = pi.events;
		pi.events.on("pi-subagents:query", (data) => (data as { reply: (names: string[]) => void }).reply(["helper"]));
	};
	const { session, model, close } = await startSession(
		[
			fauxAssistantMessage(fauxToolCall("goal_wait", { reason: "Need the helper's review" })),
			(ctx) => {
				const results = ctx.messages.filter((m) => m.role === "toolResult");
				result = seen({ ...ctx, messages: results });
				return fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "Used the review." }));
			},
		],
		fakeAgents,
	);
	try {
		await session.prompt("/goal Ship it after review");
		await until(() => model.state.callCount === 1 && session.isIdle);
		await pause(300);
		assert.equal(model.state.callCount, 1, "holds while the agent works");
		// Stopped by the user: nothing starts a turn for it, so the goal loop does.
		events!.emit("pi-subagents:finished", { name: "helper", status: "stopped", triggersTurn: false });
		await until(() => model.state.callCount === 2);
		assert.match(result, /Waiting on helper \(timeout 30 min\)/);
	} finally {
		close();
	}
});

test("goal_wait refuses when nothing it could wait for is loaded", { timeout: 30_000 }, async () => {
	let result = "";
	const { session, model, close } = await startSession([
		fauxAssistantMessage(fauxToolCall("goal_wait", { reason: "x" })),
		(ctx) => {
			result = seen({ ...ctx, messages: ctx.messages.filter((m) => m.role === "toolResult") });
			return fauxAssistantMessage(fauxToolCall("goal_complete", { summary: "done" }));
		},
	]);
	try {
		await session.prompt("/goal Do it");
		await until(() => model.state.callCount === 2);
		assert.match(result, /Neither bg-jobs nor pi-subagents is loaded/);
	} finally {
		close();
	}
});
