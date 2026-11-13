import type { Context } from '@deepseek-ai/cordis';
import type { Source } from './detect.js';
/** Profile row id of the executor plugin this panel configures. */
export declare const ENTRY_ID = "dsh-vsshell";
/** URL path of the panel's JSON endpoint. */
export declare const PANEL_PATH = "/dsh-vsshell-panel";
/** The six fields the panel owns (budgets stay in the profile/row as-is). */
export interface PanelConfig {
    source: Source;
    bashPath: string;
    wslDistro: string;
    loginShell: boolean;
    verify: boolean;
    probeTimeoutMs: number;
}
/** Live executor facts shown at the top of the panel. */
export interface PanelShell {
    status: 'ready' | 'pending' | 'failed' | 'unavailable';
    exe?: string;
    family?: string;
    label?: string;
    source?: string;
    detail?: string;
}
/** One GET/POST response body. */
export interface PanelState {
    config: PanelConfig;
    hasProfileOverride: boolean;
    warnings: string[];
    sources: readonly string[];
    shell: PanelShell;
}
/** Services this host plugin needs. */
export declare const inject: string[];
/**
 * Strip one pair of matching YAML/JS quotes from a scalar, tolerating values
 * copied straight out of `cordis.patch.yml` (single quotes, double quotes, or
 * no quotes at all).
 * @param value - raw field value.
 * @returns the unquoted text; empty string for null/undefined.
 */
export declare function unquoteScalar(value: unknown): string;
/** The raw panel fields of one effective row config (lenient, never throws). */
export declare function readPanelConfig(raw: unknown): PanelConfig;
/**
 * Normalize and validate one panel submission.
 * @param raw - request JSON (already parsed).
 * @returns the normalized config to persist.
 * @throws Error with a user-facing Chinese message when a field is invalid.
 */
export declare function validatePanelConfig(raw: unknown): PanelConfig;
/** The panel's host plugin: one JSON route over the profile config editor. */
export declare function apply(ctx: Context): void;
