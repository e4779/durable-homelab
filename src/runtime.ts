import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	Harness,
	configure,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Submission,
	type TaskGraph,
	AgentDoc,
} from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModelRuntime, defaultModelRef } from "./model-runtime.ts";
import { harnessSettingsFor, configureHarnessHttp, createCodingRegistry, ExecutionEnvs } from "./harness-setup.ts";
import { selectSession } from "./sessions.ts";
import { Subagent } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	readonly title?: string;
	/** Newest entry id in the conversation — recency key for sorting. */
	readonly lastEntryId?: string;
	/** Working directory this conversation is bound to (Projects v2). */
	readonly cwd?: string;
}

/** Everything the web/TUI surface renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	readonly tasks?: TaskGraph;
	/** Registered project directories (Projects v2). */
	readonly projects?: readonly string[];
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the surface may ask for. */
export interface DurableController {
	submit(text: string, whenBusy: "steer" | "followUp", blocks?: readonly unknown[]): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	switchConversation(id: ConversationId): Promise<void>;
	createConversation(cwd?: string): Promise<void>;
	/** Register a new project directory (must exist). */
	addProject(path: string): Promise<void>;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	close(): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string; lastEntryId?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, context))!;
	let first: EntryRecord | undefined;
	let last: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
		last = page.items.at(-1) ?? last;
		cursor = page.next;
	} while (cursor !== undefined);
	return { ...titleOf(first), ...(last ? { lastEntryId: String(last.id) } : {}) };
}

function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false);
	const envs = new ExecutionEnvs(location.cwd);

	// Projects v2: registered project directories + per-conversation cwd map
	const projectsFile = join(location.cwd, ".projects.json");
	let projects: string[] = [location.cwd];
	const loadProjects = (): void => {
		try {
			const parsed = JSON.parse(readFileSync(projectsFile, "utf8"));
			if (Array.isArray(parsed?.projects)) projects = [location.cwd, ...parsed.projects.filter((p: unknown) => typeof p === "string" && p !== location.cwd)];
		} catch { /* first run */ }
	};
	const saveProjects = (): void => {
		try {
			writeFileSync(projectsFile, JSON.stringify({ projects: projects.filter((p) => p !== location.cwd) }, null, 2));
		} catch { /* best effort */ }
	};
	loadProjects();
	let harness: Harness | undefined;
	try {
		const modelRuntime = createModelRuntime();
		configureHarnessHttp();
		const settings = harnessSettingsFor();
		const registry = createCodingRegistry(location.cwd);
		registry.install(Subagent);

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: modelRuntime,
				registry,
				settings,
				env: envs.env,
				onReport: (error) => report(error),
			},
			context,
		);
		const initial = location.created ? { model: await defaultModelRef(modelRuntime) } : undefined;
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
			},
		});
		const label = (rec: { id: ConversationId; owner?: { readonly taskId: unknown } }): string =>
		rec.id === root.id ? "main" : rec.owner !== undefined ? `subagent ${rec.id}` : `session ${rec.id}`;
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const rec of page.items) {
				const agentDoc = await opened.snapshot(AgentDoc, rec.id, context).catch(() => undefined);
				summaries.push({ id: rec.id, label: label(rec), cwd: agentDoc?.cwd ?? location.cwd, ...(await firstInput(opened, rec.id)) });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
		const switchTo = async (id: ConversationId): Promise<void> => {
			const next = await opened.conversation(id, context);
			if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
			const nextState = await next.viewState(context);
			unsubscribe();
			conversation.dispose();
			current = next;
			conversation = nextState;
			unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
		};

		const snapshot = (): any[] => (modelRuntime as any).getAvailableSnapshot?.() ?? (modelRuntime as any).getModels?.() ?? [];
		const models = (): ModelSummary[] =>
			snapshot().map((model: any) => ({
				provider: model.provider,
				modelId: model.id ?? model.modelId,
				name: model.name ?? model.id ?? model.modelId,
				contextWindow: model.contextWindow ?? 0,
			}));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		let unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
		const unsubscribeCommits = harness.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value) }];
				} else if (change.type === "entry" && change.value.kind === "pi.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		let queue = Promise.resolve();
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : (modelRuntime as any).getModel(ref.provider, ref.modelId);
			if (model === undefined)
				throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		const controller: DurableController = {
			submit: (text, whenBusy, blocks) =>
				command(async () => {
					const content = blocks && blocks.length > 0 ? [{ type: "text", text }, ...blocks] : text;
					watchAnswer(await current.submit({ type: "input", content, whenBusy }, context));
				}),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
								);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else
							notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = (modelRuntime as any).getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}),
			createConversation: (cwd) =>
				command(async () => {
					let createdId: ConversationId | undefined;
					const target = cwd ?? location.cwd;
					await opened.commit(async (tx) => {
						const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
						createdId = record.id;
						const model = await defaultModelRef(modelRuntime);
						await configure(tx, record.id, {
							cwd: target,
							...(model === undefined ? {} : { model }),
						}, context);
					}, context);
					if (!projects.includes(target)) {
						projects.push(target);
						saveProjects();
						update({ projects: [...projects] });
					}
					if (createdId === undefined) throw new Error("Conversation was not created");
					const next = await opened.conversation(createdId, context);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
				}),

			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
					update({ projects: [...projects] });
				}),
			addProject: (path) =>
				command(async () => {
					const clean = path.replace(/\/+$/, "");
					if (!existsSync(clean)) throw new Error(`Directory does not exist: ${clean}`);
					if (!projects.includes(clean)) {
						projects.push(clean);
						saveProjects();
						update({ projects: [...projects] });
					}
				}),
			switchConversation: (id) =>
				command(async () => {
					await switchTo(id);
					try {
						writeFileSync(join(location.cwd, ".durable-current"), String(id));
					} catch { /* persistence is best-effort */ }
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; using the default.");
		else if ((modelRuntime as any).getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		// restore the conversation that was active before the last restart
		try {
			const savedId = Number(readFileSync(join(location.cwd, ".durable-current"), "utf8").trim());
			if (Number.isFinite(savedId) && savedId !== root.id && summaries.some((c) => c.id === savedId)) {
				await switchTo(savedId);
			}
		} catch { /* no saved selection — stay on root */ }
		await controller.toggleTasks();
		harness.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			close() {
				closing ??= (async () => {
					unsubscribe();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						await opened.close(context);
						await envs.cleanup(context);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}
