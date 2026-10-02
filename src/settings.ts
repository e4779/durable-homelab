import type { HarnessSettings } from "@earendil-works/pi-durable";

/** Homelab defaults; everything omitted falls back to Harness built-ins. */
export function harnessSettings(): HarnessSettings {
	return {
		compaction: {
			reserveTokens: 16384,
			backgroundTokens: 32768,
		},
	};
}
