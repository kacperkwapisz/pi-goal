/**
 * Persistent Goal Extension
 *
 * /goal <goal> sets an autonomous goal. Pi keeps taking turns until the
 * agent calls goal_complete after it has verified the goal is achieved. When
 * the agent needs a decision or information from the user, it calls goal_ask:
 * the turn ends, automatic continuation holds, and the user's next message is
 * the answer, after which the goal loop resumes. If a genuine external blocker
 * is reached (something the user must do outside pi), the agent can call
 * goal_pause instead.
 *
 * Interrupts and compaction:
 *   - Esc (an aborted run) holds the loop until you send a message or run
 *     /goal resume, instead of immediately re-prompting.
 *   - /compact aborts the running turn; the loop resumes once compaction ends.
 *   - If auto-compaction fails or is cancelled, the goal pauses so a context
 *     overflow cannot turn into a retry loop.
 *   - The answer to a goal_ask question is tagged with the question, so the
 *     pairing survives the question being summarized away.
 *
 * Background jobs and agents (bg-jobs and pi-subagents extensions, both optional):
 *   - goal_wait holds the loop while bg_run jobs or background agents the agent
 *     depends on are running, instead of re-prompting it into idle turns or
 *     sleep loops.
 *   - The wait ends when a waited job or agent finishes (its completion message
 *     starts the next turn), when a user message arrives and settles, or on
 *     timeout.
 *   - Talks to them over pi.events: "<name>:query" and "<name>:finished", where
 *     <name> is bg-jobs or pi-subagents.
 *
 * Commands:
 *   /goal <goal>  Set or replace the goal
 *   /goal          Show the current goal
 *   /goal pause    Pause automatic continuation
 *   /goal resume   Resume automatic continuation
 *   /goal clear    Remove the goal
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface GoalState {
	goal?: string;
	paused: boolean;
	/** Question from goal_ask awaiting the user's reply. */
	question?: string;
}

const STATE_ENTRY_TYPE = "persistent-goal-state";
const WIDGET_ID = "persistent-goal";
const STATUS_ID = "persistent-goal";
const GOAL_TOOL_NAMES = ["goal_complete", "goal_pause", "goal_ask", "goal_wait"];
const DEFAULT_WAIT_MINUTES = 30;
const BLOCKING_PROVIDER_STATUS_CODES = new Set([401, 402, 403, 407]);

export default function persistentGoalExtension(pi: ExtensionAPI): void {
	let state: GoalState = { paused: false };
	/** Last run was aborted (Esc or /compact); hold the loop until the user acts. Not persisted. */
	let interrupted = false;
	/** goal_ask question the user just answered; tagged onto the next run. */
	let answeredQuestion: string | undefined;
	/** Jobs or agents the agent is waiting on via goal_wait. Not persisted: they end with the session. */
	let waitingOn: Set<string> | undefined;
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let latestCtx: ExtensionContext | undefined;

	/**
	 * Names of running bg-jobs and pi-subagents agents, or undefined when neither extension is
	 * loaded. Both answer the same kind of query over pi.events.
	 */
	function runningJobs(): string[] | undefined {
		let names: string[] | undefined;
		for (const event of ["bg-jobs:query", "pi-subagents:query"]) {
			pi.events.emit(event, {
				reply(running: string[]) {
					names = [...(names ?? []), ...running];
				},
			});
		}
		return names;
	}

	function clearWait(): void {
		waitingOn = undefined;
		if (waitTimer) {
			clearTimeout(waitTimer);
			waitTimer = undefined;
		}
	}

	function hasGoal(): boolean {
		return typeof state.goal === "string" && state.goal.length > 0;
	}

	function saveState(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
	}

	function setGoalToolsEnabled(enabled: boolean): void {
		const activeTools = pi.getActiveTools();
		const missingGoalTools = GOAL_TOOL_NAMES.filter((name) => !activeTools.includes(name));
		const hasGoalTool = missingGoalTools.length !== GOAL_TOOL_NAMES.length;

		if (enabled && missingGoalTools.length > 0) {
			pi.setActiveTools([...activeTools, ...missingGoalTools]);
		} else if (!enabled && hasGoalTool) {
			pi.setActiveTools(activeTools.filter((name) => !GOAL_TOOL_NAMES.includes(name)));
		}
	}

	function restoreState(ctx: ExtensionContext): void {
		state = { paused: false };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;

			const data = entry.data as Partial<GoalState> | undefined;
			if (typeof data?.goal === "string" && data.goal.trim()) {
				state = {
					goal: data.goal,
					paused: Boolean(data.paused),
					question: typeof data.question === "string" ? data.question : undefined,
				};
			} else {
				state = { paused: false };
			}
		}
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!hasGoal()) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}

		const goal = state.goal!;
		const view = state.paused
			? { status: "paused", label: "GOAL PAUSED", hint: "/goal resume", warn: true }
			: state.question !== undefined
				? { status: "waiting for you", label: "GOAL WAITING FOR YOUR ANSWER", hint: "reply to continue", warn: true }
				: interrupted
					? { status: "interrupted", label: "GOAL INTERRUPTED", hint: "send a message or /goal resume", warn: true }
					: waitingOn
						? {
								status: "waiting",
								label: `GOAL WAITING ON ${[...waitingOn].join(", ")}`,
								hint: "/goal resume to stop waiting",
								warn: false,
							}
						: { status: "active", label: "GOAL ACTIVE", hint: "/goal pause", warn: false };
		const color = view.warn ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(color, `goal: ${view.status}`));
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
			const label = theme.fg(color, theme.bold(view.label));
			const hint = theme.fg("dim", ` ${view.hint} \u00b7 /goal clear`);
			return new Text(`${label}${hint}\n${theme.bold(theme.fg("accent", goal))}`, 1, 0);
		});
	}

	function sendGoalPrompt(deliverAs?: "steer" | "followUp"): void {
		if (!hasGoal() || state.paused || state.question !== undefined || interrupted || waitingOn) return;

		pi.sendMessage(
			{
				customType: "persistent-goal-prompt",
				content: `Continue working autonomously toward the active goal: ${state.goal}`,
				display: false,
			},
			deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
		);
	}

	function setGoal(goal: string, ctx: ExtensionContext, startImmediately = true): void {
		state = { goal, paused: false };
		interrupted = false;
		clearWait();
		setGoalToolsEnabled(true);
		saveState();
		updateUI(ctx);
		ctx.ui.notify("Goal set. Pi will keep working until it is completed or paused.", "info");
		if (startImmediately) {
			sendGoalPrompt(ctx.isIdle() ? undefined : "steer");
		}
	}

	function clearGoal(ctx: ExtensionContext, message = "Goal cleared."): void {
		state = { paused: false };
		interrupted = false;
		clearWait();
		setGoalToolsEnabled(false);
		saveState();
		updateUI(ctx);
		ctx.ui.notify(message, "info");
	}

	function pauseGoal(ctx: ExtensionContext, message: string): void {
		state.paused = true;
		interrupted = false;
		clearWait();
		setGoalToolsEnabled(false);
		saveState();
		updateUI(ctx);
		ctx.ui.notify(message, "warning");
	}

	pi.registerTool({
		name: "goal_propose",
		label: "Propose Goal",
		description:
			"Propose a persistent goal when autonomous continuation would materially help. Pi asks the user to approve it; never assume approval.",
		parameters: Type.Object({
			goal: Type.String({ description: "A concise, concrete goal for the agent to complete autonomously" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (hasGoal()) {
				return {
					content: [{ type: "text", text: `A goal is already ${state.paused ? "paused" : "active"}: ${state.goal}` }],
					details: { approved: false, reason: "A goal is already set" },
				};
			}
			if (ctx.mode !== "tui") {
				throw new Error("goal_propose requires interactive mode so the user can explicitly approve it.");
			}

			const approved = await ctx.ui.confirm("Set persistent goal?", params.goal);
			if (!approved) {
				return {
					content: [{ type: "text", text: "The user declined the persistent goal." }],
					details: { approved: false },
				};
			}

			setGoal(params.goal, ctx, false);
			return {
				content: [{ type: "text", text: `The user approved the persistent goal: ${params.goal}` }],
				details: { approved: true, goal: params.goal },
			};
		},
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark the active persistent goal complete only after the requested outcome has been fully achieved and verified.",
		parameters: Type.Object({
			summary: Type.String({ description: "Brief summary of the verified completed outcome" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasGoal()) {
				throw new Error("There is no active goal to complete.");
			}

			const completedGoal = state.goal!;
			clearGoal(ctx, "Goal completed.");
			return {
				content: [{ type: "text", text: `Goal completed: ${completedGoal}\n${params.summary}` }],
				details: { goal: completedGoal, summary: params.summary },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "goal_pause",
		label: "Goal Pause",
		description:
			"Pause the active persistent goal only for a genuine blocker the user must resolve outside pi (credentials, access, payment) that cannot be resolved with available tools or a safe assumption. For questions or decisions, use goal_ask instead.",
		parameters: Type.Object({
			reason: Type.String({ description: "What is blocked, what is needed from the user, and why it cannot be resolved" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasGoal()) {
				throw new Error("There is no active goal to pause.");
			}

			const blockedGoal = state.goal!;
			pauseGoal(ctx, "Goal paused: the agent needs your input to continue.");
			return {
				content: [{ type: "text", text: `Goal paused because: ${params.reason}` }],
				details: { goal: blockedGoal, reason: params.reason },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "goal_ask",
		label: "Ask User",
		description:
			"Ask the user a question while working on the active persistent goal. Ends your turn and waits: the user's next message is their answer, then the goal loop continues automatically. Use for decisions, preferences, missing information, or confirmation before destructive/irreversible actions. Write it as plain text; for choices, list numbered options in the question, recommended first (e.g. 'Pick one: 1. ..., 2. ..., or 3. ...'). Call it alone, as your last action.",
		promptSnippet: "Ask the user a question during goal mode; their next message is the answer",
		parameters: Type.Object({
			question: Type.String({
				description:
					"Self-contained question with enough context to answer without reading the transcript. Include numbered options inline when there are choices.",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasGoal()) {
				throw new Error("There is no active goal. Ask the user directly in your reply instead.");
			}

			state.question = params.question;
			saveState();
			updateUI(ctx);
			return {
				content: [
					{
						type: "text",
						text: "Question shown to the user. Stop here; their next message is the answer.",
					},
				],
				details: { question: params.question },
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("warning", theme.bold("? "))}${theme.fg("text", String(args.question ?? ""))}`,
				0,
				0,
			);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("dim", "Waiting for your answer. Reply below to continue."), 0, 0);
		},
	});

	pi.registerTool({
		name: "goal_wait",
		label: "Wait for jobs and agents",
		description:
			"Hold the persistent goal loop until background jobs (started with bg_run) or background agents (started with agent_start and wait: false) finish, instead of idling, sleeping, or polling. Ends your turn; the next turn starts automatically when a waited job or agent finishes, with its result. Use only when nothing useful can be done until then. Call it alone, as your last action.",
		promptSnippet: "Wait for bg_run jobs and background agents during goal mode without burning turns",
		parameters: Type.Object({
			jobs: Type.Optional(
				Type.Array(Type.String(), { description: "bg_run job or agent names to wait for. Defaults to all running ones." }),
			),
			reason: Type.String({ description: "What you are waiting for and what you will do next" }),
			timeout_minutes: Type.Optional(
				Type.Number({
					description: `Wake up anyway after this many minutes to check on the jobs (default ${DEFAULT_WAIT_MINUTES})`,
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (!hasGoal()) throw new Error("There is no active goal.");

			const running = runningJobs();
			if (running === undefined) throw new Error("Neither bg-jobs nor pi-subagents is loaded; nothing to wait for.");
			const requested = params.jobs?.length ? params.jobs : running;
			const notRunning = requested.filter((name) => !running.includes(name));
			const targets = requested.filter((name) => running.includes(name));
			if (targets.length === 0) {
				throw new Error(
					`No matching background jobs or agents are running${notRunning.length ? ` (not running: ${notRunning.join(", ")})` : ""}. Their completion messages may already be in the conversation; continue working.`,
				);
			}

			clearWait();
			waitingOn = new Set(targets);
			const minutes = Math.max(1, params.timeout_minutes ?? DEFAULT_WAIT_MINUTES);
			waitTimer = setTimeout(() => {
				waitTimer = undefined;
				if (!waitingOn) return;
				const still = [...waitingOn];
				clearWait();
				if (latestCtx) updateUI(latestCtx);
				if (!hasGoal() || state.paused || !latestCtx?.isIdle()) return;
				pi.sendMessage(
					{
						customType: "persistent-goal-prompt",
						content: `goal_wait timed out after ${minutes} min; still running: ${still.join(", ")}. Check them with bg_logs or agent_list, then keep working toward the goal or call goal_wait again.`,
						display: false,
					},
					{ triggerTurn: true },
				);
			}, minutes * 60_000);
			waitTimer.unref?.();
			updateUI(ctx);

			return {
				content: [
					{
						type: "text",
						text: `Waiting on ${targets.join(", ")} (timeout ${minutes} min).${notRunning.length ? ` Not running, ignored: ${notRunning.join(", ")}.` : ""} Stop here; the next turn starts when a job finishes.`,
					},
				],
				details: { jobs: targets, reason: params.reason, timeoutMinutes: minutes },
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const jobs = Array.isArray(args.jobs) && args.jobs.length ? args.jobs.join(", ") : "everything running";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("goal_wait "))}${theme.fg("accent", jobs)}${args.reason ? theme.fg("muted", `: ${args.reason}`) : ""}`,
				0,
				0,
			);
		},
	});

	// bg-jobs and pi-subagents report a finished job or agent the same way.
	const onFinished = (data: unknown) => {
		const { name, triggersTurn } = (data ?? {}) as { name?: unknown; triggersTurn?: unknown };
		if (!waitingOn || typeof name !== "string" || !waitingOn.has(name)) return;
		// Any waited job or agent finishing ends the wait: its completion message starts the next
		// turn, and the agent can call goal_wait again for the rest.
		clearWait();
		const ctx = latestCtx;
		if (!ctx) return;
		updateUI(ctx);
		if (triggersTurn !== false) return;
		// Stopped by the user (/jobs kill, bg_kill, or in /agents): reported without starting a turn.
		setTimeout(() => {
			if (ctx.isIdle()) sendGoalPrompt();
		}, 0);
	};
	pi.events.on("bg-jobs:finished", onFinished);
	pi.events.on("pi-subagents:finished", onFinished);

	pi.registerCommand("goal", {
		description: "Set a persistent goal with /goal <goal>, or pause | resume | clear",
		getArgumentCompletions: (prefix) => {
			// Only complete the first word; anything longer is a goal being typed.
			if (/\s/.test(prefix) || !hasGoal()) return null;
			const held = state.paused || state.question !== undefined || interrupted || waitingOn !== undefined;
			const options = [
				!state.paused && { value: "pause", description: "Stop automatic continuation" },
				held && {
					value: "resume",
					description: state.paused ? "Resume automatic continuation" : "Continue now (skip the current wait)",
				},
				{ value: "clear", description: "Remove the goal" },
			].filter((o): o is { value: string; description: string } => Boolean(o));
			const lower = prefix.toLowerCase();
			const matches = options
				.filter((o) => o.value.startsWith(lower))
				.map((o) => ({ value: o.value, label: o.value, description: o.description }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();

			if (!input) {
				if (!hasGoal()) {
					ctx.ui.notify("No active goal. Usage: /goal <goal>", "info");
					return;
				}
				ctx.ui.notify(
					`Goal (${state.paused ? "paused" : "active"}): ${state.goal}\n/goal pause | resume | clear`,
					"info",
				);
				return;
			}

			const command = input.toLowerCase();
			if (command === "clear") {
				if (!hasGoal()) {
					ctx.ui.notify("No active goal to clear.", "info");
					return;
				}
				clearGoal(ctx);
				return;
			}

			if (command === "pause") {
				if (!hasGoal()) {
					ctx.ui.notify("No active goal to pause.", "warning");
					return;
				}
				pauseGoal(ctx, "Goal paused. The current turn may finish, but Pi will not continue automatically.");
				return;
			}

			if (command === "resume") {
				if (!hasGoal()) {
					ctx.ui.notify("No paused goal to resume.", "warning");
					return;
				}
				state.paused = false;
				state.question = undefined;
				interrupted = false;
				clearWait();
				setGoalToolsEnabled(true);
				saveState();
				updateUI(ctx);
				ctx.ui.notify("Goal resumed.", "info");
				sendGoalPrompt(ctx.isIdle() ? undefined : "steer");
				return;
			}

			setGoal(input, ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		const answered = answeredQuestion;
		answeredQuestion = undefined;
		if (!hasGoal() || state.paused) return;

		return {
			message: answered
				? {
						customType: "persistent-goal-answer",
						content: `The user's latest message answers your goal_ask question:\n${answered}`,
						display: false,
					}
				: undefined,
			systemPrompt: `${event.systemPrompt}\n\n## Persistent Goal\nActive goal: ${state.goal}\n\nWork autonomously and keep making safe, concrete progress toward this goal. Do not stop merely because a turn is complete. Use tools and verify your work. Only when the goal is fully achieved and verified, call the goal_complete tool with a brief summary. Do not call goal_complete for partial progress. When you need a decision, preference, missing information, or confirmation from the user (including before destructive or irreversible actions), call goal_ask with a self-contained plain-text question (for choices, list numbered options inline, recommended first) as your last action. It ends your turn, and the user's next message is the answer; then continue toward the goal. Do not ask questions in plain assistant text without goal_ask, because the goal loop will just prompt you to continue. Only if a genuine external blocker requires the user to act outside pi (e.g. log in, grant access, pay) call goal_pause with exactly what is blocked and what is needed. When you are blocked on background jobs (bg_run) or background agents (agent_start with wait: false) and nothing useful can be done until they finish, call goal_wait instead of sleeping, polling, or ending your turn; the next turn starts when one finishes. Do not ask or pause for ordinary uncertainty or work that you can investigate yourself.`,
		};
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!hasGoal() || state.paused || !BLOCKING_PROVIDER_STATUS_CODES.has(event.status)) return;

		pauseGoal(
			ctx,
			`Goal paused: the provider rejected the request (HTTP ${event.status}). Check credentials, billing, or model access, then use /goal resume.`,
		);
		ctx.abort();
	});

	pi.on("input", (event, ctx) => {
		if (!hasGoal() || state.paused) return;
		if (event.source === "extension" || event.text.trimStart().startsWith("/")) return;

		// A user message ends an interrupt: the run it starts settles back into the loop.
		interrupted = false;
		if (state.question !== undefined) {
			// The reply answers the pending goal_ask question.
			answeredQuestion = state.question;
			state.question = undefined;
			saveState();
		}
		updateUI(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!hasGoal() || state.paused) return;
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		// Esc during tool execution leaves a non-aborted assistant message; the run signal covers it.
		const aborted =
			ctx.signal?.aborted === true ||
			(lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted");
		if (aborted !== interrupted) {
			interrupted = aborted;
			updateUI(ctx);
		}
	});

	pi.on("agent_settled", () => {
		if (!hasGoal() || state.paused || interrupted) return;
		sendGoalPrompt("followUp");
	});

	/** /compact aborts the running turn; pick the loop back up once compaction is done. */
	function resumeAfterManualCompaction(ctx: ExtensionContext): void {
		if (!hasGoal() || state.paused || state.question !== undefined) return;
		interrupted = false;
		updateUI(ctx);
		// session_compact fires while compaction is still marked in progress; starting a run
		// from inside the handler would block compaction_end until the run finishes.
		setTimeout(() => {
			if (ctx.isIdle()) sendGoalPrompt();
		}, 0);
	}

	pi.on("session_compact", (event, ctx) => {
		if (event.reason === "manual") resumeAfterManualCompaction(ctx);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!hasGoal() || state.paused) return;

		if (event.reason === "manual") {
			// Cancelled by the user: stay interrupted. Otherwise (e.g. nothing to compact) carry on.
			if (!event.aborted) resumeAfterManualCompaction(ctx);
			return;
		}

		pauseGoal(
			ctx,
			event.aborted
				? "Goal paused: auto-compaction was cancelled. Use /goal resume to continue (or /compact first)."
				: `Goal paused: auto-compaction failed${event.errorMessage ? ` (${event.errorMessage})` : ""}. Free up context (e.g. /compact) and use /goal resume.`,
		);
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		clearWait();
		interrupted = false;
		answeredQuestion = undefined;
		restoreState(ctx);
		setGoalToolsEnabled(hasGoal() && !state.paused);
		updateUI(ctx);
	});

	pi.on("session_shutdown", () => {
		clearWait();
	});

	pi.on("session_tree", (_event, ctx) => {
		latestCtx = ctx;
		clearWait();
		interrupted = false;
		answeredQuestion = undefined;
		restoreState(ctx);
		setGoalToolsEnabled(hasGoal() && !state.paused);
		updateUI(ctx);
	});
}
