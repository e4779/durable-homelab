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
} from "@earendil-works/pi-durable";
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
}

/** Everything the web/TUI surface renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the surface may ask for. */
export interface DurableController {
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	switchConversation(id: ConversationId): Promise<void>;
	createConversation(): Promise<void>;
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

async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, context))!;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
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
		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
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
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
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
			submit: (text, whenBusy) =>
				command(async () => watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context))),
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
			createConversation: () =>
				command(async () => {
					let createdId: ConversationId | undefined;
					await opened.commit(async (tx) => {
						const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
						createdId = record.id;
						const model = await defaultModelRef(modelRuntime);
						await configure(tx, record.id, {
							cwd: location.cwd,
							...(model === undefined ? {} : { model }),
						}, context);
					}, context);
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
				}),
			switchConversation: (id) =>
				command(async () => {
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; using the default.");
		else if ((modelRuntime as any).getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
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
