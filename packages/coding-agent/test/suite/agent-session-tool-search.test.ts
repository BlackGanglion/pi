import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolExposure } from "../../src/core/extensions/types.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const target = "mcp__docs__read_page";
const other = "mcp__archive__read_page";

function registerTools(pi: ExtensionAPI): void {
	for (const server of ["archive", "docs"]) {
		const namespace = { name: `mcp__${server}`, aliases: [server] };
		for (const [name, description] of [
			["list_pages", "Read page history."],
			["read_page", "Read the full content of a page. ".repeat(30)],
		]) {
			pi.registerTool({
				name: `mcp__${server}__${name}`,
				label: name,
				description,
				parameters: Type.Object({}),
				namespace,
				exposure: name === "read_page" ? "deferred" : "codemode",
				execute: async () => {
					throw new Error("Discovery must not execute the discovered tools");
				},
			});
		}
	}
	// Neither metadata mentioning the alias nor a matching tool-name prefix grants membership.
	for (const exposure of ["deferred", "direct", "model-only", "hidden"] satisfies ToolExposure[]) {
		pi.registerTool({
			name: `mcp__docs__${exposure}_decoy`,
			label: "decoy",
			description: "docs read_page",
			parameters: Type.Object({}),
			namespace: exposure === "deferred" ? undefined : { name: "mcp__docs", aliases: ["docs"] },
			exposure,
			defaultActive: false,
			execute: async () => ({ content: [], details: {} }),
		});
	}
}

describe("AgentSession tool search namespace queries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["tool_search"],
			extensionFactories: [createToolSearchExtension(), registerTools],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it.each([
		["+docs read_page", 1, [target]],
		["+mcp__docs read_page", 1, [target]],
		[" \t+docs\n read_page  ", 1, [target]],
		["+docs read page", 1, [target]],
		["+docs read_page", 8, [target, "mcp__docs__list_pages"]],
		["+archive read_page", 1, [other]],
		["+missing read_page", 8, []],
		["+doc read_page", 8, []],
		["+DOCS read_page", 8, []],
		["+docs nonexistent", 8, []],
		["+docs", 1, ["mcp__docs__list_pages"]],
		["+missing", 8, []],
		["read_page", 2, [other, target]],
	] as const)("loads only matching tools for %s (limit %i)", async (query, limit, expected) => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query, limit })], { stopReason: "toolUse" }),
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["tool_search", ...expected]);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Discover tools");
		const result = getToolResult(harness, "tool_search");
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ loaded: expected });
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", ...expected]);
	});

	it("keeps active tools and excludes them from subsequent searches", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "+docs read_page", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "+docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Discover tools");
		expect(getToolResult(harness, "tool_search").details).toEqual({ loaded: ["mcp__docs__list_pages"] });
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", target, "mcp__docs__list_pages"]);
	});
});
